import * as THREE from 'three';
import { SunRig } from '../render/lighting/SunRig';
import { SkyDome } from '../world/sky/SkyDome';
import { DepthField } from '../world/depth/DepthField';
import { Ocean } from '../world/ocean/Ocean';
import { Island } from '../world/island/Island';
import { Vegetation } from '../world/vegetation/Vegetation';
import { ShoreAtlas } from '../world/shore/ShoreAtlas';
import { makeShoreUniforms, updateFoamLOD, type ShoreUniforms } from '../world/shore/shoreUniforms';
import { SEA_STATES, swellDirection, type SeaStateName } from '../art/seaStates';
import { globalUniforms } from '../render/shading/ShadingUniforms';
import { BIOME } from '../world/island/BiomeField';

/**
 * WORLD VALIDATION SCENE — ocean, continuous depth ramp, and from Step 3 one hand-authored
 * island supplying the land mask the bathymetry shelves against.
 *
 * Views:
 *   cove     — oblique across the shelf transition, the "most important colour event"
 *   shelf    — near-vertical, what the smoothness probe measures on
 *   skim     — low pass over open water, framed like image-4.jpg for the glint measurement
 *   island   — three-quarter aerial on the island, 00 §3 rule 9's default camera
 *   profile  — low and across the spine, showing the cliffed and sheltered flanks together
 *   canopy   — low across the densest wooded slope, what the vegetation gate measures on
 *   free     — hands the camera to FreeCamera and leaves it alone
 *   topdown / low / high — the camera envelope, for aliasing and fade checks
 */

export type OceanViewName =
  | 'cove' | 'shelf' | 'skim' | 'island' | 'profile' | 'canopy' | 'shore'
  | 'topdown' | 'low' | 'high' | 'free';

