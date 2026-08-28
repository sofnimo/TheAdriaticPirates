import type { IslandSpec } from './IslandSpec';
import { Spine } from './Spine';
import { clamp01, fbm, hash2, lerp, perlin2, ridged, rng, smoothstep, smootherstep, warp2 } from './noise';

/**
 * THE TERRAIN FUNCTION — §2 (footprint), §3 (cliffs), §4 (coves/dolines), §5 (ridges,
 * terraces, poljes) and the shelf that carries all of it into the sea.
 *
 * ONE SIGNED SURFACE. `height` is metres relative to sea level everywhere: positive on land,
 * negative on the seabed, zero exactly at the coastline. There is no separate bathymetry and
 * no join to hide, so the water and the terrain cannot disagree about where the shore is.
 *
 * WHY THE SEABED IS DELIBERATELY BORING. The mesh is trimmed at a depth contour, so the shape
 * of that contour is the shape of the mesh's outer edge. Any noise on the deep shelf turns
 * that contour into a ragged fringe — the row of underwater "teeth" this rebuild exists to
 * remove. So the shelf is a smooth monotone e-fold in offshore distance, and the only
 * roughness allowed on it is gone by `ROUGHNESS_DEPTH`, well above the trim.
 *
 * ORDER OF AUTHORITY, lowest first: shelf, crest, cliff band, terraces, poljes, dolines,
 * beaches. Later stages overwrite earlier ones, which is what makes a beach flat even where
 * the karst put a bench under it, and what lets a doline breach the coast and become a
 * harbour without being a special case anywhere.
 */

export interface TerrainSample {
  /** Signed metres relative to sea level. */
  height: number;
  /** §3.5's dot product: +1 fully windward, -1 fully sheltered. */
  exposure: number;
  /** 0-1 how abruptly the ground rises out of the water here. 1 is sheer. */
  cliffiness: number;
  /** 0-1 how far sand runs up the land here. */
  sandReach: number;
  /** Metres of beach, shore-normal. */
  beachWidth: number;
  /** Metres inland of the coastline. Negative offshore. */
  inland: number;
}

interface Doline {
  x: number;
  z: number;
  radius: number;
  depth: number;
}

interface Polje {
  x: number;
  z: number;
  radius: number;
  floor: number;
}

/** A transverse Voronoi sliver subtracted from the mask — §2.3's bay or channel. */
interface Cut {
  /** Arc position of its centre. */
  at: number;
  /** Metres along the spine it spans. */
  width: number;
  /** 0-1 fraction of the local half-width removed at its deepest. */
  depth: number;
  /** +1, -1, or 0 for a cut that goes right through and severs the island. */
  side: number;
}

export interface FeatureSet {
  readonly cuts: readonly Cut[];
  readonly dolines: readonly Doline[];
  readonly poljes: readonly Polje[];
  /** Metres of beach at each of 64 stations along the spine, per flank. */
  readonly beachWindward: Float32Array;
  readonly beachLeeward: Float32Array;
}

const BEACH_STATIONS = 64;
/** §10.2's ceiling on a deposited beach. The shader multiplies by it to get metres back. */
export const BEACH_WIDTH_MAX = 120;
/** Metres of gentle sand slope per metre of run. A beach is nearly, but not quite, flat. */
const BEACH_GRADIENT = 0.07;

/**
 * Metres of sea over which an island's own shelf still shapes the seabed. Past it the surface
 * is the channel floor and nothing else, which is what lets the raster evaluate each island
 * inside a finite box.
 */
export const SHELF_REACH = 1400;
/**
 * The lane floor between islands, and the depth every shelf resolves to at `SHELF_REACH`.
 *
 * One number shared by the terrain function and the field's initial fill. If they ever
 * disagreed, every island would sit in a rectangular pit or on a rectangular plateau the exact
 * size of its affect box.
 */
export const CHANNEL_FLOOR = 120;
/** Depth by which nearshore roughness has faded to nothing. Far above the mesh trim. */
const ROUGHNESS_DEPTH = 25;
/** Metres offshore a beach's own gentle ramp reaches before the shelf takes over. */
const SAND_APRON = 90;

