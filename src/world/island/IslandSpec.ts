import { hash2, lerp, rng } from './noise';

/**
 * THE ISLAND DESCRIPTOR — `03 — Procedural Islands.md` §2.4.
 *
 * "Store each island as a lightweight descriptor object so far islands can exist as DATA ONLY
 * until the streaming radius reaches them." Everything the generator does is a function of
 * this object plus world XZ; nothing downstream is allowed to hold generator state that is not
 * derivable from it.
 *
 * The parameters are geological, not artistic. §0 gives the three properties a Dalmatian
 * island has to have, and each one names its own field here:
 *
 *   §0.1 ANISOTROPIC FOOTPRINT — `spine`, `strike`, `lengthM`, the two half-widths. The
 *        island is a drowned anticline crest, so it is built around a skeleton curve and
 *        never around a distance-from-centre falloff.
 *   §0.2 ASYMMETRIC CROSS-SECTION — `exposure` plus the windward/leeward pairs. The SW flank
 *        faces the open sea and the bora; it is cliffed. The NE flank is sheltered and
 *        terraced. §3.5 calls this "the single most important cliff rule".
 *   §0.3 KARST HYDROLOGY — `dolineCount`, `poljeCount`, and the absence of any river field.
 *        Limestone swallows its rainfall; surface drainage is the exception, not the default.
 */

/** NW–SE, the Dinaric strike the whole archipelago is folded along. §2.1. */
export const STRIKE_ANGLE = -0.62;

/** The seed the test scene and the acceptance gate both default to. */
export const TEST_ISLAND_SEED = 20250825;

export type Archetype =
  /** The reference case: one long anticline crest, cliffed seaward, terraced landward. */
  | 'ridge'
  /** Lower and broader — a karst plateau with a bench series rather than a sharp crest. */
  | 'plateau'
  /** Two parallel crests with a drowned syncline between them, joined at one end. */
  | 'twin'
  /** A rock. Barely above water, no cover, no features. */
  | 'islet';

export interface IslandSpec {
  readonly name: string;
  readonly seed: number;
  readonly archetype: Archetype;

  /* -------------------------------------------------------------------- skeleton */
  /** Catmull-Rom control points in world XZ. §2.1: draw the skeleton first, then fill. */
  readonly spine: ReadonlyArray<readonly [number, number]>;
  /** Unit vector along the dominant axis. */
  readonly strike: readonly [number, number];
  /** Unit cross-strike vector pointing at the open sea — the bora/maestral fetch. §3.5. */
  readonly exposure: readonly [number, number];
  readonly lengthM: number;
  /** Metres from the spine to the coast, at the widest station, per flank. */
  readonly halfWidthWindward: number;
  readonly halfWidthLeeward: number;
  /** 0-1. How much of the length carries full width before the termini taper in. */
  readonly widthPlateau: number;

  /* ------------------------------------------------------------------ elevation */
  readonly crestHeight: number;
  /** Arc position 0-1 of the summit. Off-centre, or every island peaks in the middle. */
  readonly crestSkew: number;
  /** 0-1 how much of the crest is broken into secondary tops by the ridged field. §5.1. */
  readonly crestNoise: number;
  readonly ridgeScale: number;
  readonly ridgeSharpness: number;

  /* ---------------------------------------------------------------------- coast */
  /** Metres the domain warp displaces the mask by. §2.2. Bounded by `coastWarpScale`. */
  readonly coastWarpAmp: number;
  /**
   * Metres per period of the warp.
   *
   * Not independent of the amplitude: a warp displacing the plane by more than about a tenth
   * of its own wavelength folds it (see `warp2`). The generator picks the wavelength first and
   * takes the amplitude as a fraction of it, which is the only ordering that makes the
   * relationship impossible to violate by editing one number.
   */
  readonly coastWarpScale: number;
  /**
   * 0-1 fine wander of the coastline, applied to the mask RADIUS rather than to the domain.
   *
   * The warp gives broad capes and bays and cannot be pushed further without folding. Detail
   * finer than that is added here instead, because perturbing the half-width is a change of
   * value and not a change of coordinates: it has no Jacobian and therefore cannot tear the
   * outline however sharp it is made.
   */
  readonly coastDetail: number;
  readonly coastDetailScale: number;
  /** Transverse Voronoi slivers subtracted from the mask — bays and channels. §2.3. */
  readonly cutCount: number;
  /** 0-1 fraction of the local half-width a cut removes at its deepest. */
  readonly cutDepth: number;
  /** Metres along the spine a cut spans. */
  readonly cutWidth: number;

