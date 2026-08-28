import * as THREE from 'three';
import { SunRig } from '../render/lighting/SunRig';
import { SkyDome } from '../world/sky/SkyDome';
import { DepthField } from '../world/depth/DepthField';
import { Ocean } from '../world/ocean/Ocean';
import { Archipelago } from '../world/island/Archipelago';
import { TEST_ISLAND_SEED } from '../world/island/IslandSpec';
import type { CoverField } from '../world/island/CoverField';
import { ShoreAtlas } from '../world/shore/ShoreAtlas';
import { makeShoreUniforms, updateFoamLOD, type ShoreUniforms } from '../world/shore/shoreUniforms';
import { DEFAULT_SEA_STATE, SEA_STATES, swellDirection, type SeaStateName } from '../art/seaStates';
import { globalUniforms } from '../render/shading/ShadingUniforms';
import { WaveSurface } from '../world/ocean/waveSurface';
import { ShelterField } from '../world/ocean/ShelterField';
import { Seaplane } from '../game/flight/Seaplane';

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
  | 'topdown' | 'low' | 'high' | 'cockpit' | 'free';

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
  // Never read either: the seaplane's own chase boom owns the camera while this is selected,
  // the same way `free` hands it to `FreeCamera`.
  cockpit: { position: new THREE.Vector3(0, 30, 0), target: new THREE.Vector3(0, 0, -1) },
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
      // Scored on the ATLAS's headland-versus-cove channel, because that is the number the
      // run-up reach is actually scaled by. The island field's own exposure says which flank
      // faces the open sea and saturates at 1 across the whole of it, so ranking by it left
      // thousands of ties for the `z` term to break — and picked whatever lay furthest north,
      // which on a generated island is as likely to be a tapering terminus as a headland.
      const scale = atlas.resolution / field.resolution;
      const ax = Math.min(atlas.resolution - 1, Math.round(ix * scale));
      const az = Math.min(atlas.resolution - 1, Math.round(iz * scale));
      const score = atlas.exposure[az * atlas.resolution + ax]! + field.exposure[i]! * 0.25;
      if (score > best) { best = score; bx = x; bz = z; }
    }
  }
  return { x: bx, z: bz };
}

/**
 * Which way is out to sea, at a point on the coast.
 *
 * Downhill on the elevation field, which is the seaward direction by definition once the
 * terrain and the bathymetry are one signed surface. The shore view used to step a fixed
 * +62 m in Z from the waterline and call that "out to sea"; that holds only for a coast facing
 * north, and on a generated island it puts the camera inside the hill about as often as not —
 * whereupon the foam gate measures zero foam and reports a shoreline failure that is really a
 * camera failure.
 */
function seawardAt(
  field: { metresPerSample: number; heightAt(x: number, z: number): number },
  x: number, z: number,
): { x: number; z: number } {
  const e = field.metresPerSample * 3;
  const gx = field.heightAt(x + e, z) - field.heightAt(x - e, z);
  const gz = field.heightAt(x, z + e) - field.heightAt(x, z - e);
  const len = Math.hypot(gx, gz) || 1;
  return { x: -gx / len, z: -gz / len };
}

/**
 * Metres offshore, along `dir`, at which the seabed reaches `depth`.
 *
 * The two water views frame the shelf transition, and where that transition IS depends
 * entirely on the island: a windward flank e-folds to the abyss in 200 m and a sheltered one
 * takes 450. Framing it with a fixed offset in metres — which is what these views used to do —
 * shows the whole colour ramp on one island and nothing but deep blue on the next.
 */
function offshoreAtDepth(
  field: { heightAt(x: number, z: number): number },
  x: number, z: number, dir: { x: number; z: number }, depth: number,
): number {
  for (let d = 0; d <= 1200; d += 8) {
    if (-field.heightAt(x + dir.x * d, z + dir.z * d) >= depth) return d;
  }
  return 1200;
}

/**
 * The stretch of coast with the widest shelf — where the depth ramp has the most room to read.
 *
 * 02's "most important colour event" is the shallow-to-deep transition, and it is only worth
 * measuring where it is actually resolvable. The widest deposited beach marks the gentlest
 * seabed, because both come from the same sheltered, low-energy flank.
 */