/**
 * §13.3: the non-local decisions are made ONCE, for the whole island, before any texel is
 * sampled. Littoral drift walks the coastline and dolines have to know about each other; both
 * produce mush if they are re-derived per sample from local noise.
 */
export function buildFeatures(spec: IslandSpec, spine: Spine): FeatureSet {
  const r = rng(hash2(spec.seed, 0xfea7));

  // ---- §2.3: transverse cuts ------------------------------------------------------------
  // Poisson-ish along the arc rather than uniform random, so two bays never land on top of
  // each other and leave one flank untouched.
  const cuts: Cut[] = [];
  const minGap = 1 / Math.max(1, spec.cutCount + 1);
  let cursor = minGap * 0.5;
  for (let i = 0; i < spec.cutCount; i++) {
    cursor += minGap * lerp(0.7, 1.35, r());
    if (cursor >= 1) break;
    const roll = r();
    cuts.push({
      at: cursor,
      width: spec.cutWidth * lerp(0.6, 1.5, r()),
      depth: spec.cutDepth * lerp(0.55, 1, r()),
      // One cut in six goes right through: that is a channel, and channels between islands
      // are what makes a Dalmatian chain read as a chain rather than as a row of blobs.
      side: roll < 0.16 ? 0 : roll < 0.58 ? 1 : -1,
    });
  }

  // ---- §4.2 / §5.4: karst hollows --------------------------------------------------------
  const dolines: Doline[] = [];
  for (let i = 0; i < spec.dolineCount; i++) {
    const t = r();
    const node = spine.nodes[Math.min(spine.nodes.length - 1, Math.floor(t * spine.nodes.length))]!;
    const side = r() < 0.5 ? 1 : -1;
    const halfWidth = side > 0 ? spec.halfWidthWindward : spec.halfWidthLeeward;
    // Placed along the cross-spine bearing at a random fraction of the flank, so they land on
    // the ground rather than in the sea; the ones that fall near the coast are the ones that
    // breach it and become §4.2's circular harbours.
    const q = lerp(0.15, 0.95, r()) * halfWidth * side;
    dolines.push({
      x: node.x - node.tz * q,
      z: node.z + node.tx * q,
      radius: spec.dolineRadius * lerp(0.5, 1.4, r()),
      depth: spec.dolineDepth * lerp(0.6, 1.35, r()),
    });
  }

  const poljes: Polje[] = [];
  for (let i = 0; i < spec.poljeCount; i++) {
    const t = lerp(0.25, 0.75, r());
    const node = spine.nodes[Math.min(spine.nodes.length - 1, Math.floor(t * spine.nodes.length))]!;
    // Inland and on the sheltered side: a polje is a closed basin, not a coastal feature.
    const q = -lerp(0.2, 0.6, r()) * spec.halfWidthLeeward;
    poljes.push({
      x: node.x - node.tz * q,
      z: node.z + node.tx * q,
      radius: lerp(0.35, 0.6, r()) * spec.halfWidthLeeward,
      floor: spec.crestHeight * lerp(0.14, 0.3, r()),
    });
  }

  // ---- §10: littoral drift ---------------------------------------------------------------
  // Sediment is not sprinkled along the coast, it is TRANSPORTED along it and dropped where
  // the coast turns away from the drift. So the budget is integrated station by station in one
  // direction and released into the concavities, which is why this is a walk and not a noise
  // lookup: a beach ends up in the lee of a headland because the headland is upstream of it.
  const beachWindward = new Float32Array(BEACH_STATIONS);
  const beachLeeward = new Float32Array(BEACH_STATIONS);
  const drift = r() < 0.5 ? 1 : -1;
  for (const [flank, out] of [[1, beachWindward], [-1, beachLeeward]] as const) {
    let carried = 0;
    for (let k = 0; k < BEACH_STATIONS; k++) {
      const i = drift > 0 ? k : BEACH_STATIONS - 1 - k;
      const t = (i + 0.5) / BEACH_STATIONS;
      const node = spine.nodes[Math.min(spine.nodes.length - 1, Math.round(t * (spine.nodes.length - 1)))]!;
      // Curvature of the coast, approximated from the spine's own turning: positive where the
      // coast is concave to this flank, which is where a bay is and where sediment settles.
      const ahead = spine.nodes[Math.min(spine.nodes.length - 1, Math.round(t * (spine.nodes.length - 1)) + 4)]!;
      const turn = (node.tx * ahead.tz - node.tz * ahead.tx) * flank;

      carried += spec.sedimentSupply * 2.2;
      // The windward flank is swept: the same swell that cliffs it also carries its sand away.
      const retention = clamp01((flank > 0 ? 0.18 : 0.72) + turn * 6);
      const dropped = carried * retention;
      carried -= dropped;
      out[i] = Math.min(BEACH_WIDTH_MAX, dropped * 5.5);
    }
    // The walk drops a variable fraction of the load at each station, so neighbouring stations
    // can differ by most of a beach. A real drift cell does not deposit a 60 m beach against a
    // bare headland one station along; it thins out. Smoothing here rather than damping the
    // walk keeps the walk's directionality — the reason a beach sits in the lee of a headland
    // and not on it — while making the width a gradual function of position, which everything
    // reading the table downstream assumes.
    smoothTable(out);
  }

  return { cuts, dolines, poljes, beachWindward, beachLeeward };
}