  /* --------------------------------------------------------------------- cliffs */
  /** 0-1 fraction of the flank's run over which the cliff band gains its height. §3.3. */
  readonly cliffRunWindward: number;
  readonly cliffRunLeeward: number;
  /** 0-1 fraction of the crest height gained inside that band. */
  readonly cliffShareWindward: number;
  readonly cliffShareLeeward: number;

  /* ------------------------------------------------------------------ terracing */
  /** Metres per cultivation step on the sheltered flank. §5.3: dry-stone terrace scale. */
  readonly terraceStep: number;
  /** 0-1 how square the riser is. */
  readonly terraceSharpness: number;
  /** 0-1 how much of the sheltered flank is terraced at all. */
  readonly terraceAmount: number;

  /* ---------------------------------------------------------------------- karst */
  /** Collapsed dolines. §4.2 — some breach the sea and become circular harbours. */
  readonly dolineCount: number;
  readonly dolineRadius: number;
  readonly dolineDepth: number;
  /** Broad flat-floored closed basins. §5.4. 0 or 1 on all but the largest islands. */
  readonly poljeCount: number;

  /* ---------------------------------------------------------------- bathymetry */
  /** Metres offshore over which the shelf e-folds toward the abyss, per flank. */
  readonly shelfWindward: number;
  readonly shelfLeeward: number;
  readonly abyssDepth: number;
  /** 0-1 littoral sediment budget. Drives how much of the sheltered coast gets a beach. */
  readonly sedimentSupply: number;
}

/**
 * A pronounceable Dalmatian-ish name from a seed.
 *
 * Cosmetic, but the debug UI and the scene graph both list islands by name, and "Island 3f2a"
 * eleven times over is unreadable in exactly the place a name is useful.
 */
export function hashName(seed: number): string {
  const roots = ['Sveti', 'Mali', 'Veli', 'Donji', 'Gornji', 'Rt', 'Punta'];
  const stems = ['Kamen', 'Lovran', 'Brusnik', 'Zaglav', 'Mrduja', 'Vela', 'Provica', 'Kobrava', 'Sestrica', 'Galijola'];
  const a = hash2(seed, 0xa11) % roots.length;
  const b = hash2(seed, 0xb22) % stems.length;
  return roots[a] + ' ' + stems[b];
}

export interface SpecOptions {
  readonly name?: string;
  readonly archetype?: Archetype;
  /** Spine midpoint in world XZ. */
  readonly centre?: readonly [number, number];
  /** Overrides the length the archetype would have picked. */
  readonly lengthM?: number;
  /** Rotates this island off the global strike, in radians. §2.1's per-island perturbation. */
  readonly strikeJitter?: number;
}

interface ArchetypeBlock {
  readonly lengthM: readonly [number, number];
  readonly widthRatio: readonly [number, number];
  /**
   * Crest height as a multiple of the WINDWARD half-width — the mean gradient of the steep
   * flank, near enough.
   *
   * Height is a function of width and not of length, which is the whole difference between an
   * island and a mountain. Scaling height with length gives a 7 km island a 430 m peak on a
   * 360 m flank: a 50-degree average slope from waterline to summit, with the cliff band
   * inside it steeper still. Real Dalmatian islands are long and LOW — Dugi Otok is 44 km of
   * ridge topping out at 338 m — because the fold they are the crest of is wide, not tall.
   */
  readonly flankGradient: readonly [number, number];
  readonly cliffShareWindward: readonly [number, number];
  readonly terraceAmount: readonly [number, number];
  readonly crestNoise: readonly [number, number];
  readonly dolinesPerKm: number;
  readonly poljePerKm: number;
}

/** Metres. Nothing in the Adriatic chain is taller, and the flight camera assumes it. */
const MAX_CREST = 480;
/**
 * Metres of sea beyond the coast that the spine's medial axis must stay clear of.
 *
 * Set from where the seabed stops caring: by this distance the shelf has most of the way to
 * the channel floor and a discontinuity in it is both small and deep. Inside it — the land,
 * the beaches, the nearshore the aircraft lands on — arc position has to be continuous.
 */
const MEDIAL_CLEARANCE = 560;

/**
 * §16's archetype blocks, reduced to the four the generator actually distinguishes.
 *
 * They differ by PROPORTION, not by pipeline: every archetype runs the same skeleton, warp,
 * cut, crest and karst stages. A plateau is a ridge with a low height-per-kilometre and a
 * shallow cliff share; an islet is a ridge 200 m long. Branching the pipeline per archetype
 * is how a generator ends up with four codebases and four sets of bugs.
 */
