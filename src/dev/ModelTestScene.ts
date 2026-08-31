import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SunRig } from '../render/lighting/SunRig';
import { SkyDome } from '../world/sky/SkyDome';
import { createGouacheMaterial, type GouacheMaterial } from '../render/shading/GouacheMaterial';
import { globalUniforms } from '../render/shading/ShadingUniforms';
import { SKY } from '../art/palette';
import type { TimeOfDayName } from '../art/timeOfDay';
import { ModelStage, visibleBox } from './ModelStage';

/**
 * AN EMPTY TEST SPACE - sky, sun, one ground plane, and the model.
 *
 * Deliberately NOT the world scene. Nothing is baked here: no island field, no bathymetry,
 * no shore atlas, no vegetation placement. Those cost seconds of CPU on every reload and
 * answer questions about terrain, which is not what you are looking at when you are looking
 * at a model. The bench reloads instantly and stays that way.
 *
 * What IS kept is everything that decides how a model looks, because an asset reviewed under
 * generic studio lighting tells you nothing about whether it belongs in this world:
 *
 *   - the same sky dome running the same `sky_gradient.glsl`, so the backdrop colour and the
 *     haze the model fades into are the real ones
 *   - the same single directional sun rig with hard shadows (04 section 1)
 *   - the same gouache shading chunk, selectable per surface preset (04 section 2.3)
 *   - the same post chain on top (04 section 7.1)
 *
 * The ground is one plane wearing a surface preset, not an ocean: flat, free, and enough to
 * catch a cast shadow and give the eye a horizon. `sea` and `land` differ only in which row
 * of art/surfaces.ts they read.
 */

export type EnvironmentName = 'sea' | 'land' | 'void';

export const ENVIRONMENT_NAMES: ReadonlyArray<EnvironmentName> = Object.freeze(['sea', 'land', 'void']);

/** Where the model sits. The origin; there is nothing else here to avoid. */
const STAGE_POINT = new THREE.Vector3(0, 0, 0);

/** Ground plane half-extent. Past the haze's reach, so it resolves into the horizon. */
const GROUND_EXTENT = 12000;

export type ModelViewName =
  | 'threequarter'
  | 'front'
  | 'side'
  | 'top'
  | 'silhouette'
  | 'near'
  | 'range200'
  | 'range800'
  | 'range1500'
  | 'free';

export const MODEL_VIEW_NAMES: ReadonlyArray<ModelViewName> = Object.freeze([
  'threequarter', 'front', 'side', 'top', 'silhouette',
  'near', 'range200', 'range800', 'range1500', 'free',
]);

interface ViewSpec {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export class ModelTestScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: SunRig;
  readonly sky: SkyDome;
  readonly stage: ModelStage;
  readonly devOverlay = new THREE.Scene();
  readonly controls: OrbitControls;
  /** Ambient fill, for `shading: original` only. See the constructor for why it is safe. */
  readonly fill: THREE.AmbientLight;

  private readonly ground: THREE.Mesh;
  private readonly seaMaterial: GouacheMaterial;
  private readonly landMaterial: GouacheMaterial;
  private readonly grid: THREE.GridHelper;
  private readonly axes: THREE.AxesHelper;
  private readonly rod: THREE.Group;
  private readonly boundsBox = new THREE.Box3Helper(new THREE.Box3(), 0xffb703);
  private environment: EnvironmentName = 'sea';
  private view: ModelViewName = 'threequarter';
  private time = 0;
  /** The time-of-day preset's own sun intensity, before the original-mode exposure scale. */
  private presetSunIntensity = 1;
  private originalExposure = 0.35;

  constructor(canvas: HTMLCanvasElement) {
    // Near plane at 0.1 rather than the world scene's 0.5: a bench framing on a 3 m prop
    // puts the camera a few metres out, and 0.5 clips it.
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 25000);

    this.sky = new SkyDome(this.scene, 10000);
    // A much tighter shadow frustum than the world's, kept centred on the model by `update`.
    // 04 section 3.2 blames frustum width for both acne and peter-panning, and a bench
    // reviewing one 10 m asset can afford the tightest frustum in the project.
    this.sun = new SunRig(this.scene, { shadowExtent: 90, shadowMapSize: 2048, distance: 400 });

