/**
 * CPU NOISE — the generator's only source of randomness.
 *
 * `03 — Procedural Islands.md` §1.1 makes determinism a hard requirement: the same seed must
 * produce the same island on any machine, and chunk `(x,z)` must sample at WORLD coordinates
 * so neighbours agree at shared edges regardless of generation order. Two consequences are
 * baked in here and are not negotiable:
 *
 *   1. Every seed operation is 32-bit integer arithmetic. Mixing seeds as floats drifts past
 *      2^53 and starts rounding, and the same seed then gives two different islands.
 *   2. The base noise is GRADIENT noise, not value noise. Value noise puts its extrema on
 *      lattice points, which shows up as a grid running through every ridge the island has.
 *
 * Sub-systems take independent streams via `hash2(seed, subsystemId)` — §1.1's splittable
 * PRNG, done by hashing a counter rather than by carrying a stateful generator around.
 */

/** 32-bit integer mix. The only way seeds are ever combined. */
export function hash2(a: number, b: number): number {
  let h = (a | 0) ^ Math.imul(b | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Deterministic uniform stream in [0,1). */
export function rng(seed: number): () => number {
  let s = hash2(seed, 0x9e3779b9) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** C² version. Used wherever a cliff profile is differentiated for a normal. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Gradient direction for lattice cell (ix,iz) under `seed`, as a unit vector. */
function grad(ix: number, iz: number, seed: number): [number, number] {
  const h = hash2(hash2(ix, iz), seed);
  const a = (h / 4294967296) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
}

/** Perlin gradient noise in roughly [-1,1]. Coordinates are in lattice units. */
export function perlin2(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

  const g00 = grad(x0, z0, seed);
  const g10 = grad(x0 + 1, z0, seed);
  const g01 = grad(x0, z0 + 1, seed);
  const g11 = grad(x0 + 1, z0 + 1, seed);

  const n00 = g00[0] * fx + g00[1] * fz;
  const n10 = g10[0] * (fx - 1) + g10[1] * fz;
  const n01 = g01[0] * fx + g01[1] * (fz - 1);
  const n11 = g11[0] * (fx - 1) + g11[1] * (fz - 1);

  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.4142;
}

/** Fractal sum, [-1,1]. `scale` is metres per lattice cell, so callers pass world XZ. */
export function fbm(
  x: number, z: number, seed: number,
  scale: number, octaves = 4, gain = 0.5, lacunarity = 2.03,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / scale;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin2(x * f, z * f, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / (norm || 1);
}

/**
 * Standard deviation of the `fbm` sum above, measured over 16k samples at 2 and 3 octaves.
 *
 * The value matters because `fbm` is NOT uniform on [-1, 1] and nothing downstream may assume
 * it is. It is a sum of gradient noise, so it is close to normal about zero, and three octaves
 * top out near 0.73 across an entire tile.
 */
const FBM_SIGMA = 0.2;

/**
 * The `fbm` value exceeded by a given fraction of the plane.
 *
 * Use this to turn an authored COVERAGE — "12% of the ground is dried grass" — into a
 * threshold to compare an fbm sample against. The obvious mapping, `1 - 2*coverage`, assumes
 * the field is uniform on [-1, 1]; against a field with a standard deviation of 0.2 it asks
 * for 0.76 at 12% coverage, which the noise never reaches. That is not a mask that comes out
 * thin, it is a mask that comes out EMPTY, and it is why the dried-grass tier rendered as
 * nothing at all.
 *
 * The quantile is the logistic approximation to the normal one, `ln(q/(1-q)) / 1.702`. Its
 * error against the true quantile is a couple of hundredths of a standard deviation over the
 * range coverage values live in — far inside the tolerance of a number an artist sets by eye.
 */
export function coverageThreshold(coverage: number): number {
  const p = Math.min(0.999, Math.max(0.001, coverage));
  const q = 1 - p;
  return (FBM_SIGMA * Math.log(q / (1 - q))) / 1.702;
}

/**
 * Ridged multifractal, [0,1] — §5.1.
 *
 * `1 - |n|` folds valleys into creases; squaring sharpens the crease. Both steps are the
 * canonical Musgrave construction and both matter: without the square the ridges are rounded
 * hills, which is exactly the blob the anticline crest is supposed to not be.
 */
export function ridged(
  x: number, z: number, seed: number,
  scale: number, octaves = 4, sharpness = 1,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / scale;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin2(x * f, z * f, seed + i * 7717));
    n *= n;
    n *= weight;
    weight = clamp01(n * 2);
    sum += amp * n;
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  const r = clamp01(sum / (norm || 1));
  return sharpness === 1 ? r : Math.pow(r, sharpness);
}

/** How far into the field the second iteration samples, as a fraction of one wavelength. */
const WARP_INNER = 0.3;
/**
 * Measured peak of `|grad r| * scale`, where `r` is the two-iteration displacement below with
 * its amplitude factored out.
 *
 * Measured over three seeds rather than derived: the value falls out of the octave count, the
 * gain, the lacunarity, the quintic fade and `WARP_INNER` all at once, and every algebraic
 * bound for it is a guess with a safety factor bolted on. The plain 3-octave sum peaks at
 * 3.53; the inner iteration takes it to 5.75. The MEAN is about 1.1 — irrelevant here, because
 * one fold at one point on the island is a tear in the coastline at that point.
 */
const WARP_PEAK_GRADIENT = 5.75;
/**
 * Ceiling on the warp's contribution to the Jacobian. Below 1 the map is injective — no fold —
 * and the margin covers the two stages' gradients happening to peak at the same point.
 */
const WARP_SAFE_JACOBIAN = 0.6;

/**
 * Quilez domain warp, two iterations — §2.2.
 *
 * Two, not three: a third pass erases the elongated silhouette the spine gave us, which is
 * the one property the whole skeleton-first construction exists to produce.
 *
 * A DOMAIN WARP MUST NOT FOLD, AND THIS ONE IS CLAMPED SO IT CANNOT. The map is
 * `p -> p + A·r(p)`, whose Jacobian is `1 + A·grad r`. Once `A·|grad r|` passes 1 the map stops
 * being injective: two nearby sample points land on the same place, the mask is evaluated out
 * of order, and the coastline tears. The measured Jacobian of the previous version of this
 * function was 4.6 — the island's outline was being folded over itself four times, which is
 * where the ragged, toothy coast came from, along with 60 m cliffs between adjacent texels.
 *
 * Two things caused it and both are fixed here. The inner iteration offset the sample point by
 * `4·A`, a displacement of nearly a kilometre into a field with a 770 m wavelength — so the
 * second fbm oscillated several times per metre of travel. It now steps a fixed FRACTION OF
 * ONE WAVELENGTH, which is what the technique means by warping the domain. And the amplitude
 * is clamped against the scale from the measured gradient above, so a caller cannot ask for a
 * fold no matter what it passes: the guarantee lives here rather than in a comment on the
 * caller.
 */
export function warp2(
  x: number, z: number, seed: number,
  scale: number, amplitude: number,
): [number, number] {
  const a = Math.min(amplitude, (WARP_SAFE_JACOBIAN * scale) / WARP_PEAK_GRADIENT);
  const step = scale * WARP_INNER;

  const qx = fbm(x, z, seed, scale, 3);
  const qz = fbm(x + 520, z + 130, seed, scale, 3);
  const rx = fbm(x + step * qx, z + step * qz, seed + 91, scale, 3);
  const rz = fbm(x + step * qx + 830, z + step * qz + 280, seed + 91, scale, 3);
  return [x + a * rx, z + a * rz];
}
