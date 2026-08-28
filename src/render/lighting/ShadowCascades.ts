import * as THREE from 'three';
import { LIGHT } from '../../art/budgets';
import { shadowUniforms, type ShadowUniforms } from '../shading/ShadingUniforms';

/**
 * CASCADED SHADOW MAPS — `04 — Light and Shadow.md` §3.1.
 *
 * One shadow frustum cannot serve this camera. §3.1 states the problem exactly: at 200-1500 m
 * altitude a single `DirectionalLight` shadow map must cover the whole visible ground plane,
 * which either blows the resolution budget or shimmers. The fix is 2-4 depth slices, each with
 * its own tightly fitted shadow camera, so the near slice gets texel density and the far one
 * gets area. §8.2 fixes the numbers: 3 cascades, 1024 per cascade.
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN `three/addons/csm`. The doc recommends the addon, and for
 * a scene made of `MeshStandardMaterial` it would be the right call. This world is not that:
 * the sea, the terrain, the long-grass overlay and the canopy are all custom `ShaderMaterial`s,
 * because 02 and 05 need them to be. `CSM` works by splicing its own GLSL into the material
 * library's lighting chunks, which those materials never include — it would light the props and
 * leave every surface in the game unshadowed. What the art direction actually requires is one
 * shared chunk every surface calls (00 §5, 04 §2.2), so the cascades are fitted here and
 * sampled in `csm_shadow.glsl`, which terrain, overlay, canopy, water and the gouache material
 * all include. The addon's real content — the split scheme, the sphere fit, the texel snap — is
 * reproduced below rather than reimplemented differently.
 *
 * The lights exist ONLY to make three render depth maps. Their intensity is zero: every surface
 * in this world overwrites `outgoingLight` from the gouache chunk, so a light that actually lit
 * anything would be contributing to a term nothing reads, and four of them would quietly change
 * `NUM_DIR_LIGHT_SHADOWS` under the props' feet.
 */

export interface ShadowCascadeOptions {
  /** §8.2: 3. Four only if the draw distance grows past ~6 km. */
  readonly cascades?: number;
  /** §8.2: 1024 per cascade. Hardness comes from bias and radius, not from resolution. */
  readonly mapSize?: number;
  /** Metres of camera range the cascades cover. Past this, surfaces are simply lit. */
  readonly maxDistance?: number;
  /** 0 = uniform splits, 1 = logarithmic. §3.1's "practical" scheme is the blend. */
  readonly lambda?: number;
}

/** Metres the shadow camera is pulled back along the sun direction past the slice sphere. */
const LIGHT_MARGIN = 800;

export class ShadowCascades {
  readonly lights: THREE.DirectionalLight[] = [];
  readonly count: number;
  readonly mapSize: number;
  readonly maxDistance: number;

  private readonly lambda: number;
  private readonly targets: THREE.Object3D[] = [];
  /** World metres covered by one shadow texel, per cascade. Drives the normal bias. */
  private readonly texelWorld: number[] = [];

  /** Sampled by `csm_shadow.glsl`. The shared block, filled in place — see ShadingUniforms. */
  readonly uniforms: ShadowUniforms = shadowUniforms;

  private readonly placeholder: THREE.DepthTexture;

