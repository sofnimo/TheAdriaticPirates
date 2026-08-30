import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SkyDome } from '../vendor/skyDome/SkyDome';
import { GrassField } from './grass/GrassField';
import { LIGHTING_DEFAULTS, type LightingParams } from './grass/grassParams';
import { DepthField } from '../world/depth/DepthField';
import { Ocean } from '../world/ocean/Ocean';
import type { SeaStateName } from '../art/seaStates';
import { ModelStage } from './ModelStage';
import { ToonShading, TOON_DEFAULT_STEPS } from './toonShading';

/**
 * THE GRASS WORLD — the vendored stylized-grass scene, tiled out, with this
 * project's own sea alongside it and the aircraft sitting on the water.
 *
 * Two rendering worlds meet here and they do NOT share a lighting model, which is
 * the single most important thing to know before changing anything:
 *
 *   · The GRASS half is Lambert. Blades, ground, flowers, canopies and bark are
 *     all `MeshLambertMaterial` with injected GLSL, so they read three's ambient
 *     and directional lights, and they receive three's shadow map. Turning the
 *     sun down turns the grass down.
 *   · The SEA half is our `Ocean`: a `ShaderMaterial` that never sees a light
 *     uniform at all. Its colour comes from the bathymetry ramp and its own
 *     glints. Turning the sun down does nothing to it whatsoever.
 *
 * So the two are matched by EYE, through the lighting panel, and they will drift
 * apart the moment either side's palette is retuned. That is a real seam, not a
 * bug to be fixed by wiring them together — the sea is art-directed to a fixed
 * palette on purpose (00 §2), and making it obey a slider would be the regression.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────────
 *
 * The GLB is one tile, roughly 15 m square. Tiles are laid on a grid:
 *
 *     row -1   [ grass ][ grass ][ grass ][ grass ]
 *     row  0   [ grass ][ grass ][ grass ][ grass ]
 *     row  1   [ water ][ water ][ water ][ water ]
 *
 * Eight grass, four water, as asked. The water is one flat subdivided plane over
 * the whole four-tile strip rather than four separate meshes — the Gerstner
 * displacement in `ocean.vert.glsl` is continuous across it, and four abutting
 * meshes would show a seam wherever their vertices disagreed.
 */

/**
 * The world is sized in TILES only because that is the unit the ask was phrased in
 * — eight of land, four of water. A tile is the GLB's own ground quad, ~14.8 m.
 * Nothing is actually tiled: the land is one generated heightfield of this area
 * and the water is one plane. See `GrassField` for what fills it.
 */
const LAND_TILES_X = 4;
const LAND_TILES_Z = 2;
const WATER_TILES_X = 4;
const WATER_TILES_Z = 1;

export type GrassViewName = 'establishing' | 'shoreline' | 'lowpass' | 'aircraft' | 'canopy' | 'top' | 'free';

export const GRASS_VIEW_NAMES: ReadonlyArray<GrassViewName> = Object.freeze([
  'establishing', 'shoreline', 'lowpass', 'aircraft', 'canopy', 'top', 'free',
]);

interface ViewSpec {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export class GrassWorldScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly devOverlay = new THREE.Scene();
  readonly controls: OrbitControls;
  readonly sky: SkyDome;
  readonly ambient: THREE.AmbientLight;
  readonly sun: THREE.DirectionalLight;
  readonly lighting: LightingParams = { ...LIGHTING_DEFAULTS };

  /**
   * The one "toon the whole world" switch. Built up front, pointed at the grass
   * once it exists; the aircraft is driven separately through `ModelStage`, which
   * owns its own material swapping. See `toonShading.ts` for why the grass is
   * banded in place and the plane is not.
   */
  readonly toon = new ToonShading(TOON_DEFAULT_STEPS);

  field!: GrassField;
  ocean!: Ocean;
  depthField!: DepthField;
  water!: THREE.Mesh;
  stage!: ModelStage;

  /** World-space footprint of the water strip. */
  readonly waterBounds = new THREE.Box3();
  /**
   * The GRASS footprint — not `field.stats.bounds`, which also contains the
   * submerged beach and the trees' full height. The framings size off this,
   * because "how far back do I stand to see the island" is a question about the
   * land, and letting it include nine metres of underwater sand walked the
   * establishing camera into the aircraft.
   */
  readonly landBounds = new THREE.Box3();
  /** Sea level, in world units. Set from the grass tile's own ground height. */
  waterLevel = 0;
  /** See `setDepthExaggeration`. */
  depthExaggeration = 30;

