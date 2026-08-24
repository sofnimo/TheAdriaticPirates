import * as THREE from 'three';
import { SURFACES, SURFACE_NAMES, type SurfaceName } from '../art/surfaces';
import { createGouacheMaterial, type GouacheMaterial } from '../render/shading/GouacheMaterial';
import { SunRig } from '../render/lighting/SunRig';
import { SkyDome } from '../world/sky/SkyDome';

/**
 * STEP 1 VALIDATION SCENE.
 *
 * Six spheres, one per surface preset in 04 §2.3, over a shadow-receiving ground plane,
 * plus a row of receding pillars for the aerial-perspective check. Nothing here is world
 * content — this exists purely so the ramp can be proved before anything consumes it.
 */

export const SPHERE_RADIUS = 3;
const SPHERE_SPACING = 8.5;
const SPHERE_HEIGHT = 4;
const GROUND_SIZE = 30000;

const PILLAR_ROW_X = 200;
const PILLAR_DISTANCES = [80, 200, 400, 800, 1400, 2200, 3200, 4500];

export type ViewName = 'ramp' | 'haze';

export interface TestSphere {
  name: SurfaceName;
  mesh: THREE.Mesh;
  material: GouacheMaterial;
  center: THREE.Vector3;
}

export class RampTestScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: SunRig;
  readonly sky: SkyDome;
  readonly spheres: TestSphere[] = [];
  readonly ground: THREE.Mesh;
  readonly groundMaterial: GouacheMaterial;

  /** Debug helpers live in their own scene so their draw calls stay off the world count. */
  readonly devOverlay = new THREE.Scene();
  private readonly shadowHelper: THREE.CameraHelper;

  private view: ViewName = 'ramp';

  constructor() {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 25000);

    this.sky = new SkyDome(this.scene, 10000);
    this.sun = new SunRig(this.scene, { shadowExtent: 40, shadowMapSize: 2048, distance: 200 });

    // --- ground: shadow receiver, and the surface that recedes to the horizon ---
    this.groundMaterial = createGouacheMaterial({ surface: 'limestone' });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), this.groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.name = 'Ground';
    this.scene.add(this.ground);

    // --- one sphere per surface preset ---
    const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 48);
    SURFACE_NAMES.forEach((name, i) => {
      const material = createGouacheMaterial({ surface: name });
      const mesh = new THREE.Mesh(geometry, material);
      const center = new THREE.Vector3((i - (SURFACE_NAMES.length - 1) / 2) * SPHERE_SPACING, SPHERE_HEIGHT, 0);
      mesh.position.copy(center);
      mesh.castShadow = true;
      // receiveShadow deliberately OFF: self-shadowing acne would speckle the very bands
      // the probe measures. The ground proves shadow reception (04 §8.3 checklist).
      mesh.receiveShadow = false;
      mesh.name = 'Sphere:' + name;
      this.scene.add(mesh);
      this.spheres.push({ name, mesh, material, center });
    });

    // --- receding pillars for the haze check ---
    const pillarGeo = new THREE.BoxGeometry(12, 40, 12);
    for (const distance of PILLAR_DISTANCES) {
      const material = createGouacheMaterial({ surface: 'forest' });
      const pillar = new THREE.Mesh(pillarGeo, material);
      pillar.position.set(PILLAR_ROW_X, 20, -distance);
      pillar.castShadow = false;
      pillar.name = 'Pillar:' + distance;
      this.scene.add(pillar);
    }

    this.shadowHelper = new THREE.CameraHelper(this.sun.light.shadow.camera);
    this.shadowHelper.visible = false;
    this.devOverlay.add(this.shadowHelper);

    this.setView('ramp');
  }

  get viewName(): ViewName {
    return this.view;
  }

  setView(view: ViewName): void {
    this.view = view;
    if (view === 'ramp') {
      this.camera.position.set(0, 6, 52);
      this.camera.lookAt(0, SPHERE_HEIGHT, 0);
    } else {
      this.camera.position.set(PILLAR_ROW_X, 60, 60);
      this.camera.lookAt(PILLAR_ROW_X, 20, -1200);
    }
    this.camera.updateMatrixWorld(true);
  }

  setHelpersVisible(visible: boolean): void {
    this.shadowHelper.visible = visible;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(): void {
    this.sky.update(this.camera);
    this.shadowHelper.update();
  }

  /** Predicted shadow-band colour for a surface, straight from the chunk's own maths. */
  static predictShadowBand(name: SurfaceName, out = new THREE.Color()): THREE.Color {
    const preset = SURFACES[name];
    const base = new THREE.Color(preset.baseColor);
    const tint = new THREE.Color(preset.shadowTint);
    // mix( baseColor * 0.82, uShadowTint, uShadowTintMix ), in linear working space —
    // the same space the shader does it in.
    out.setRGB(
      THREE.MathUtils.lerp(base.r * 0.82, tint.r, preset.shadowTintMix),
      THREE.MathUtils.lerp(base.g * 0.82, tint.g, preset.shadowTintMix),
      THREE.MathUtils.lerp(base.b * 0.82, tint.b, preset.shadowTintMix),
      THREE.LinearSRGBColorSpace,
    );
    return out;
  }
}