const ARCHETYPES: Record<Archetype, ArchetypeBlock> = {
  ridge: {
    lengthM: [2800, 4800], widthRatio: [0.18, 0.28], flankGradient: [0.34, 0.52],
    cliffShareWindward: [0.5, 0.66], terraceAmount: [0.45, 0.8], crestNoise: [0.22, 0.38],
    dolinesPerKm: 1.6, poljePerKm: 0.18,
  },
  plateau: {
    lengthM: [1600, 2800], widthRatio: [0.26, 0.36], flankGradient: [0.14, 0.24],
    cliffShareWindward: [0.62, 0.78], terraceAmount: [0.5, 0.85], crestNoise: [0.1, 0.2],
    dolinesPerKm: 2.4, poljePerKm: 0.5,
  },
  twin: {
    lengthM: [2000, 3400], widthRatio: [0.22, 0.32], flankGradient: [0.26, 0.42],
    cliffShareWindward: [0.48, 0.62], terraceAmount: [0.4, 0.7], crestNoise: [0.26, 0.42],
    dolinesPerKm: 1.4, poljePerKm: 0.1,
  },
  islet: {
    lengthM: [180, 620], widthRatio: [0.3, 0.5], flankGradient: [0.5, 0.95],
    cliffShareWindward: [0.7, 0.85], terraceAmount: [0, 0.1], crestNoise: [0.1, 0.3],
    dolinesPerKm: 0, poljePerKm: 0,
  },
};

/**
 * Build one island from a seed.
 *
 * The spine is 5 control points laid along the strike with a lateral wander, rather than a
 * straight line with noise added later: §2.1 wants the BEND to be a structural fact the rest
 * of the pipeline can consult (the concavity of a bend is where sediment collects and where
 * the sheltered bay is), and a bend that only exists after domain warping is not consultable.
 */