/** Two passes of a 5-tap box over a station table, clamped at the ends. */
function smoothTable(table: Float32Array): void {
  const tmp = new Float32Array(table.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < table.length; i++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) {
        sum += table[Math.max(0, Math.min(table.length - 1, i + k))]!;
      }
      tmp[i] = sum / 5;
    }
    table.set(tmp);
  }
}

/** §5.3's riser/tread profile. `sharpness` 1 is a square step, 0 is no terracing at all. */
function terrace(h: number, step: number, sharpness: number): number {
  const stepped = Math.floor(h / step) * step;
  const f = (h - stepped) / step;
  const soft = 1 - clamp01(sharpness);
  return stepped + smoothstep(0, Math.max(soft, 0.02), f) * step;
}

/**
 * Width envelope along the arc: full beam over the plateau, tapering to a point at both
 * termini.
 *
 * NO FRACTIONAL POWER. `pow(smootherstep(...), 0.75)` gives a sharper-looking point, and its
 * derivative at the tip is infinite: `d(pow(x, 0.75))/dx = 0.75·x^-0.25`. The half-width then
 * changes by tens of metres across one texel at each terminus, which the raster resolves as a
 * spike of land — a tooth, at both ends of every island in the tile. Linear into the tip keeps
 * the terminus POINTED, which is what §2.3 actually asks for, with a finite slope; the
 * smoothstep term is blended in only to ease the join where the beam reaches full width.
 */
function widthTaper(t: number, plateau: number): number {
  const e = Math.min(t, 1 - t) * 2;
  const k = clamp01(e / Math.max(0.08, 1 - plateau));
  return k * 0.65 + k * k * (3 - 2 * k) * 0.35;
}

/** Crest envelope with the summit pushed off-centre. Power 1, for the reason above. */
function crestEnvelope(t: number, skew: number): number {
  const k = clamp01(skew) || 0.5;
  const tt = t < k ? (0.5 * t) / k : 0.5 + (0.5 * (t - k)) / Math.max(1e-3, 1 - k);
  return Math.sin(Math.PI * clamp01(tt));
}