interface ViewSpec {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * `cove` is the composition to hold against the reference frame; `shelf` is the one the
 * probe measures on. They are separate on purpose: an oblique view foreshortens the band
 * edge, so measuring edge width and wander in world terms wants a near-vertical camera,
 * while judging whether the edge reads as PAINTED wants the oblique framing the reference
 * actually uses.
 *
 * `low` and `high` are near-vertical over open water at 200 m and 1500 m — the camera
 * envelope from 00 §3 rule 9 — so the aliasing checks see water and nothing else.
 */
const VIEWS: Record<OceanViewName, ViewSpec> = {
  // Open coast, looking shoreward: deep water in the near field sweeping up through the
  // turquoise shelf to the waterline about three-quarters of the way up the frame. That is
  // image-3's composition, and the whole depth ramp is on screen at once.
  //
  // This replaced a framing inside the bay at x=-150. Measured, that one spent 80% of its
  // pixels at depth01 ~= 0 — a 300 m bay puts every point within ~150 m of land, and with no
  // island geometry until Step 3 the landward side renders as the ramp's palest stop. The
  // frame came back an almost uniform #a2bab0 field with the colour event nowhere in it, so
  // it was showing the placeholder rather than the thing under review.
  cove: { position: new THREE.Vector3(300, 200, -100), target: new THREE.Vector3(300, 0, -320) },
  // Open coast, well clear of the bay. Inside a 300 m bay every point is within ~150 m of
  // land, so the water there is legitimately shallow throughout and never reaches the deep
  // bands — correct behaviour, but useless for measuring the full band sequence.
  shelf: { position: new THREE.Vector3(300, 320, -240), target: new THREE.Vector3(300, 0, -300) },
  // Placeholder; skimView() replaces it per sea state in the constructor. See below.
  skim: { position: new THREE.Vector3(600, 35, 700), target: new THREE.Vector3(600, 0, 620) },
  // Three-quarter aerial at ~700 m — 00 §3 rule 9's default camera, and the framing every
  // asset has to read at first. Set from the island's own bounds in the constructor.
  island: { position: new THREE.Vector3(900, 700, 500), target: new THREE.Vector3(0, 60, -600) },
  // Low and across the spine, so the cliffed seaward flank and the terraced sheltered flank
  // are both in frame at once — the asymmetry of 03 §3.5 is the thing to judge here.
  profile: { position: new THREE.Vector3(120, 180, 340), target: new THREE.Vector3(-100, 70, -620) },
  // Aimed in the constructor at the densest wooded slope the island actually has. Low and
  // close, because the vegetation gate is asking whether the Ghibli band is banding, and a
  // 700 m aerial resolves a canopy to a few pixels per tree where every tone is a blend.
  canopy: { position: new THREE.Vector3(0, 120, 200), target: new THREE.Vector3(0, 60, 0) },
  // Never read. `setView('free')` returns before touching the camera; the entry exists so
  // the view name is a member of the same table as the rest and nothing has to special-case
  // it on lookup.
  free: { position: new THREE.Vector3(0, 300, 0), target: new THREE.Vector3(0, 0, -1) },
  // Low and close on the waterline, where the foam layers are legible as shapes rather than
  // as a band — 02b §2.4's "low pass" regime. Aimed from the island's own bounds below.
  shore: { position: new THREE.Vector3(0, 90, 200), target: new THREE.Vector3(0, 0, -60) },
  topdown: { position: new THREE.Vector3(600, 300, 640), target: new THREE.Vector3(600, 0, 600) },
  low: { position: new THREE.Vector3(600, 200, 627), target: new THREE.Vector3(600, 0, 600) },
  high: { position: new THREE.Vector3(600, 1500, 1700), target: new THREE.Vector3(600, 0, 1500) },
};

/**
 * Low pass over open water, framed like image-4.jpg — the frame glint density and shape are
 * calibrated against.
 *
 * Two things have to match for the comparison to mean anything, and both are easy to get
 * wrong. Coverage is a fraction of PIXELS, so it only compares like-for-like at comparable
 * range: hence low and close, not the 300 m top-down. And mark aspect is measured in SCREEN
 * space, so the camera has to look ACROSS the swell — pointing along it foreshortens every
 * mark and the same field measures 0.5:1 instead of 6.9:1. The heading is therefore derived
 * from the sea state's own swell axis rather than hardcoded, so changing sea state in the UI
 * cannot silently invalidate the measurement.
 */
function skimView(state: SeaStateName, awayFrom: THREE.Vector3): ViewSpec {
  const [sx, sz] = swellDirection(SEA_STATES[state]);
  // Perpendicular to the swell, so crests and marks run left-to-right across the frame.
  let look = new THREE.Vector3(-sz, 0, sx).normalize();
  const eye = new THREE.Vector3(1500, 35, 1250);
  // Two perpendiculars exist; take the one pointing AWAY from the island, or the frame fills
  // with terrain and the glint measurement quietly becomes a measurement of a hillside.
  if (look.dot(new THREE.Vector3().subVectors(awayFrom, eye).setY(0).normalize()) > 0) {
    look.negate();
  }
  // 24 deg down: the near edge of frame lands ~30 m out, the far edge past the range taper.
  const target = eye.clone().addScaledVector(look, 80).setY(0);
  return { position: eye, target };
}

/** The seaward shore texel with the highest exposure — where foam should be most visible. */
function mostExposedShore(field: { resolution: number; land: Uint8Array; originX: number; originZ: number; metresPerSample: number; exposure: Float32Array },
                          atlas: ShoreAtlas): { x: number; z: number } {
  let best = -Infinity;
  let bx = 0;
  let bz = 0;
  for (let iz = 0; iz < field.resolution; iz += 2) {
    for (let ix = 0; ix < field.resolution; ix += 2) {
      const i = iz * field.resolution + ix;
      if (field.land[i] === 1) continue;
      const x = field.originX + ix * field.metresPerSample;
      const z = field.originZ + iz * field.metresPerSample;
      const d = atlas.distanceAt(x, z);
      if (d < 2 || d > 12) continue;
      // Seaward flank only, and the most open stretch of it.
      const score = field.exposure[i]! + z * 0.0004;
      if (score > best) { best = score; bx = x; bz = z; }
    }
  }
  return { x: bx, z: bz };
}

/**
 * The wooded texel with the most forest around it — where the canopy view is aimed.
 *
 * Scored over a neighbourhood rather than per texel: a single dense-forest texel in a field
 * of scrub is not a canopy, and framing on one would put the gate's transects across mostly
 * open ground.
 */
function densestWoodland(biomes: {
  resolution: number;
  biome: Uint8Array;
  density: Float32Array;
  island: { originX: number; originZ: number; metresPerSample: number; heightAt(x: number, z: number): number };
}): { x: number; y: number; z: number } {
  const n = biomes.resolution;
  const R = 5;
  let best = -Infinity;
  let bx = 0;
  let bz = 0;
  for (let iz = R; iz < n - R; iz += 3) {
    for (let ix = R; ix < n - R; ix += 3) {
      let score = 0;
      for (let dz = -R; dz <= R; dz += R) {
        for (let dx = -R; dx <= R; dx += R) {
          const j = (iz + dz) * n + (ix + dx);
          const b = biomes.biome[j]!;
          if (b === BIOME.denseForest) score += biomes.density[j]! * 2;
          else if (b === BIOME.sparseForest) score += biomes.density[j]!;
        }
      }
      if (score > best) {
        best = score;
        bx = biomes.island.originX + ix * biomes.island.metresPerSample;
        bz = biomes.island.originZ + iz * biomes.island.metresPerSample;
      }
    }
  }
  return { x: bx, y: biomes.island.heightAt(bx, bz), z: bz };
}

export class OceanTestScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: SunRig;
  readonly sky: SkyDome;
  readonly depthField: DepthField;
  readonly ocean: Ocean;
  readonly island: Island;
  readonly vegetation: Vegetation;
  readonly shoreAtlas: ShoreAtlas;
  readonly shoreUniforms: ShoreUniforms;
  readonly devOverlay = new THREE.Scene();