function gentlestShore(
  field: {
    resolution: number; land: Uint8Array; originX: number; originZ: number;
    metresPerSample: number; beachWidth: Float32Array;
  },
  atlas: ShoreAtlas,
): { x: number; z: number } {
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
      if (d < 2 || d > 10) continue;
      if (field.beachWidth[i]! > best) { best = field.beachWidth[i]!; bx = x; bz = z; }
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
function densestWoodland(cover: CoverField): { x: number; y: number; z: number } {
  const n = cover.resolution;
  const R = 5;
  let best = -Infinity;
  let bx = 0;
  let bz = 0;
  for (let iz = R; iz < n - R; iz += 3) {
    for (let ix = R; ix < n - R; ix += 3) {
      let score = 0;
      for (let dz = -R; dz <= R; dz += R) {
        for (let dx = -R; dx <= R; dx += R) {
          score += cover.forest[(iz + dz) * n + (ix + dx)]!;
        }
      }
      if (score > best) {
        best = score;
        // The cover field has its own coarser pitch; indexing it with the elevation field's
        // would aim the camera at twice the distance from the origin it meant to.
        bx = cover.worldX(ix);
        bz = cover.worldZ(iz);
      }
    }
  }
  return { x: bx, y: cover.island.heightAt(bx, bz), z: bz };
}

/**
 * A SHELTERED STRETCH OF WATER TO START ON.
 *
 * A seaplane does not take off from the open sea, and this is not a nicety: the hull has to
 * fight through its own bow wave before it planes, and a metre of swell on the nose during
 * that run stops the takeoff outright. So the mooring is found the way a pilot would find
 * one — water deep enough to float in, shallow enough to be inside the shelf, on the
 * SHELTERED flank, and with a long clear run ahead of it down the lane.
 *
 * Searched rather than authored, because the island is generated: a hardcoded pair of
 * coordinates is a mooring on the hillside as soon as the seed changes.
 */
function findMooring(
  field: {
    resolution: number; land: Uint8Array; height: Float32Array; exposure: Float32Array;
    originX: number; originZ: number; metresPerSample: number;
  },
  atlas: ShoreAtlas,
): { x: number; z: number } {
  let best = -Infinity;
  let bx = 0;
  let bz = 0;
  for (let iz = 0; iz < field.resolution; iz += 2) {
    for (let ix = 0; ix < field.resolution; ix += 2) {
      const i = iz * field.resolution + ix;
      if (field.land[i] === 1) continue;
      const depth = -field.height[i]!;
      if (depth < 4 || depth > 26) continue;
      const x = field.originX + ix * field.metresPerSample;
      const z = field.originZ + iz * field.metresPerSample;
      const d = atlas.distanceAt(x, z);
      // Off the beach, but still in the lee of the island rather than out in the channel.
      if (d < 90 || d > 400) continue;
      // Sheltered flank, and the deeper end of the anchorage — the run wants water under it.
      const score = -field.exposure[i]! * 2 + depth * 0.04;
      if (score > best) { best = score; bx = x; bz = z; }
    }
  }
  return { x: bx, z: bz };
}

/**
 * The map tile: 8 km square, sampled every 5.33 m.
 *
 * Four times the area of the single-island tile it replaces, at the same order of sampling.
 * The island field, the bathymetry and the shore atlas all share this grid — see the note in
 * `Archipelago` on why one lattice rather than three.
 */
const WORLD_SIZE = 8192;
const FIELD_RESOLUTION = 1536;

export class OceanTestScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: SunRig;
  readonly sky: SkyDome;
  readonly depthField: DepthField;
  readonly ocean: Ocean;
  readonly archipelago: Archipelago;
  readonly shoreAtlas: ShoreAtlas;
  readonly shoreUniforms: ShoreUniforms;
  /** The sea surface the hull floats on. The same four waves the ocean shader draws. */
  readonly waveSurface: WaveSurface;
  /** Fetch field: where the islands are blocking the swell. See ShelterField. */
  readonly shelter: ShelterField;
  readonly seaplane: Seaplane;
  readonly devOverlay = new THREE.Scene();

  private view: OceanViewName = 'cove';
  private time = 0;

  constructor(seaState: SeaStateName = DEFAULT_SEA_STATE) {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 25000);

    this.sky = new SkyDome(this.scene, 10000);
    // SHADOWS ACROSS THE WHOLE TILE, not just the near field.
    //
    // The tile is 8192 m square, so from anywhere sensible in it the far corner is a few
    // kilometres off. At the previous 2500 m the sun simply stopped working partway out:
    // near islands cast, far ones did not, and the boundary sat in open view.
    //
    // 04 §8.2 gives 3 cascades and adds "4 if draw distance grows past ~6 km", which is
    // exactly what this is, so the fourth is the doc's own answer rather than a knob being
    // turned. The trade it asks for is real and worth stating: the outermost cascade covers
    // kilometres on one 1024 map, so distant shadows are blobs rather than shapes. At that
    // range an island's shadow is a few pixels of dark on the sea, which is the read it needs
    // — and the alternative on offer was no shadow there at all.
    // The split scheme has to move with the range, and this is the part that is easy to miss.
    // Reaching further at the default lambda of 0.55 stretches EVERY slice, including the
    // first — the near cascade's texel went from 0.85 m to 1.88 m, so paying for distant
    // shadows would have quietly coarsened the ones under the aircraft. Weighting the split
    // logarithmic instead packs the near slices tight and lets the outermost absorb the rest:
    // texels run about 0.64 m, 1.4 m, 3.1 m, 17 m across the four. The near field ends up
    // FINER than it was before the range was extended.
    this.sun = new SunRig(this.scene, {
      cascades: { cascades: 4, maxDistance: 9000, lambda: 0.85 },
    });

    // Order matters: the archipelago bakes its field first, then the bathymetry is built
    // FROM that mask. One shoreline, two consumers (02b §1.2).
    const islandSeed = Number(new URLSearchParams(window.location.search).get('island') ?? TEST_ISLAND_SEED);
    this.archipelago = new Archipelago(this.scene, {
      seed: Number.isFinite(islandSeed) ? islandSeed : TEST_ISLAND_SEED,
      heroSeed: Number.isFinite(islandSeed) ? islandSeed : TEST_ISLAND_SEED,
      worldSize: WORLD_SIZE,
      resolution: FIELD_RESOLUTION,
      // `ridge` is 03 §16's reference archetype — the Dugi Otok case: one long anticline
      // crest with an elbow, a cliffed windward flank, a terraced sheltered one. The beach is
      // not forced anywhere; it falls out of the drift cell in the concavity of the bend,
      // which is the whole point of §10.
      heroArchetype: 'ridge',
      heroName: 'Punta Severa',
    });
    this.depthField = new DepthField({
      resolution: FIELD_RESOLUTION,
      worldSize: WORLD_SIZE,
      origin: new THREE.Vector2(-WORLD_SIZE / 2, -WORLD_SIZE / 2),
      landAt: this.archipelago.landAt,
      // The bathymetry IS the archipelago's topography now — one surface, land and seabed
      // together. Passing the height as well as the mask is what makes that true rather
      // than approximately true.
      heightAt: this.archipelago.heightAt,
    });
    // 02b §7.1: the shoreline is a post-process stage of the island pipeline. It bakes from
    // the land mask and the bathymetry's depth, so both must already exist.
    this.shoreAtlas = new ShoreAtlas(this.archipelago.field, this.depthField);
    this.shoreUniforms = makeShoreUniforms(this.shoreAtlas);
    this.archipelago.attachShore(this.shoreUniforms);

    this.ocean = new Ocean(this.scene, this.depthField, seaState, this.shoreUniforms);

    // Frame the aerial views from the hero island's actual bounds rather than hardcoded
    // numbers, so re-authoring the spine cannot silently leave the camera pointing at sea.
    const b = this.archipelago.hero.meshInfo.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    // ~1.5 km out at ~600 m altitude. Framing the WHOLE island needs about 2 km at this
    // field of view, which is outside 00 §3 rule 9's 200-1500 m envelope and lands deep in
    // the haze; this trades a little of the tail for a camera the game will actually use.
    VIEWS.island = {
      position: new THREE.Vector3(cx + span * 0.35, span * 0.25, cz + span * 0.45),
      target: new THREE.Vector3(cx, this.archipelago.hero.spec.crestHeight * 0.3, cz),
    };
    const summit = this.archipelago.field.summit;
    VIEWS.profile = {
      position: new THREE.Vector3(summit.x + 260, summit.height * 0.85, summit.z + 620),
      target: new THREE.Vector3(summit.x - 60, summit.height * 0.45, summit.z - 260),
    };
    VIEWS.skim = skimView(seaState, new THREE.Vector3(cx, 0, cz));

    // Point the canopy view at the island's own densest woodland rather than at a hardcoded
    // spot. Re-authoring the spine moves every forest patch, and a fixed camera would end up
    // measuring the Ghibli band on a bare hillside and reporting one tone.
    const wood = densestWoodland(this.archipelago.cover);
    VIEWS.canopy = {
      position: new THREE.Vector3(wood.x + 120, wood.y + 58, wood.z + 175),
      target: new THREE.Vector3(wood.x, wood.y + 6, wood.z),
    };

    // Put the camera on the most exposed stretch of the seaward coast, so the run-up band is
    // at its widest and the foam is being judged where it does the most work.
    const shorePoint = mostExposedShore(this.archipelago.field, this.shoreAtlas);
    // 02b §2.4 splits foam behaviour into three altitude regimes and says individual clumps
    // are only legible as shapes in the "<150 m" one. At 70 m up and 200 m out the run-up band
    // was 3-5 px tall — present and correct, and impossible to judge. This sits in the regime
    // the doc says to judge it in.
    // 62 m out to sea, looking back across the waterline — along the coast's own seaward
    // normal rather than along +Z, so this holds whichever way the chosen stretch faces.
    const seaward = seawardAt(this.archipelago.field, shorePoint.x, shorePoint.z);
    VIEWS.shore = {
      position: new THREE.Vector3(
        shorePoint.x + seaward.x * 62, 22, shorePoint.z + seaward.z * 62,
      ),
      target: new THREE.Vector3(
        shorePoint.x - seaward.x * 14, 1, shorePoint.z - seaward.z * 14,
      ),
    };

    // Re-aim the two water views on the shelf the island actually generated, rather than on a
    // fixed offset from its bounding box. Both frame the same transition — `cove` obliquely,
    // the way the reference frame composes it, and `shelf` near-vertically, which is the one
    // the smoothness probe measures on, because an oblique view foreshortens the band edge.
    const ramp = gentlestShore(this.archipelago.field, this.shoreAtlas);
    const rampOut = seawardAt(this.archipelago.field, ramp.x, ramp.z);
    // The near marker sits just past the surf, the far one where the ramp has run out. Between
    // them is the whole shallow-to-deep event; outside them is beach on one side and flat
    // deep water on the other, and neither says anything about the ramp.
    const near = Math.max(40, offshoreAtDepth(this.archipelago.field, ramp.x, ramp.z, rampOut, 3));
    const far = Math.max(near + 120, offshoreAtDepth(this.archipelago.field, ramp.x, ramp.z, rampOut, 26));
    const at = (d: number, y: number): THREE.Vector3 =>
      new THREE.Vector3(ramp.x + rampOut.x * d, y, ramp.z + rampOut.z * d);
    VIEWS.cove = { position: at(far * 1.9, 200), target: at(near * 0.5, 0) };
    VIEWS.shelf = { position: at(far * 1.25, 340), target: at((near + far) * 0.5, 0) };

    // --- the aircraft --------------------------------------------------------------------
    // The hull floats on the SAME four waves the ocean shader draws — one wave stack, two
    // readers, for the same reason the land mask and the bathymetry share one array.
    this.waveSurface = new WaveSurface(seaState);

    // --- shelter ---------------------------------------------------------------------------
    // Baked from the land mask and the swell's bearing, then handed to all three readers: the
    // ocean material scales its waves by it, the glints thin over it, and the hull floats on
    // it. Built here rather than inside `Ocean` because it needs the islands, which the ocean
    // knows nothing about.
    this.shelter = new ShelterField(this.archipelago.field);
    this.ocean.attachShelter(this.shelter);
    this.waveSurface.shelter = this.shelter;
    this.waveSurface.shelterMin = this.ocean.uniforms.uShelterMin!.value as number;
    this.rebakeShelter();

    const mooring = findMooring(this.archipelago.field, this.shoreAtlas);
    // Nose down the lane, along strike: that is where the open water is, and a seaplane
    // needs a kilometre of it.
    const [strikeX, strikeZ] = this.archipelago.specs[0]!.strike;
    this.seaplane = new Seaplane(this.scene, this.waveSurface, {
      startX: mooring.x,
      startZ: mooring.z,
      heading: Math.atan2(strikeX, strikeZ),
    });

    this.setView('cove');
  }

  get viewName(): OceanViewName {
    return this.view;
  }

  setView(view: OceanViewName): void {
    this.view = view;
    // Only the pilot's seat takes the controls, and only while it is the active view. The
    // keys are the free camera's as well, so leaving the cockpit has to hand them back.
    this.seaplane.input.enabled = view === 'cockpit';
    if (view !== 'cockpit') this.seaplane.input.release();

    // The free camera and the chase boom each own the pose. Refresh the camera-dependent
    // systems — the ocean rings and the sky dome both follow the camera — but do not move it.
    if (view === 'free') {
      this.update(0);
      return;
    }
    if (view === 'cockpit') {
      this.seaplane.driveCamera(this.camera, 0);
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
    // The hull's wave clock and the shader's are the same number by assignment, not by two
    // systems being fed the same delta — which is what stops the aircraft drifting a few
    // centimetres out of the water it is visibly sitting in.
    this.waveSurface.time = this.time;
    if (dt > 0) this.seaplane.update(dt);
    if (this.view === 'cockpit') this.seaplane.driveCamera(this.camera, Math.max(dt, 1e-4));

    this.camera.updateMatrixWorld(true);
    // The shared clock, set here where the world clock already lives.
    globalUniforms.uTime.value = this.time;
    // Cascades are refitted from the camera every frame, BEFORE anything renders: the fit and
    // the sampling both key off the same matrices, so they must not straddle a draw (04 3.1).
    this.sun.update(this.camera);
    this.sky.update(this.camera);
    this.ocean.update(this.camera, this.time);
    updateFoamLOD(this.shoreUniforms, this.camera.position.y);
  }

  /**
   * ONE WAVE STACK, TWO READERS — and both of these have to go through here.
   *
   * The ocean material draws the waves and `WaveSurface` floats the hull on them. They are the
   * same stack read twice, exactly like the wave clock a few lines below, and the same rule
   * applies: assign to both from one place rather than hoping two call sites stay in step. The
   * sea-state dropdown used to call `ocean.applySeaState` alone, which left the aircraft riding
   * whatever swell had been selected previously — a bug that reads as bad physics rather than
   * as a missing line, and therefore one nobody goes looking for in the right place.
   */
  setSeaState(name: SeaStateName): void {
    this.ocean.applySeaState(name);
    this.waveSurface.setState(name, this.ocean.headingOffsetDeg);
    // A sea state resets the heading to its own authored bearing, so the wind shadows move
    // with it and have to be re-cast.
    this.rebakeShelter();
  }

  /** Metres of open water the swell must cross to recover a full sea behind an island. */
  setShelterReach(metres: number): void {
    (this.shelter as { fullFetch: number }).fullFetch = metres;
    this.rebakeShelter();
  }

  /** Compass bearing of the dominant swell. Rotates the whole stack; see Ocean. */
  setWaveHeading(deg: number): void {
    this.ocean.setWaveHeading(deg);
    this.waveSurface.setState(this.ocean.seaStateName, this.ocean.headingOffsetDeg);
    this.rebakeShelter();
  }

  /**
   * Re-cast the wind shadows for the current swell bearing.
   *
   * Every island's lee is on the side the swell is going TOWARD, so turning the swell moves
   * every sheltered patch of water in the tile. A few milliseconds at this resolution, which
   * is why the field is baked at 32 m rather than at the elevation field's 5 m.
   */
  private rebakeShelter(): void {
    const [dx, dz] = swellDirection(SEA_STATES[this.ocean.seaStateName]);
    const a = THREE.MathUtils.degToRad(this.ocean.headingOffsetDeg);
    // The state's authored bearing, turned by however far the heading slider has moved it.
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    this.shelter.bake(dx * cos - dz * sin, dx * sin + dz * cos);
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