export function generateIslandSpec(seed: number, options: SpecOptions = {}): IslandSpec {
  const r = rng(hash2(seed, 0x5eed));
  const pick = (range: readonly [number, number]): number => lerp(range[0], range[1], r());

  const archetype = options.archetype ?? 'ridge';
  const block = ARCHETYPES[archetype];

  const lengthM = options.lengthM ?? pick(block.lengthM);
  const widthRatio = pick(block.widthRatio);
  const meanHalfWidth = (lengthM * widthRatio) / 2;

  // §0.2: the sheltered flank is the broader one — a steep cliff eats width, a terraced
  // slope spends it. Asymmetry in plan follows asymmetry in section; it is the same fact.
  const asymmetry = lerp(0.55, 0.8, r());
  const halfWidthWindward = meanHalfWidth * asymmetry;
  const halfWidthLeeward = meanHalfWidth * (2 - asymmetry);

  const angle = STRIKE_ANGLE + (options.strikeJitter ?? (r() - 0.5) * 0.26);
  const sx = Math.cos(angle);
  const sz = Math.sin(angle);
  // The cross-strike normal, pointing SW into the open Adriatic. §3.5's exposure vector.
  const ex = sz;
  const ez = -sx;

  const [cx, cz] = options.centre ?? [0, 0];

  // THE SPINE'S CURVATURE IS BOUNDED BY THE ISLAND'S OWN REACH, and this is a correctness
  // constraint rather than a stylistic one.
  //
  // Every downstream quantity is looked up by arc position on the nearest point of this curve.
  // On the concave side of a bend, the set of points equidistant from two parts of the curve —
  // its medial axis — sits roughly one radius of curvature out, and arc position is genuinely
  // DISCONTINUOUS across it: the nearest point leaps from one arm to the other. Nothing
  // downstream can smooth that away, because the jump is in the query, not in the answer.
  //
  // So the curve is kept straight enough that its medial axis lies outside the region anything
  // is evaluated in. For a lateral deviation A over a wavelength L the radius of curvature is
  // about L^2 / (4 pi^2 A), so bounding the radius bounds A. Small islets come out nearly
  // straight, which is what small islets are; only islands long enough to bend without folding
  // their own coordinate system get to bend. Before this, a 353 m islet with a 50 m elbow put
  // its medial axis 140 m out and wore a 35 m step in the seabed along the whole line.
  // The factor of two over the textbook `L^2 / (4 pi^2 A)` is deliberate. That expression is
  // the radius of a full sinusoid; the elbow below is a half sine over the length, whose peak
  // curvature is tighter, and the second-order wander adds more on top. Sizing exactly to the
  // clearance left the largest islands sitting right on the limit — their medial axis landed
  // a few metres outside the coast and drew a 29 m step across the shelf.
  const reachOut = Math.max(halfWidthWindward, halfWidthLeeward) + MEDIAL_CLEARANCE;
  const curveLimit = (wavelength: number): number =>
    (wavelength * wavelength) / (8 * Math.PI * Math.PI * reachOut);

  const N = 5;
  const segment = lengthM / (N - 1);
  const bend = (r() - 0.5) * 2 * Math.min(meanHalfWidth * 0.9, curveLimit(lengthM));
  const wander = Math.min(meanHalfWidth * 0.35, curveLimit(segment));
  const bendAt = lerp(0.3, 0.7, r());
  const spine: Array<readonly [number, number]> = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const along = (t - 0.5) * lengthM;
    // One dominant elbow plus a small second-order wander, so the curve is not a parabola.
    const lateral =
      bend * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - bendAt + 0.5)))) +
      (r() - 0.5) * wander;
    spine.push([cx + sx * along + ex * lateral, cz + sz * along + ez * lateral]);
  }

  const km = lengthM / 1000;
  const crestHeight = Math.min(MAX_CREST, Math.max(6, halfWidthWindward * pick(block.flankGradient)));

  // Wavelength first, then the displacement as a fraction of it — see `coastWarpScale`. The
  // fraction tops out below `warp2`'s own ceiling, so the clamp there stays a guard rather
  // than quietly becoming the thing that decides how warped every island is.
  const coastWarpScale = meanHalfWidth * lerp(3, 4.6, r());
  const coastWarpAmp = coastWarpScale * lerp(0.055, 0.085, r());

  return {
    name: options.name ?? 'Island ' + (seed >>> 0).toString(36),
    seed,
    archetype,
    spine,
    strike: [sx, sz],
    exposure: [ex, ez],
    lengthM,
    halfWidthWindward,
    halfWidthLeeward,
    widthPlateau: lerp(0.35, 0.62, r()),

    crestHeight,
    crestSkew: lerp(0.32, 0.68, r()),
    crestNoise: pick(block.crestNoise),
    ridgeScale: lerp(0.18, 0.3, r()) * lengthM,
    ridgeSharpness: lerp(0.8, 1.5, r()),

    // Warp amplitude scales with the island, not with the world: a 60 m headland on a 6 km
    // island is a cape, and the same 60 m on a 300 m islet is the whole rock.
    coastWarpAmp,
    coastWarpScale,
    coastDetail: lerp(0.06, 0.12, r()),
    coastDetailScale: meanHalfWidth * lerp(0.45, 0.8, r()),
    // SPARSE, and the two numbers are coupled. §2.3 wants slivers carved off the mask, not a
    // scalloped edge: a cut's Gaussian has to die out well before the next cut's begins, or
    // every station on the island sits inside two or three of them at once and the width
    // collapses to a worm. Count and width are chosen so the spacing is several times the
    // width; `topography` then takes the deepest cut rather than multiplying them.
    cutCount: archetype === 'islet' ? 0 : Math.round(lerp(3, 7, r())),
    cutDepth: lerp(0.45, 0.85, r()),
    cutWidth: lengthM * lerp(0.012, 0.03, r()),

    cliffRunWindward: lerp(0.1, 0.18, r()),
    cliffRunLeeward: lerp(0.3, 0.46, r()),
    cliffShareWindward: pick(block.cliffShareWindward),
    cliffShareLeeward: lerp(0.14, 0.26, r()),

    terraceStep: lerp(2.2, 4, r()),
    terraceSharpness: lerp(0.55, 0.82, r()),
    terraceAmount: pick(block.terraceAmount),

    dolineCount: Math.round(block.dolinesPerKm * km * lerp(0.6, 1.5, r())),
    dolineRadius: lerp(45, 110, r()),
    dolineDepth: lerp(12, 34, r()),
    poljeCount: Math.round(block.poljePerKm * km * lerp(0.5, 1.6, r())),

    shelfWindward: lerp(160, 240, r()),
    shelfLeeward: lerp(300, 460, r()),
    abyssDepth: lerp(70, 105, r()),
    sedimentSupply: lerp(0.35, 0.95, r()),
  };
}