  private view: OceanViewName = 'cove';
  private time = 0;

  constructor(seaState: SeaStateName = 'breeze') {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 25000);

    this.sky = new SkyDome(this.scene, 10000);
    this.sun = new SunRig(this.scene, { shadowExtent: 60, shadowMapSize: 1024, distance: 400 });

    // Order matters: the island bakes its field first, then the bathymetry is built FROM
    // that mask. One shoreline, two consumers (02b §1.2).
    this.island = new Island(this.scene, undefined, 4096);
    this.depthField = new DepthField({
      resolution: 1024,
      worldSize: 4096,
      landAt: this.island.landAt,
    });
    // 02b §7.1: the shoreline is a post-process stage of the island pipeline. It bakes from
    // the island's mask and the bathymetry's depth, so both must already exist.
    this.shoreAtlas = new ShoreAtlas(this.island.field, this.depthField);
    this.shoreUniforms = makeShoreUniforms(this.shoreAtlas);
    this.island.attachShore(this.shoreUniforms);

    this.ocean = new Ocean(this.scene, this.depthField, seaState, this.shoreUniforms);

    // 03 §8. Placed from the island's own baked biome field, cropped to the meshed bounds —
    // planting outside them would put trees on ground the terrain mesh does not cover.
    this.vegetation = new Vegetation(
      this.scene,
      this.island.field,
      this.island.biomes,
      this.island.meshInfo.bounds,
    );