  constructor(scene: THREE.Scene, options: ShadowCascadeOptions = {}) {
    this.count = Math.max(1, Math.min(4, options.cascades ?? LIGHT.csmCascades));
    this.mapSize = options.mapSize ?? LIGHT.csmShadowMapSize;
    this.maxDistance = options.maxDistance ?? 4000;
    this.lambda = options.lambda ?? 0.55;

    // Stands in until three has actually rendered a cascade. A sampler bound to nothing is
    // undefined behaviour across drivers, and the first frame is exactly when the scene is
    // being screenshotted by the gates.
    this.placeholder = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.placeholder.format = THREE.DepthFormat;
    this.placeholder.compareFunction = THREE.LessEqualCompare;

    for (let i = 0; i < this.count; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 0);
      light.castShadow = true;

      const shadow = light.shadow;
      shadow.mapSize.set(this.mapSize, this.mapSize);
      // §3.2: hard edges. The radius is the PCF disc, and the style wants no penumbra at all —
      // what little softening survives is the hardware's 2x2 comparison, which the gouache
      // ramp then cuts to binary with its own `step(0.5, ...)`.
      shadow.radius = LIGHT.shadowRadiusRange[0];
      shadow.bias = LIGHT.shadowBiasRange[0];
      shadow.autoUpdate = true;

      const target = new THREE.Object3D();
      scene.add(target);
      light.target = target;
      scene.add(light);

      this.lights.push(light);
      this.targets.push(target);
      this.texelWorld.push(1);
    }

