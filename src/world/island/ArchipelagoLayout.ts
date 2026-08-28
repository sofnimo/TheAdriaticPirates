import { generateIslandSpec, hashName, STRIKE_ANGLE, TEST_ISLAND_SEED, type Archetype, type IslandSpec } from './IslandSpec';
import { clamp01, hash2, lerp, rng } from './noise';

/**
 * ARCHIPELAGO LAYOUT — §2.4.
 *
 * Islands are laid out in LANES parallel to the Dinaric strike, not scattered on a plane. That
 * is the whole geological claim of §0: the chain is a set of drowned parallel anticlines, so
 * the islands within one lane share an axis and the water between two lanes is a channel
 * rather than a gap. A Poisson-disc scatter would produce the right density and the wrong
 * picture.
 *
 * Within a lane, spacing is 1-D Poisson (a minimum gap, enforced) and size is log-normal, so
 * the tile gets many small islets and one or two hero islands — the real Croatian
 * distribution, and the composition rule 00 §3 requires: mostly empty sea.
 */

export interface ArchipelagoOptions {
  readonly seed: number;
  /** Metres across the square map tile. */
  readonly worldSize: number;
  /** Seeds the hero island specifically, so the URL can reroll it alone. */
  readonly heroSeed?: number;
  readonly heroArchetype?: Archetype;
  readonly heroName?: string;
  /** Islands to attempt, hero included. Fewer will be returned if the lanes fill up. */
  readonly count?: number;
}

/** Metres between lane axes. Wide enough to be a channel a seaplane can work in. */
const LANE_PITCH = 2600;
/** Metres of open water kept between two coastlines. §4.3's 400 m clear chord, with margin. */
const CHANNEL_WIDTH = 520;

/** Half the island's beam — the further of its two flanks reaches. */
function beam(spec: IslandSpec): number {
  return Math.max(spec.halfWidthWindward, spec.halfWidthLeeward) + spec.coastWarpAmp;
}

/**
 * Closest approach of two spines, sampled at their control points.
 *
 * Point-to-point over 5x5 control points rather than true segment-to-segment: the control
 * points are ~lengthM/4 apart, so the answer is short by at most an eighth of a length in the
 * worst crossing case, and the channel margin above absorbs that. The exact test would be
 * segment-to-segment over the resampled polylines, which means building two `Spine`s per
 * rejected candidate during layout — real work to refine a number that is then compared
 * against a hand-picked margin anyway.
 */
function spineGap(a: IslandSpec, b: IslandSpec): number {
  let best = Infinity;
  for (const [ax, az] of a.spine) {
    for (const [bx, bz] of b.spine) {
      const d = Math.hypot(ax - bx, az - bz);
      if (d < best) best = d;
    }
  }
  return best;
}