function beachAt(table: Float32Array, t: number): number {
  const f = clamp01(t) * (BEACH_STATIONS - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(BEACH_STATIONS - 1, i0 + 1);
  return lerp(table[i0]!, table[i1]!, f - i0);
}

/**
 * Evaluate one island at one world point.
 *
 * Called once per texel per island by the raster pass and nowhere else — everything downstream
 * reads the baked arrays. It is written to be cheap in that loop rather than pretty: no
 * allocation, no closures, and the expensive stages (the warp, the spine query) happen once.
 */
export function sampleTerrain(
  spec: IslandSpec, spine: Spine, features: FeatureSet,
  x: number, z: number, out: TerrainSample,
): TerrainSample {
  // ---- §2.2: domain warp, applied to the SAMPLE POINT before the mask is evaluated --------
  //
  // THE WARP IS FADED OUT OFFSHORE, AND THAT IS A PERFORMANCE DECISION MADE SAFE.
  //
  // `warp2` is by far the most expensive thing in this function — four 3-octave fbm sums, each
  // eight hashes per octave — and the overwhelming majority of the texels in an island's
  // affect box are open water hundreds of metres out, where the coastline's shape is not being
  // decided and a warped coordinate buys nothing. So the amplitude is faded to zero with
  // distance from the spine and the call is skipped entirely once it reaches zero. Fading
  // rather than switching is what keeps this an optimisation instead of a seam: at zero
  // amplitude `warp2` IS the identity, so the two branches agree exactly where they meet.
  //
  // The unwarped query is what decides which branch to take, and it is a valid decision
  // because the warp displaces a point by at most its amplitude — the band below is wider
  // than that, so nothing inside the coastal zone can be missed by testing outside it.
  const probe = spine.nearest(x, z);
  const reach = Math.max(spec.halfWidthWindward, spec.halfWidthLeeward) + spec.coastWarpAmp;
  const detail = 1 - smoothstep(reach + 300, reach + 700, probe.dist);

  let hit = probe;
  let wx = x;
  let wz = z;
  if (detail > 0) {
    [wx, wz] = warp2(x, z, spec.seed ^ 0x51, spec.coastWarpScale, spec.coastWarpAmp * detail);
    hit = spine.nearest(wx, wz);
  }
  const t = hit.t;

  // §3.5's exposure is the cross-spine bearing dotted with the open-sea vector. Taken from the
  // UNWARPED point against the spine node so it describes which way the flank faces, not which
  // way the noise happened to push this texel.
  // EVERY PER-FLANK QUANTITY IS A BLEND, NOT A BRANCH, AND THE BLEND IS MEASURED IN METRES.
  //
  // The cross-spine offset passes through zero along the spine's own axis, and that axis
  // continues past both termini into open water. Picking the windward or the leeward value on
  // the SIGN of it puts a discontinuity along the whole of that line: the half-width jumps by
  // hundreds of metres at each end of the island — a notch in the coastline and a fold in the
  // seabed running off both tips.
  //
  // Blending fixes that, but only if the blend variable has a bounded spatial gradient. The
  // obvious choice, the cosine of the bearing, does not: a normalised direction changes at
  // 1/r, so just off a terminus — where r is a few metres — the transition collapses to two
  // texels wide and everything keyed on it switches almost discontinuously. The shelf's
  // e-folding distance differs by a factor of two between the flanks, so that showed up as a
  // 35 m crease in the seabed running off each tip. Signed METRES across the spine has a
  // gradient of 1 everywhere, tip included.
  const bx = x - hit.nx;
  const bz = z - hit.nz;
  const across = bx * spec.exposure[0] + bz * spec.exposure[1];
  const band = Math.max(60, (spec.halfWidthWindward + spec.halfWidthLeeward) * 0.2);
  const w = smootherstep(-band, band, across);
  out.exposure = w * 2 - 1;

  // ---- §2.1 / §2.3: the mask -------------------------------------------------------------
  let halfWidth = lerp(spec.halfWidthLeeward, spec.halfWidthWindward, w) * widthTaper(t, spec.widthPlateau);
  // Fine coastal wander, as a perturbation of the RADIUS. The warp handles everything at cape
  // and bay scale and is amplitude-limited so it cannot fold; detail below that scale is added
  // here, where there is no coordinate map to fold in the first place. Gated by the same fade
  // as the warp — offshore it changes nothing and is not worth three octaves to compute.
  if (detail > 0) {
    halfWidth *= 1 + spec.coastDetail * detail * fbm(x, z, spec.seed ^ 0x9c, spec.coastDetailScale, 3);
  }
  // The DEEPEST cut, not the product of all of them. A product compounds: three cuts of 0.7
  // overlapping at one station leave 2.7% of the width, and the island pinches to a thread
  // wherever two bays are within a width of each other.
  let bite = 0;
  for (const cut of features.cuts) {
    const along = (t - cut.at) * spec.lengthM;
    const g = Math.exp(-(along * along) / (cut.width * cut.width));
    if (g < 0.004) continue;
    // A one-sided cut is a bay; a through cut is a channel and takes both flanks.
    const reach = cut.side === 0 ? 1 : cut.side > 0 ? w : 1 - w;
    const v = cut.depth * g * reach;
    if (v > bite) bite = v;
  }
  // No floor. A floor here is a filament of land the mask cannot get rid of: where a cut takes
  // most of the width, `max(halfWidth, 3)` leaves a 3 m ribbon that the profile below then
  // raises to the full crest height, because the profile is a function of `inland / halfWidth`
  // and a 3 m half-width reaches u = 1 in three metres. That is a 100 m needle standing in the
  // sea — one of the "teeth". Letting the width reach zero simply removes the land.
  halfWidth *= 1 - bite;

  const inland = halfWidth - hit.dist;
  out.inland = inland;

  const beachWidth = lerp(beachAt(features.beachLeeward, t), beachAt(features.beachWindward, t), w);
  const sandReach = smoothstep(4, 26, beachWidth);
  out.beachWidth = beachWidth;
  out.sandReach = sandReach;

  if (inland <= 0) {
    // ---- the shelf ------------------------------------------------------------------------
    const offshore = -inland;
    const shelf = lerp(spec.shelfLeeward, spec.shelfWindward, w);
    let h = -spec.abyssDepth * (1 - Math.exp(-offshore / shelf));
    // A beach continues under the water. Without this the ground drops away at the waterline
    // and every swell trough exposes the shelf's own colour instead of wet sand.
    //
    // BOUNDED TO THE NEARSHORE, and that bound is doing two jobs. A sand ramp is a feature of
    // the first hundred metres or so of water; unbounded, a 0.045 gradient was still holding
    // the seabed at 13 m where the shelf wanted 71, three hundred metres out — a shallow apron
    // the size of the island. And because its weight comes from the beach table, which is
    // keyed on arc position, an unbounded apron carries any jump in arc position out into open
    // water with it, turning a nearest-node tie into a six-metre cliff on the seabed.
    const apron = sandReach * (1 - smoothstep(SAND_APRON, SAND_APRON * 2.2, offshore));
    const sandy = -offshore * 0.045;
    h = lerp(h, Math.max(h, sandy), apron);
    // Past its own shelf the seabed descends to the channel floor the whole tile shares. Not
    // cosmetic: the raster only evaluates an island inside a finite box, so a shelf that
    // levelled off at its own abyss depth would leave a rectangular step of tens of metres
    // at the box edge, where the composite falls back to the floor.
    h = lerp(h, -CHANNEL_FLOOR, smoothstep(Math.min(shelf * 3, SHELF_REACH * 0.5), SHELF_REACH, offshore));
    // Nearshore roughness, faded out by DEPTH rather than by distance from the coast. The
    // mesh is trimmed on a depth contour, so it is depth that has to be clean for the trim to
    // follow a smooth curve — a distance fade leaves roughness on the contour wherever the
    // shelf happens to be steep, and roughness on the trim contour is the row of underwater
    // teeth this rebuild exists to remove.
    if (h > -ROUGHNESS_DEPTH) {
      h += fbm(x, z, spec.seed ^ 0x33, 64, 3) * 2.4 * (1 - smoothstep(6, ROUGHNESS_DEPTH, -h));
    }
    out.height = Math.min(h, -1e-4);
    out.cliffiness = 0;
    return out;
  }

  // ---- §5.1: the crest -------------------------------------------------------------------
  const u = clamp01(inland / Math.max(halfWidth, 1e-3));
  const ridge = ridged(wx, wz, spec.seed ^ 0x71, spec.ridgeScale, 4, spec.ridgeSharpness);
  // The ridged field BREAKS the crest into secondary tops; it does not decide how high the
  // island is. Left unclamped its multiplier ran 0.45-1.8, so the summit was wherever the
  // noise peaked and the authored crest height meant nothing — and neighbouring tops differed
  // by 50%, which reads as lumps rather than as a ridge with cols in it.
  const broken = clamp01(0.62 + ridge * 0.62);
  // WIDTH BOUNDS HEIGHT, everywhere and not only at the termini.
  //
  // The profile below is a function of `inland / halfWidth`, so it reaches full crest height
  // at the spine WHATEVER the local width is. Left alone, every station a cut has narrowed —
  // the throat of a bay, a spit between two coves, the tapering last hundred metres of a
  // terminus — carries the same summit as the middle of the island, standing on a base a few
  // metres across. The generator's own flank gradient is the honest bound: a station only
  // gets the height its width can hold at the slope this archetype builds at.
  const gradient = spec.crestHeight / Math.max(1, spec.halfWidthWindward);
  const peak = Math.min(
    spec.crestHeight * crestEnvelope(t, spec.crestSkew) * lerp(1, broken, spec.crestNoise),
    halfWidth * gradient,
  );

  // ---- §3.3: the cliff band ---------------------------------------------------------------
  // Most of the elevation is gained in the first `run` of the flank on the windward side and
  // spread across the whole flank on the sheltered one. That single asymmetry is what §3.5
  // calls the most important cliff rule, and it is one lerp.
  const run = lerp(spec.cliffRunLeeward, spec.cliffRunWindward, w);
  const share = lerp(spec.cliffShareLeeward, spec.cliffShareWindward, w);
  const cliffPart = smootherstep(0, run, u);
  const slopePart = smootherstep(run * 0.8, 1, u);
  let h = peak * (share * cliffPart + (1 - share) * slopePart);

  // Shape-scale relief on the flank, off the coast so the waterline stays a clean contour.
  h += peak * 0.07 * fbm(x, z, spec.seed ^ 0x19, 130, 4) * smoothstep(0, 0.18, u);

  out.cliffiness = clamp01(share * (1 - smoothstep(run * 0.6, run * 2.2, u))) * (1 - sandReach);

  // ---- §5.3: terraces on the sheltered flank ---------------------------------------------
  if (w < 0.95 && spec.terraceAmount > 0.01) {
    // Gated to the mid-flank: §5.3 puts terraces on 5–25° ground only. Steeper is left as
    // scrub and rock, flatter needs no terracing, and the crest is nobody's olive grove.
    const gate =
      spec.terraceAmount * (1 - w) *
      smoothstep(0.14, 0.32, u) *
      (1 - smoothstep(0.58, 0.84, u)) *
      clamp01(0.5 + 0.5 * perlin2(x / 260, z / 260, spec.seed ^ 0x2b));
    if (gate > 0.01) h = lerp(h, terrace(h, spec.terraceStep, spec.terraceSharpness), gate);
  }

  // ---- §5.4: poljes -----------------------------------------------------------------------
  for (const p of features.poljes) {
    const d = Math.hypot(x - p.x, z - p.z);
    const inside = 1 - smoothstep(p.radius * 0.55, p.radius, d);
    if (inside > 0.001) h = lerp(h, Math.min(h, p.floor), inside);
  }

  // ---- §4.2: dolines ----------------------------------------------------------------------
  for (const d of features.dolines) {
    const dist = Math.hypot(x - d.x, z - d.z);
    if (dist > d.radius * 2) continue;
    const g = Math.exp(-(dist * dist) / (d.radius * d.radius * 0.42));
    h -= d.depth * g;
  }

  // ---- §10: the beach, composited over everything above ----------------------------------
  if (beachWidth > 1) {
    const flat = inland * BEACH_GRADIENT;
    const k = sandReach * (1 - smoothstep(beachWidth * 0.55, beachWidth * 1.5, inland));
    h = lerp(h, Math.min(h, flat), k);
  }

  out.height = h;
  return out;
}