    this.seaMaterial = createGouacheMaterial({ surface: 'openSea' });
    this.landMaterial = createGouacheMaterial({ surface: 'limestone' });
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_EXTENT * 2, GROUND_EXTENT * 2),
      this.seaMaterial,
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.stage = new ModelStage(this.scene, { stagePoint: STAGE_POINT.clone(), targetSize: 12 });

    // A fill light, which the world scene deliberately does not have (see SunRig's header)
    // and which is nonetheless right here.
    //
    // It cannot leak into the art direction. GouacheMaterial overwrites `outgoingLight`
    // wholesale (04 section 2.2), so every three.js light contribution is discarded before it
    // reaches the frame - the ground plane included. The only thing in this scene that reads
    // it is a loaded model still wearing its own PBR materials, which under 04 section 1's
    // single directional light renders every unlit face pure black and reads as a broken
    // import rather than as the absence of a fill. Cyan rather than grey, because 00
    // section 3 rule 2 says shadow is hue-shifted, never desaturated.
    this.fill = new THREE.AmbientLight(SKY.cloudShadow.hex, 0.55);
    this.scene.add(this.fill);
    this.setTimeOfDay('lateMorning');

    // --- dev overlay: the measuring tools, counted separately from world content --------
    this.grid = new THREE.GridHelper(200, 20, 0x9bb5a8, 0x3d5a52);
    this.axes = new THREE.AxesHelper(8);
    this.rod = buildScaleRod();
    this.boundsBox.visible = false;
    this.devOverlay.add(this.grid, this.axes, this.rod, this.boundsBox);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 6000;
    this.controls.minDistance = 0.2;
    // Below the horizon the camera ends up under the ground plane looking at its backface,
    // which reads as a rendering bug rather than as a camera that went somewhere silly.
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.setView('threequarter');
  }

  get viewName(): ModelViewName {
    return this.view;
  }

  get environmentName(): EnvironmentName {
    return this.environment;
  }

  /**
   * Apply a time-of-day preset, then re-scale the lighting for `original` mode.
   *
   * Both halves have to happen together. `SunRig.apply` sets the light's intensity from the
   * preset, so anything the bench does to that intensity is undone the next time the sun
   * moves — which is why this exists instead of a bare `sun.apply` call at each site.
   */
  setTimeOfDay(name: TimeOfDayName): void {
    this.sun.apply(name);
    this.presetSunIntensity = this.sun.light.intensity;
    this.applyOriginalExposure();
  }

  /**
   * Exposure for a model still wearing its own PBR materials. Nothing else can see it.
   *
   * 04 §1's rig runs the sun at intensity 2.0, which is correct: the gouache chunk discards
   * three's lighting entirely (04 §2.2) and reads only the sun's DIRECTION, so the number is
   * free. An imported Phong or Standard material does read it, and a white albedo under a
   * 2.0 sun plus an ambient fill lands somewhere near 2.5 on a screen with no tone mapping
   * to roll it off (00 §5) — pure white, then bloom on top, then the asset vanishes inside a
   * glowing ball. That is what "0.35" is fixing, and it is a viewing aid for imported
   * materials only: the ground plane, sky and every gouache preset are untouched by it.
   */
  setOriginalExposure(k: number): void {
    this.originalExposure = k;
    this.applyOriginalExposure();
  }

  get exposure(): number {
    return this.originalExposure;
  }

  private applyOriginalExposure(): void {
    this.sun.light.intensity = this.presetSunIntensity * this.originalExposure;
    // Two-thirds key, one-third fill, so an unlit face reads as shadow rather than as a hole.
    this.fill.intensity = 0.9 * this.originalExposure;
  }

  setEnvironment(name: EnvironmentName): void {
    this.environment = name;
    this.ground.visible = name !== 'void';
    this.ground.material = name === 'land' ? this.landMaterial : this.seaMaterial;
  }

  /**
   * The framings, all derived from the model's own measured size.
   *
   * `near`, `threequarter`, `front`, `side` and `top` are the asset-review angles. The three
   * `range*` views are something else and are the more important half: they put the camera
   * at 200 m, 800 m and 1500 m - 00 section 3 rule 9's stated camera envelope - so the
   * question "does this thing still read at the distance the game will actually show it
   * from" gets answered before the asset is signed off rather than after.
   *
   * `silhouette` puts the sun behind the model. Backlit is where a shape either holds or
   * turns to mush, and it is the framing the art bible's rim-light budget exists for.
   */
  private viewSpec(name: ModelViewName): ViewSpec {
    const centre = this.stage.centre();
    const r = Math.max(this.stage.radius, 1);
    const sun = globalUniforms.uSunDirection.value;

    switch (name) {
      case 'near':
        return { position: centre.clone().add(new THREE.Vector3(r * 1.4, r * 0.5, r * 1.9)), target: centre };
      case 'threequarter':
        return { position: centre.clone().add(new THREE.Vector3(r * 2.2, r * 1.5, r * 3.0)), target: centre };
      case 'front':
        return { position: centre.clone().add(new THREE.Vector3(0, r * 0.15, r * 3.4)), target: centre };
      case 'side':
        return { position: centre.clone().add(new THREE.Vector3(r * 3.4, r * 0.15, 0)), target: centre };
      case 'top':
        return { position: centre.clone().add(new THREE.Vector3(0, r * 3.6, r * 0.01)), target: centre };
      case 'silhouette': {
        // Looking INTO the sun, from just below its elevation, so the model is rimmed and the
        // ground behind it is in its glare - the hardest test a silhouette gets.
        const away = new THREE.Vector3(sun.x, Math.max(sun.y * 0.35, 0.08), sun.z).normalize();
        return { position: centre.clone().addScaledVector(away, r * 3.2), target: centre };
      }
      case 'range200':
      case 'range800':
      case 'range1500': {
        const metres = name === 'range200' ? 200 : name === 'range800' ? 800 : 1500;
        // Off to one side and above, the way a chase camera sits. Altitude tracks range
        // rather than staying pinned at the model's own height.
        const dir = new THREE.Vector3(0.55, 0.28, 0.79).normalize();
        return { position: centre.clone().addScaledVector(dir, metres), target: centre };
      }
      case 'free':
        return { position: this.camera.position.clone(), target: centre };
    }
  }

  setView(view: ModelViewName): void {
    this.view = view;
    if (view === 'free') {
      // The free camera owns the pose from here; just stop fighting it for the mouse.
      this.controls.enabled = false;
      this.update(0);
      return;
    }
    const spec = this.viewSpec(view);
    this.controls.enabled = true;
    this.camera.position.copy(spec.position);
    this.controls.target.copy(spec.target);
    this.camera.lookAt(spec.target);
    this.controls.update();
    this.camera.updateMatrixWorld(true);
    this.update(0);
  }

  /** Re-apply the current framing. Called after a load, since every view sizes off the model. */
  reframe(): void {
    if (this.view !== 'free') this.setView(this.view);
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v;
    this.axes.visible = v;
  }

  setRodVisible(v: boolean): void {
    this.rod.visible = v;
  }

  setBoundsVisible(v: boolean): void {
    this.boundsBox.visible = v;
  }

  /** Only affects a model in `original` shading; every other material here ignores it. */
  setFillVisible(v: boolean): void {
    this.fill.visible = v;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** `dt` of 0 refreshes positions without advancing the clock. */
  update(dt: number): void {
    this.time += dt;
    globalUniforms.uTime.value = this.time;

    this.stage.update(dt);
    if (this.controls.enabled) this.controls.update();
    this.camera.updateMatrixWorld(true);

    this.sky.update(this.camera);

    // Keep the tight shadow frustum on the model rather than on the origin - at altitude the
    // model would otherwise leave it and simply stop casting.
    this.sun.followTarget(this.stage.centre());

    // The measuring tools follow the model's base, so they stay useful when it is in the air.
    const base = this.stage.position;
    this.grid.position.set(STAGE_POINT.x, base.y, STAGE_POINT.z);
    this.axes.position.copy(this.grid.position);
    this.rod.position.set(STAGE_POINT.x + this.stage.radius + 4, base.y, STAGE_POINT.z);
    if (this.boundsBox.visible && this.stage.model) {
      // Visible-only, to match what the fit measured — a box drawn around switched-off
      // furniture would contradict the size in the report panel.
      visibleBox(this.stage.model, this.boundsBox.box);
    }
  }

  dispose(): void {
    this.controls.dispose();
    this.stage.dispose();
    this.ground.geometry.dispose();
    this.seaMaterial.dispose();
    this.landMaterial.dispose();
  }
}

/**
 * A 10 m rod in 1 m bands, with the 1.8 m mark called out.
 *
 * Scale is the most common thing wrong with an imported asset and the hardest to see: a
 * plane alone in frame looks like a plane at any size. Next to a rod whose bands are one
 * metre each, a 4 m wingspan is instantly, obviously wrong.
 */
function buildScaleRod(): THREE.Group {
  const group = new THREE.Group();
  const light = new THREE.MeshBasicMaterial({ color: 0xebedea });
  const dark = new THREE.MeshBasicMaterial({ color: 0x1b2b33 });
  const geometry = new THREE.BoxGeometry(0.35, 1, 0.35);

  for (let i = 0; i < 10; i++) {
    const band = new THREE.Mesh(geometry, i % 2 === 0 ? light : dark);
    band.position.y = i + 0.5;
    group.add(band);
  }

  // Human height, the reference everyone actually has an intuition for.
  const mark = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.06, 0.06),
    new THREE.MeshBasicMaterial({ color: 0xc63427 }),
  );
  mark.position.set(0.4, 1.8, 0);
  group.add(mark);

  return group;
}