  /** Built after the light, so `applyLighting` has to tolerate its absence. */
  private shadowHelper: THREE.CameraHelper | null = null;
  private readonly grid: THREE.GridHelper;
  private view: GrassViewName = 'establishing';
  private time = 0;
  private renderer: THREE.WebGLRenderer | null = null;
  /** Real-world footprint the bathymetry describes. */
  private bathySpan = 0;
  /** x = land width, y = shore Z, z = land depth. */
  private landExtent = new THREE.Vector3();
  /** Frames of shadow map still owed. See `bakeShadows`. */
  private bakeFrames = 0;
  private staticShadows = true;

  constructor(canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);

    this.sky = new SkyDome(this.scene, { radius: 900 });

    const l = this.lighting;
    this.ambient = new THREE.AmbientLight(new THREE.Color(l.ambientColor), l.ambientIntensity);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(new THREE.Color(l.dirColor), l.dirIntensity);
    this.sun.castShadow = true;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.applyLighting();

    this.shadowHelper = new THREE.CameraHelper(this.sun.shadow.camera);
    this.shadowHelper.visible = false;
    this.shadowHelper.update();
    this.grid = new THREE.GridHelper(120, 24, 0x9bb5a8, 0x3d5a52);
    this.grid.visible = false;
    this.devOverlay.add(this.shadowHelper, this.grid);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 400;
    // Under the horizon the camera ends up beneath the water plane looking at its
    // backface, which reads as a rendering bug rather than a camera that wandered.
    this.controls.maxPolarAngle = Math.PI * 0.495;
  }

  /**
   * Builds everything that needs an async load: the grass GLB and its textures,
   * then the sea that shelves against it, then the model stage.
   */
  async load(seaState: SeaStateName = 'breeze'): Promise<void> {
    // A tile of area, measured off the GLB's own ground quad so "eight tiles"
    // means the same thing it did before the field became procedural.
    const TILE = 14.788;
    const landWidth = TILE * LAND_TILES_X;
    const landDepth = TILE * LAND_TILES_Z;
    const waterWidth = TILE * WATER_TILES_X;
    const waterDepth = TILE * WATER_TILES_Z;

    // Land centred on the origin; the sea on the +z side of it. `shoreZ` is the
    // WATERLINE — the ground is built to pass through sea level exactly there and
    // keep descending past it, so the beach goes under the water instead of ending
    // at a wall. See ProceduralTerrain.heightAt.
    const shoreZ = landDepth / 2;
    this.waterLevel = -0.6;

    this.field = await GrassField.load(this.scene, {
      width: landWidth,
      depth: landDepth,
      patchesX: LAND_TILES_X,
      patchesZ: LAND_TILES_Z,
      shoreZ,
      waterLevel: this.waterLevel,
      submergedRun: 9,
      // One meadow, off to the west — grass, flowers and nothing else standing in
      // it, so there is somewhere in the field the eye can rest and somewhere an
      // aircraft could plausibly come down.
      clearing: { x: -14, z: -2, radius: 9.5 },
      seed: 20260830,
      // Upstream's 300/unit² capped at 53k covers ONE 14.8 m tile. Eight tiles of
      // that is ~420k blades, which is a slideshow before anything else draws. The
      // cap does the thinning: the scatter still spreads over the whole patch, so
      // lowering it thins evenly rather than clipping a corner.
      params: { grMaxCount: 16000 },
    });

    // Every grass material gets the toon injection now, while nothing has been
    // drawn yet: it rides on a uniform, so this is the last compile the toggle
    // will ever cost.
    this.toon.scan(this.field.group);

    // The water plane starts INLAND of the waterline, tucked under the dry sand.
    // If it started at `shoreZ` the two edges would coincide and the coastline
    // would be wherever the plane was cut, which is a straight line by
    // construction. Overlapping them puts the coastline where the terrain crosses
    // sea level instead — so it wanders with the beach's own relief, and the
    // plane's landward edge is buried under sand that is above it.
    const waterOverlap = 3;
    this.waterBounds.set(
      new THREE.Vector3(-waterWidth / 2, this.waterLevel, shoreZ - waterOverlap),
      new THREE.Vector3(waterWidth / 2, this.waterLevel, shoreZ - waterOverlap + waterDepth),
    );
    this.landBounds.set(
      new THREE.Vector3(-landWidth / 2, this.waterLevel, -landDepth / 2),
      new THREE.Vector3(landWidth / 2, 8, shoreZ),
    );
    const waterSize = this.waterBounds.getSize(new THREE.Vector3());
    const waterCentre = this.waterBounds.getCenter(new THREE.Vector3());

    // ── The sea ──────────────────────────────────────────────────────────────
    // The bathymetry's land mask is the generated land footprint, so the shelf
    // ramp shoals toward the bank exactly where the grass actually ends. See
    // `setDepthExaggeration` for why it is not baked at 1:1.
    this.bathySpan = Math.max(landWidth, landDepth + waterDepth) * 2;
    this.landExtent = new THREE.Vector3(landWidth, shoreZ, landDepth);
    this.buildBathymetry();

    this.ocean = new Ocean(this.scene, this.depthField, seaState);
    this.applyDepthMapping();
    // Ocean ships an infinite camera-following ring mesh (02 §1.2). This scene
    // wants a bounded pond, so the rings come out and the material goes onto a
    // plane instead. The ocean's vertex stage is world-space, so it does not care
    // what geometry carries it.
    this.ocean.rings.group.removeFromParent();

    // ~2 cells per metre: enough for the near-field Gerstner displacement, which
    // is the only part of the ocean shader that wants vertices at all.
    const geometry = new THREE.PlaneGeometry(
      waterSize.x,
      waterSize.z,
      Math.max(8, Math.round(waterSize.x * 2)),
      Math.max(8, Math.round(waterSize.z * 2)),
    );
    geometry.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geometry, this.ocean.material);
    this.water.position.set(waterCentre.x, this.waterLevel, waterCentre.z);
    this.water.receiveShadow = false;
    this.scene.add(this.water);

    // ── The aircraft ─────────────────────────────────────────────────────────
    // On the water, in the middle of the strip. A flying boat belongs on its floats.
    this.stage = new ModelStage(this.scene, {
      stagePoint: new THREE.Vector3(waterCentre.x, this.waterLevel, waterCentre.z),
      targetSize: 12,
    });

    // Re-assert the toggle: it can be flipped while this promise is still in
    // flight, and neither the field nor the stage existed to hear it.
    this.setToonShading(this.toon.on);

    this.frameShadowCamera();
    this.setView('establishing');
  }

  /**
   * Sample the sea's colour ramp as though this pond were a stretch of open sea.
   *
   * `DepthField`'s `SHELF_PROFILE` is authored in real metres for a real coast:
   * depth01 reaches 0.25 at 60 m from shore, 0.5 at 190 m, 0.75 at 420 m. This
   * strip of water is fifteen metres deep. Baked at 1:1 the whole pond lands
   * between depth01 0.00 and 0.06 — the first six percent of the ramp — so it
   * renders as one flat sheet of the palest lagoon tone, and the glints never
   * appear at all because `GLINT_RULE.depthFade` only fades sparkle in from 0.5.
   *
   * Nothing is broken in that picture; it is the sea shader correctly reporting
   * "this is water nought to fifteen metres from a beach". It is simply not what
   * a sea is supposed to look like, and the fix belongs here rather than in the
   * ramp — 00 §2's palette is the binding contract and bending it so a test pond
   * looks nicer would be the actual regression.
   *
   * So the bathymetry is baked in a VIRTUAL world `depthExaggeration` times
   * larger, with the land mask scaled to match, and the shader is then told the
   * texture covers the real footprint. One real metre of pond therefore traverses
   * thirty metres of the authored shelf: the strip runs turquoise at the bank to
   * deep blue at the far edge, and crosses 0.5 far enough out for the glints.
   *
   * The mapping algebra is worth keeping straight. The shader computes
   * `uv = (world - uBathyOrigin) / uBathyScale`; a real point `w` must land on
   * virtual point `w·K`, whose uv is `(w·K - origin·K)/(span·K)` = `(w - origin)/span`.
   * K cancels — which is why the exaggeration lives in the BAKE and the uniforms
   * simply describe the real footprint.
   */
  setDepthExaggeration(k: number): void {
    this.depthExaggeration = Math.max(1, k);
    const previous = this.depthField.texture;
    this.buildBathymetry();
    this.ocean.uniforms.uBathymetry!.value = this.depthField.texture;
    this.applyDepthMapping();
    previous.dispose();
  }

  private buildBathymetry(): void {
    const k = this.depthExaggeration;
    const span = this.bathySpan * k;
    const halfWidth = this.landExtent.x / 2;
    const shoreZ = this.landExtent.y;
    const halfDepth = this.landExtent.z / 2;
    this.depthField = new DepthField({
      resolution: 512,
      worldSize: span,
      origin: new THREE.Vector2(-span / 2, -span / 2),
      // Called with VIRTUAL coordinates; divide back out to test the real land.
      landAt: (vx, vz) => {
        const x = vx / k;
        const z = vz / k;
        return Math.abs(x) <= halfWidth && z <= shoreZ && z >= -halfDepth;
      },
      // NOTE: a rectangle, deliberately. The bathymetry only decides the sea's
      // COLOUR ramp, and the beach's own wander is centimetres of Z against a
      // shelf profile measured in tens of metres — modelling it here would cost a
      // heightfield lookup per texel and move no pixel.
    });
  }

  /** Tell the shader the (virtual) texture covers the real footprint. */
  private applyDepthMapping(): void {
    const u = this.ocean.uniforms;
    (u.uBathyOrigin!.value as THREE.Vector2).set(-this.bathySpan / 2, -this.bathySpan / 2);
    u.uBathyScale!.value = this.bathySpan;
  }

  /**
   * Fit the shadow frustum to the generated field.
   *
   * Upstream's 9 is authored for a single ~7.4-unit tile and is deliberately tight
   * — a texel covers 2·camSize/mapSize world units, so slack is texels spent
   * shadowing empty space. Sixty metres of land needs a much wider box; at 4096
   * the texel is still ~1.6 cm, which resolves a blade.
   */
  private frameShadowCamera(): void {
    const b = this.field.stats.bounds;
    const size = b.getSize(new THREE.Vector3());
    this.lighting.shadowCamSize = Math.max(size.x, size.z) * 0.55;
    this.lighting.shadowFar = this.lighting.lightDistance * 2 + Math.max(size.x, size.y, size.z);
    this.applyLighting();
  }

  /** Push `this.lighting` into the rig. Called after any panel change. */
  applyLighting(): void {
    const l = this.lighting;
    this.ambient.color.set(l.ambientColor);
    this.ambient.intensity = l.ambientIntensity;

    this.sun.color.set(l.dirColor);
    this.sun.intensity = l.dirIntensity;

    const dir = new THREE.Vector3(l.dirX, l.dirY, l.dirZ);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize().multiplyScalar(l.lightDistance);
    this.sun.position.copy(dir);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();

    const shadow = this.sun.shadow;
    shadow.mapSize.set(l.shadowMapSize, l.shadowMapSize);
    const cam = shadow.camera;
    cam.left = -l.shadowCamSize;
    cam.right = l.shadowCamSize;
    cam.top = l.shadowCamSize;
    cam.bottom = -l.shadowCamSize;
    cam.near = l.shadowNear;
    cam.far = l.shadowFar;
    cam.updateProjectionMatrix();
    shadow.bias = l.shadowBias;
    shadow.normalBias = l.shadowNormalBias;
    // The map is frozen (see `setStaticShadows`), so any change to the rig has to
    // ask for a re-bake or it simply will not appear.
    this.bakeShadows();
    // Undefined during construction: the rig is applied before the helper that
    // draws its frustum exists, and the helper cannot be built before the shadow
    // camera it wraps.
    this.shadowHelper?.update();
  }

  /**
   * Freeze the shadow map after baking it.
   *
   * Every caster here is static: the rocks and trunks do not move, and the canopy
   * depth material deliberately drops the wind (see `makePineLeafDepthMaterial`).
   * So the map is identical every frame, and re-rendering a 4096² map 60×/second
   * is pure waste — worse, any jitter between those renders is the flicker the
   * whole soft-shadow scheme exists to kill. The grass still RECEIVES shadows
   * every frame; only the map's re-render is skipped.
   */
  setStaticShadows(on: boolean): void {
    this.staticShadows = on;
    if (!this.renderer) return;
    this.renderer.shadowMap.autoUpdate = !on;
    if (on) this.bakeShadows();
  }

  /** Ask for a fresh bake — a few frames, to cover async texture settling. */
  bakeShadows(): void {
    this.bakeFrames = 8;
  }

  /** Handed the renderer so the shadow freeze can reach `shadowMap.autoUpdate`. */
  attachRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    renderer.shadowMap.autoUpdate = !this.staticShadows;
    this.bakeShadows();
  }

  get viewName(): GrassViewName {
    return this.view;
  }

  private viewSpec(name: GrassViewName): ViewSpec {
    const b = this.landBounds;
    const centre = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const plane = this.stage.model
      ? this.stage.centre()
      : this.waterBounds.getCenter(new THREE.Vector3());

    switch (name) {
      case 'establishing':
        // Out over the water, looking back at the island: the beach across the
        // bottom of frame, the wood behind it, sky above.
        return {
          position: new THREE.Vector3(centre.x + size.x * 0.06, 22, this.waterBounds.max.z + size.z * 0.55),
          target: new THREE.Vector3(centre.x, 0, centre.z + size.z * 0.15),
        };
      case 'shoreline':
        // Low and almost level with the sea, just off the beach. The waterline is
        // the thing worth judging here and it is invisible from any height.
        return {
          position: new THREE.Vector3(centre.x - 10, this.waterLevel + 1.8, b.max.z + 9),
          target: new THREE.Vector3(centre.x + 6, this.waterLevel + 0.4, b.max.z - 6),
        };
      case 'lowpass':
        // Blade height, looking through the field into the sun — the framing the
        // translucency lobe was tuned for.
        return {
          position: new THREE.Vector3(centre.x + 3, 0.35, centre.z + 6),
          target: new THREE.Vector3(centre.x - 8, 0.7, centre.z - 6),
        };
      case 'aircraft':
        return {
          position: plane.clone().add(new THREE.Vector3(9, 5, 13)),
          target: plane,
        };
      case 'canopy':
        return {
          position: new THREE.Vector3(centre.x + 8, size.y * 0.8, centre.z + 12),
          target: new THREE.Vector3(centre.x, size.y * 0.55, centre.z),
        };
      case 'top':
        return {
          position: new THREE.Vector3(centre.x, Math.max(size.x, size.z) * 1.1, centre.z + 0.01),
          target: new THREE.Vector3(centre.x, 0, centre.z),
        };
      case 'free':
        return { position: this.camera.position.clone(), target: centre };
    }
  }

  setView(view: GrassViewName): void {
    this.view = view;
    if (view === 'free') {
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

  /** Re-apply the current framing — the aircraft views size off the loaded model. */
  reframe(): void {
    if (this.view !== 'free') this.setView(this.view);
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v;
  }

  setShadowHelperVisible(v: boolean): void {
    if (this.shadowHelper) this.shadowHelper.visible = v;
  }

  setWaterVisible(v: boolean): void {
    this.water.visible = v;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    this.time += dt;

    if (this.controls.enabled) this.controls.update();
    this.camera.updateMatrixWorld(true);

    this.sky.update(this.camera, this.time);
    this.field?.update(dt, this.scene);
    this.stage?.update(dt);
    this.ocean?.update(this.camera, this.time);

    // `needsUpdate` renders the shadow map exactly once and three clears it back
    // to false, so this bakes precisely `bakeFrames` frames and then stops.
    if (this.staticShadows && this.bakeFrames > 0 && this.renderer) {
      this.renderer.shadowMap.needsUpdate = true;
      this.bakeFrames -= 1;
    }
  }

  /**
   * Toon shading on or off, for the grass world AND the aircraft in one call.
   *
   * The sea and the sky are deliberately left out. Neither reads a light at all —
   * `Ocean` is a `ShaderMaterial` coloured by the bathymetry ramp and its own
   * glints (00 §2's fixed palette), and the sky dome is a painted gradient — so
   * there is no N·L on either to band. Toon shading them would mean re-authoring
   * two art-directed palettes, which is a different job from this switch.
   */
  setToonShading(on: boolean): void {
    if (this.field) this.toon.setEnabled(on, this.field.group);
    this.stage?.setToonOverride(on, this.toon.steps);
  }

  /** Band count, pushed to both halves so they step at the same N·L. */
  setToonSteps(steps: number): void {
    this.toon.setSteps(steps);
    if (this.toon.on) this.stage?.setToonOverride(true, this.toon.steps);
  }

  dispose(): void {
    this.controls.dispose();
    this.toon.dispose();
    this.field?.dispose();
    this.stage?.dispose();
    this.sky.dispose();
  }
}