export function generateArchipelago(options: ArchipelagoOptions): IslandSpec[] {
  const worldSize = options.worldSize;
  const r = rng(hash2(options.seed, 0x1a4e));
  const target = options.count ?? 11;

  const angle = STRIKE_ANGLE;
  const sx = Math.cos(angle);
  const sz = Math.sin(angle);
  // Lane offset direction: perpendicular to the strike.
  const px = sz;
  const pz = -sx;

  // Lanes either side of the origin lane, which is where the hero goes. The tile is square and
  // the lanes run diagonally across it, so the usable half-extent is a little over half the
  // side; anything beyond that lays islands outside the baked field.
  const halfExtent = worldSize * 0.42;
  // Lanes are laid symmetrically about the hero's, in PAIRS. Counting them into a flat list
  // and stopping when the list is full stopped after the first positive offset, so every
  // island in the tile ended up on one side of the hero and the chain read as a shoreline
  // rather than an archipelago.
  const laneCount = Math.max(1, Math.floor(halfExtent / LANE_PITCH));
  const lanes: number[] = [0];
  for (let i = 1; i <= laneCount; i++) {
    lanes.push(i * LANE_PITCH * lerp(0.85, 1.15, r()));
    lanes.push(-i * LANE_PITCH * lerp(0.85, 1.15, r()));
  }

  const specs: IslandSpec[] = [];

  // The hero first, on the origin lane, at the tile centre — the cameras and the acceptance
  // gate both frame it, so where it is must not depend on how the rest of the layout rolled.
  const heroSeed = options.heroSeed ?? options.seed ?? TEST_ISLAND_SEED;
  specs.push(generateIslandSpec(heroSeed, {
    name: options.heroName ?? 'Punta Severa',
    archetype: options.heroArchetype ?? 'ridge',
    centre: [0, 0],
  }));

  // Everything else fills the lanes outward, hero's own lane included at a safe distance.
  let attempt = 0;
  while (specs.length < target && attempt < target * 8) {
    const lane = lanes[attempt % lanes.length]!;
    attempt++;

    // §2.4's log-normal size distribution, skewed to many small islets.
    const roll = Math.exp(lerp(-1.15, 0.55, r()) + (r() - 0.5) * 0.6);
    const archetype: Archetype = roll < 0.55 ? 'islet' : roll < 0.95 ? 'plateau' : roll < 1.3 ? 'twin' : 'ridge';
    const seed = hash2(options.seed, attempt * 7919);
    // Provisional, only to learn how long this island wants to be, so the along-lane position
    // can be drawn from a range that actually fits it inside the tile. Placing first and
    // rejecting after throws away nearly every candidate on a tile this size.
    const size = generateIslandSpec(seed, { archetype });

    // How far along its lane this island may sit and still fit inside the tile, solved per
    // axis rather than guessed. A lane offset already spends part of the tile's half-width, so
    // the room left along the lane depends on which lane it is — without that, every island on
    // an outer lane was generated and then thrown away by the bounds check below, and the
    // outer lanes came back empty.
    const half = worldSize / 2 - 300;
    const extentX = Math.abs(sx) * size.lengthM * 0.5 + beam(size);
    const extentZ = Math.abs(sz) * size.lengthM * 0.5 + beam(size);
    const room = Math.min(
      halfExtent,
      (half - extentX - Math.abs(px * lane)) / Math.max(Math.abs(sx), 1e-3),
      (half - extentZ - Math.abs(pz * lane)) / Math.max(Math.abs(sz), 1e-3),
    );
    if (room <= 0) continue;
    const along = (r() - 0.5) * 2 * room;

    const cx = sx * along + px * lane;
    const cz = sz * along + pz * lane;

    const candidate = generateIslandSpec(seed, {
      archetype,
      centre: [cx, cz],
      name: hashName(seed),
    });

    // Poisson against the SPINES, not against the centres. Two islands in adjacent lanes are
    // 2.3 km apart at their centres and parallel for their whole length, so a centre-distance
    // test against half the summed lengths rejects every one of them — the tile comes back
    // holding the hero and nothing else. What matters is whether the two coastlines leave a
    // channel between them, which is a question about the closest approach of the curves.
    let crowded = false;
    for (const other of specs) {
      const need = beam(candidate) + beam(other) + CHANNEL_WIDTH;
      if (spineGap(candidate, other) < need) { crowded = true; break; }
    }
    if (crowded) continue;

    // Belt and braces on the room solved above: anything whose spine still leaves the tile is
    // data the field would clip halfway through.
    const outside = candidate.spine.some(([x, z]) => Math.abs(x) > half || Math.abs(z) > half);
    if (outside) continue;

    specs.push(candidate);
  }

  return specs;
}

/** 0-1 fraction of the tile's land area an island holds. Used to divide the mesh budget. */
export function footprintShare(specs: readonly IslandSpec[]): number[] {
  const areas = specs.map((s) => s.lengthM * (s.halfWidthWindward + s.halfWidthLeeward));
  const total = Math.max(areas.reduce((a, v) => a + v, 0), 1);
  return areas.map((a) => clamp01(a / total));
}