    // Frame the aerial views from the island's actual bounds rather than hardcoded numbers,
    // so re-authoring the spine cannot silently leave the camera pointing at empty sea.
    const b = this.island.meshInfo.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    // ~1.5 km out at ~600 m altitude. Framing the WHOLE island needs about 2 km at this
    // field of view, which is outside 00 §3 rule 9's 200-1500 m envelope and lands deep in
    // the haze; this trades a little of the tail for a camera the game will actually use.
    VIEWS.island = {
      position: new THREE.Vector3(cx + span * 0.35, span * 0.25, cz + span * 0.45),
      target: new THREE.Vector3(cx, this.island.spec.peakHeight * 0.3, cz),
    };
    const summit = this.island.field.summit;
    VIEWS.profile = {
      position: new THREE.Vector3(summit.x + 260, summit.height * 0.85, summit.z + 620),
      target: new THREE.Vector3(summit.x - 60, summit.height * 0.45, summit.z - 260),
    };
    VIEWS.skim = skimView(seaState, new THREE.Vector3(cx, 0, cz));

    // Point the canopy view at the island's own densest woodland rather than at a hardcoded
    // spot. Re-authoring the spine moves every forest patch, and a fixed camera would end up
    // measuring the Ghibli band on a bare hillside and reporting one tone.
    const wood = densestWoodland(this.island.biomes);
    VIEWS.canopy = {
      position: new THREE.Vector3(wood.x + 120, wood.y + 58, wood.z + 175),
      target: new THREE.Vector3(wood.x, wood.y + 6, wood.z),
    };

    // Put the camera on the most exposed stretch of the seaward coast, so the run-up band is
    // at its widest and the foam is being judged where it does the most work.
    const shorePoint = mostExposedShore(this.island.field, this.shoreAtlas);
    // 02b §2.4 splits foam behaviour into three altitude regimes and says individual clumps
    // are only legible as shapes in the "<150 m" one. At 70 m up and 200 m out the run-up band
    // was 3-5 px tall — present and correct, and impossible to judge. This sits in the regime
    // the doc says to judge it in.
    VIEWS.shore = {
      position: new THREE.Vector3(shorePoint.x + 6, 22, shorePoint.z + 62),
      target: new THREE.Vector3(shorePoint.x, 1, shorePoint.z - 14),
    };

    // Re-aim the two water views at the island's seaward flank. They were pointed at the
    // Step 2 placeholder coastline, which no longer exists.
    const shoreZ = b.maxZ - 140;
    VIEWS.cove = {
      position: new THREE.Vector3(cx + 60, 200, shoreZ + 520),
      target: new THREE.Vector3(cx + 60, 0, shoreZ + 60),
    };
    VIEWS.shelf = {
      position: new THREE.Vector3(cx - 220, 340, shoreZ + 330),
      target: new THREE.Vector3(cx - 220, 0, shoreZ + 190),
    };
    this.setView('cove');
  }

  get viewName(): OceanViewName {
    return this.view;
  }

  setView(view: OceanViewName): void {
    this.view = view;
    // The free camera owns the pose. Refresh the camera-dependent systems — the ocean rings
    // and the sky dome both follow the camera — but do not move it.
    if (view === 'free') {
      this.update(0);
      return;
    }
    const spec = VIEWS[view];
    this.camera.position.copy(spec.position);
    this.camera.lookAt(spec.target);
    this.camera.updateMatrixWorld(true);
    this.update(0);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** `dt` of 0 just refreshes positions without advancing the wave clock. */
  update(dt: number): void {
    this.time += dt;
    this.camera.updateMatrixWorld(true);
    // The shared clock. Nothing advanced it before the wind arrived — the ocean carries its
    // own wave time — so it is set here, where the world clock already lives, rather than
    // giving the vegetation a second one to drift against.
    globalUniforms.uTime.value = this.time;
    this.sky.update(this.camera);
    this.ocean.update(this.camera, this.time);
    this.vegetation.update(this.camera);
    updateFoamLOD(this.shoreUniforms, this.camera.position.y);
  }

  /** Force the wave clock, for the frame-to-frame stability probe. */
  setWaveTime(t: number): void {
    this.time = t;
    this.ocean.update(this.camera, this.time);
  }

  get waveTime(): number {
    return this.time;
  }
}
