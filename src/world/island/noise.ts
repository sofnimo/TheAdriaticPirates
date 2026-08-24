/**
 * CPU-side deterministic noise for island generation.
 *
 * Separate from the GLSL `hash_noise.glsl` on purpose: the island field is baked once on the
 * CPU into a heightmap and a land mask, and both the mesh and the bathymetry read the SAME
 * baked arrays. Reimplementing the same noise in two languages and hoping they agree is how
 * the shore ends up in one place for the terrain and another for the water — the exact
 * failure `02b — Coastal Waves.md` §1.2 warns about when it insists the shore signal has one
 * owner. Nothing here is sampled from a shader.
 *
 * `03 — Procedural Islands.md` §1.1: everything is a pure function of the seed, and every
 * field is sampled in WORLD space so a chunked rebuild agrees at its edges regardless of
 * order.
 */

/** 2D integer hash, in [0,1). */
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Value noise in [0,1). Smooth enough for shape-scale work, which is all this is used for. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}

export function fbm(x: number, y: number, octaves = 5, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Ridged multifractal — `03` §5.1. Folding the noise around 0.5 and squaring turns smooth
 * hills into sharp crests, which is what makes a limestone spine read as a fold rather than
 * a dune. Higher octaves are weighted by the previous octave so ridges only branch where the
 * larger structure already stands proud.
 */
export function ridged(x: number, y: number, octaves = 5, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 211) * 2 - 1);
    const shaped = n * n * prev;
    sum += shaped * amp;
    norm += amp;
    prev = shaped;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Two-iteration domain warp, Quilez's construction as quoted in `03` §2.2.
 *
 * Two iterations, not three: the doc is explicit that a third erases the elongated
 * silhouette the spine exists to produce, which would defeat the whole skeleton-first
 * approach and hand back the radial blob it was chosen to avoid.
 */
export function domainWarp(x: number, y: number, strength: number, scale: number, seed: number): [number, number] {
  const qx = fbm(x / scale, y / scale, 4, seed);
  const qy = fbm(x / scale + 5.2, y / scale + 1.3, 4, seed);
  const rx = fbm(x / scale + 4 * qx + 1.7, y / scale + 4 * qy + 9.2, 4, seed + 37);
  const ry = fbm(x / scale + 4 * qx + 8.3, y / scale + 4 * qy + 2.8, 4, seed + 73);
  return [x + strength * (rx - 0.5) * 2, y + strength * (ry - 0.5) * 2];
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