    const u = this.uniforms;
    u.uCsmEnabled!.value = 1;
    u.uCsmCount!.value = this.count;
    u.uCsmMapSize!.value = this.mapSize;
    u.uCsmBias!.value = LIGHT.shadowBiasRange[0];
    for (let i = 0; i < 4; i++) {
      u['uCsmMap' + i]!.value = this.placeholder;
      // Assigned BY REFERENCE: three rewrites `shadow.matrix` in place during the shadow pass,
      // which runs before the colour pass inside the same `renderer.render()`. Holding the
      // object rather than a copy means the matrix a fragment samples with is always the one
      // its depth map was rendered with, with no ordering rule for anyone to get wrong.
      u['uCsmMatrix' + i]!.value = this.lights[Math.min(i, this.count - 1)]!.shadow.matrix;
    }
  }

  /** 04 §1's overcast preset turns cast shadow off entirely; so does the debug UI. */
  setEnabled(on: boolean): void {
    this.uniforms.uCsmEnabled!.value = on ? 1 : 0;
    for (const light of this.lights) light.castShadow = on;
  }

  get enabled(): boolean {
    return this.uniforms.uCsmEnabled!.value === 1;
  }

  /**
   * Refit every cascade to the current camera. Call once per frame, before rendering.
   *
   * @param sunDir unit vector from the surface TOWARD the sun — the same one the shading
   *               terminator uses, so the cast shadow and the lit side can never disagree.
   */
  update(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3): void {
    if (!this.enabled) return;

    const near = camera.near;
    const far = Math.min(this.maxDistance, camera.far);
    const forward = _forward.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

    for (let i = 0; i < this.count; i++) {
      const sliceNear = this.splitAt(i, near, far);
      const sliceFar = this.splitAt(i + 1, near, far);
      this.fit(this.lights[i]!, this.targets[i]!, i, camera, forward, sunDir, sliceNear, sliceFar);
    }

    // The maps do not exist until three has rendered them once.
    for (let i = 0; i < 4; i++) {
      const map = this.lights[Math.min(i, this.count - 1)]!.shadow.map;
      this.uniforms['uCsmMap' + i]!.value = map ? map.depthTexture : this.placeholder;
    }
    const texel = this.uniforms.uCsmTexel!.value as THREE.Vector4;
    texel.set(
      this.texelWorld[0] ?? 1,
      this.texelWorld[1] ?? this.texelWorld[0] ?? 1,
      this.texelWorld[2] ?? this.texelWorld[0] ?? 1,
      this.texelWorld[3] ?? this.texelWorld[0] ?? 1,
    );
  }

  /**
   * §3.1's "practical" split: the log scheme puts almost everything in the first cascade and
   * the uniform one starves it, so the shipping answer is a blend of the two.
   */
  private splitAt(i: number, near: number, far: number): number {
    const t = i / this.count;
    const log = near * Math.pow(far / near, t);
    const uniform = near + (far - near) * t;
    return this.lambda * log + (1 - this.lambda) * uniform;
  }

  /**
   * Fit one cascade to one frustum slice.
   *
   * THE FIT IS A SPHERE, NOT A BOX, AND THAT IS THE ANTI-SHIMMER FIX. A box fitted to the eight
   * corners of the slice changes SIZE as the camera turns, so every frame re-scales the shadow
   * texel grid and the edges crawl — §3.2's "shimmer/swimming when camera moves". The bounding
   * sphere of a frustum slice depends only on the slice's near and far distances and the
   * camera's field of view, so it is invariant under rotation: turning the camera translates
   * the shadow frustum but never resizes it. Translation is then removed by snapping the centre
   * to whole texels, which is the other half of §3.2.
   */
  private fit(
    light: THREE.DirectionalLight,
    target: THREE.Object3D,
    index: number,
    camera: THREE.PerspectiveCamera,
    forward: THREE.Vector3,
    sunDir: THREE.Vector3,
    sliceNear: number,
    sliceFar: number,
  ): void {
    // Half-extent of the slice at unit depth, squared: the frustum's own aspect and fov, and
    // nothing about where it is pointing.
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const k2 = tan * tan * (1 + camera.aspect * camera.aspect);

    let centreDepth: number;
    let radius: number;
    if (k2 >= (sliceFar - sliceNear) / (sliceFar + sliceNear)) {
      // Wide slice: the far cap alone bounds it.
      centreDepth = sliceFar;
      radius = sliceFar * Math.sqrt(k2);
    } else {
      centreDepth = 0.5 * (sliceFar + sliceNear) * (1 + k2);
      radius = 0.5 * Math.sqrt(
        (sliceFar - sliceNear) * (sliceFar - sliceNear) +
        2 * (sliceFar * sliceFar + sliceNear * sliceNear) * k2 +
        (sliceFar + sliceNear) * (sliceFar + sliceNear) * k2 * k2,
      );
    }

    const centre = _centre.copy(camera.position).addScaledVector(forward, centreDepth);
    const texelWorld = (radius * 2) / this.mapSize;
    this.texelWorld[index] = texelWorld;

    // §3.2's texel snap. Done in the LIGHT's frame, because that is the grid the depth map is
    // rasterised on; snapping in world space would leave a sub-texel drift along whichever
    // axis the sun happens to lie.
    const eye = _eye.copy(centre).addScaledVector(sunDir, radius + LIGHT_MARGIN);
    const up = Math.abs(sunDir.y) > 0.99 ? _upAlt : _up;
    _lightView.lookAt(eye, centre, up).setPosition(eye).invert();
    const local = _local.copy(centre).applyMatrix4(_lightView);
    local.x = Math.round(local.x / texelWorld) * texelWorld;
    local.y = Math.round(local.y / texelWorld) * texelWorld;
    _lightWorld.copy(_lightView).invert();
    const snapped = local.applyMatrix4(_lightWorld);

    target.position.copy(snapped);
    target.updateMatrixWorld();
    light.position.copy(snapped).addScaledVector(sunDir, radius + LIGHT_MARGIN);
    light.updateMatrixWorld();

    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    // §3.2 again: a wide near/far is "the #1 cause of both peter-panning and acne". The near
    // plane sits just in front of the light and the far plane just behind the slice sphere, so
    // the depth range spent on this cascade is the slice and the margin, nothing else.
    cam.near = LIGHT_MARGIN * 0.5;
    cam.far = radius * 2 + LIGHT_MARGIN * 1.5;
    cam.updateProjectionMatrix();
  }

  dispose(): void {
    for (const light of this.lights) {
      light.shadow.dispose();
      light.removeFromParent();
    }
    for (const t of this.targets) t.removeFromParent();
    this.placeholder.dispose();
  }
}

const _forward = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _local = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _upAlt = new THREE.Vector3(0, 0, 1);
const _lightView = new THREE.Matrix4();
const _lightWorld = new THREE.Matrix4();
