import type { IslandSpec } from './IslandSpec';

/**
 * THE SPINE — §2.1's skeleton curve, resampled to uniform arc length.
 *
 * Everything the island is derives from a query against this: how far a point is from the
 * crest, how far ALONG the crest it is, and which flank it stands on. That is the whole
 * inversion §2.1 asks for — draw the skeleton first, then fill — and it is why there is no
 * distance-from-centre anywhere in the generator.
 *
 * NEAREST-NODE IS TWO-LEVEL, AND IT HAS TO BE EXACT. The raster pass asks this question once
 * per texel per island, several million times per bake, so a linear scan over ~600 nodes is
 * out. But the obvious replacement — a bucket grid that stops at the first ring holding any
 * node — is NOT exact: a node found in the 3x3 ring can be 68 m away while a nearer one sits
 * in the next ring out. The mask is `halfWidth - dist`, so an error in `dist` is an error in
 * where the coastline is, and an error that jumps as the search switches buckets is a
 * coastline with a step in it. Repeated around the island that reads as a ragged, toothy
 * outline — which is the failure this rebuild exists to remove, so the search is exact.
 *
 * Exactness comes from a coarse pass over every Nth node followed by a local refinement in
 * the window around the coarse winner. The curve is arc-length resampled and C1, so the true
 * minimum is always inside that window; both passes measure real distance, so the result is a
 * continuous function of the query point, which is what smoothness actually requires.
 */

export interface SpineHit {
  /** Metres to the nearest point on the curve. */
  readonly dist: number;
  /** Arc position, 0 at one terminus and 1 at the other. */
  readonly t: number;
  /** Unit tangent at that point. */
  readonly tx: number;
  readonly tz: number;
  /** World XZ of that point, so callers can take the cross-spine bearing themselves. */
  readonly nx: number;
  readonly nz: number;
  /** +1 on the windward flank, -1 on the sheltered one. */
  readonly side: number;
}

interface Node {
  x: number;
  z: number;
  t: number;
  tx: number;
  tz: number;
}

/** Metres between resampled nodes. Fine enough that nearest-node is nearest-point. */
const NODE_SPACING = 12;
/**
 * Coarse samples the first pass aims to take. The stride is derived from it per spine, never
 * fixed: a fixed stride of 8 is 96 m of arc, which is a tenth of a hero island and a QUARTER
 * of an islet — and a quarter of an islet's spine wanders further sideways than the refinement
 * window can reach back, so the coarse winner lands in the wrong neighbourhood and the search
 * silently returns the wrong node. Every quantity keyed on arc position then jumps across the
 * line where the mistake starts, which is a visible fold in the seabed.
 */
const COARSE_SAMPLES = 48;

function catmullRom(
  p0: readonly [number, number], p1: readonly [number, number],
  p2: readonly [number, number], p3: readonly [number, number],
  t: number,
): [number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number): number =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

export class Spine {
  readonly nodes: Node[] = [];
  readonly length: number;
  /** Bounding box of the curve itself, before any width is added. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  /** Nodes per coarse step. 1 on a short spine, which makes the first pass exhaustive. */
  private readonly stride: number;
  /** Flat XZ pairs, so the inner loop reads a typed array instead of an object graph. */
  private readonly px: Float64Array;
  private readonly pz: Float64Array;
  private readonly ex: number;
  private readonly ez: number;

  constructor(spec: IslandSpec) {
    this.ex = spec.exposure[0];
    this.ez = spec.exposure[1];

    // Densely sample the Catmull-Rom through the control points, then resample that polyline
    // by arc length. Two steps, because the parameter of a Catmull-Rom is not arc length and
    // treating it as one bunches nodes at the bends — which is exactly where the island needs
    // its spine sampled evenly.
    const cp = spec.spine;
    const raw: Array<[number, number]> = [];
    for (let i = 0; i < cp.length - 1; i++) {
      const p0 = cp[Math.max(0, i - 1)]!;
      const p1 = cp[i]!;
      const p2 = cp[i + 1]!;
      const p3 = cp[Math.min(cp.length - 1, i + 2)]!;
      for (let k = 0; k < 32; k++) raw.push(catmullRom(p0, p1, p2, p3, k / 32));
    }
    raw.push([cp[cp.length - 1]![0], cp[cp.length - 1]![1]]);

    let total = 0;
    const cum: number[] = [0];
    for (let i = 1; i < raw.length; i++) {
      total += Math.hypot(raw[i]![0] - raw[i - 1]![0], raw[i]![1] - raw[i - 1]![1]);
      cum.push(total);
    }
    this.length = total;

    const count = Math.max(2, Math.round(total / NODE_SPACING));
    let cursor = 1;
    for (let i = 0; i <= count; i++) {
      const s = (i / count) * total;
      while (cursor < cum.length - 1 && cum[cursor]! < s) cursor++;
      const a = raw[cursor - 1]!;
      const b = raw[cursor]!;
      const seg = cum[cursor]! - cum[cursor - 1]! || 1e-6;
      const f = (s - cum[cursor - 1]!) / seg;
      const x = a[0] + (b[0] - a[0]) * f;
      const z = a[1] + (b[1] - a[1]) * f;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6;
      this.nodes.push({ x, z, t: i / count, tx: (b[0] - a[0]) / len, tz: (b[1] - a[1]) / len });
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of this.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.z < minZ) minZ = n.z;
      if (n.z > maxZ) maxZ = n.z;
    }
    this.minX = minX; this.maxX = maxX; this.minZ = minZ; this.maxZ = maxZ;

    this.px = new Float64Array(this.nodes.length);
    this.pz = new Float64Array(this.nodes.length);
    for (let i = 0; i < this.nodes.length; i++) {
      this.px[i] = this.nodes[i]!.x;
      this.pz[i] = this.nodes[i]!.z;
    }
    // A short spine is scanned outright: below the coarse budget the two-level search costs
    // more than the linear one it is meant to replace, and it can be wrong where the linear
    // one cannot.
    this.stride = Math.max(1, Math.floor(this.nodes.length / COARSE_SAMPLES));
  }

  /**
   * Distance from a point to the spine's own bounding box, or 0 inside it.
   *
   * A cheap conservative lower bound on `nearest().dist`, so the raster pass can recognise
   * open water that no island reaches without paying for the real query. The box is the
   * curve's, not the island's, so the bound is loose by up to a half-width — which is the
   * correct direction for a bound to be loose in.
   */
  boxDistance(x: number, z: number): number {
    const dx = Math.max(this.minX - x, 0, x - this.maxX);
    const dz = Math.max(this.minZ - z, 0, z - this.maxZ);
    return Math.hypot(dx, dz);
  }

  nearest(x: number, z: number): SpineHit {
    const px = this.px;
    const pz = this.pz;
    const count = px.length;

    // Coarse pass: every stride'th node, plus the final one so a query off the far
    // terminus is never answered by a node short of it.
    let best = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < count; i += this.stride) {
      const dx = px[i]! - x;
      const dz = pz[i]! - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    {
      const i = count - 1;
      const dx = px[i]! - x;
      const dz = pz[i]! - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }

    // Refinement: the true nearest node is within one coarse stride of the coarse winner, so
    // the window is the stride either side with a node of slack for the ends.
    const lo = Math.max(0, best - this.stride - 1);
    const hi = Math.min(count - 1, best + this.stride + 1);
    for (let i = lo; i <= hi; i++) {
      const dx = px[i]! - x;
      const dz = pz[i]! - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }

    // REFINE FROM THE NODE TO THE CURVE.
    //
    // The nearest NODE is a staircase: `t` is constant across each node's cell and jumps at the
    // boundary, and so does `dist`. Anything read off arc position inherits those steps —
    // the beach table most visibly, because one node step on a short spine is more than one
    // table station, so the deposited beach width jumps and drags the whole nearshore seabed
    // with it. Projecting onto the two adjoining segments makes both `t` and `dist` continuous
    // functions of the query point for the price of two dot products.
    let bd2 = Infinity;
    let bt = this.nodes[best]!.t;
    let bnx = px[best]!;
    let bnz = pz[best]!;
    let btx = this.nodes[best]!.tx;
    let btz = this.nodes[best]!.tz;
    for (let s = best - 1; s <= best; s++) {
      if (s < 0 || s + 1 >= count) continue;
      const ax = px[s]!;
      const az = pz[s]!;
      const ex = px[s + 1]! - ax;
      const ez = pz[s + 1]! - az;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-9) continue;
      const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
      const qx = ax + ex * u;
      const qz = az + ez * u;
      const d2 = (qx - x) * (qx - x) + (qz - z) * (qz - z);
      if (d2 >= bd2) continue;
      bd2 = d2;
      bt = this.nodes[s]!.t + (this.nodes[s + 1]!.t - this.nodes[s]!.t) * u;
      bnx = qx;
      bnz = qz;
      const len = Math.sqrt(len2);
      btx = ex / len;
      btz = ez / len;
    }
    if (bd2 < bestD2) {
      const side2 = (x - bnx) * this.ex + (z - bnz) * this.ez >= 0 ? 1 : -1;
      return { dist: Math.sqrt(bd2), t: bt, tx: btx, tz: btz, nx: bnx, nz: bnz, side: side2 };
    }

    const n = this.nodes[best]!;
    // Signed by the exposure vector rather than by the tangent's left/right: the flank a
    // point is on is defined by which way it faces the open sea (§3.5), and a spine that
    // doubles back would otherwise flip the sign of the cliff rule halfway along the island.
    const side = (x - n.x) * this.ex + (z - n.z) * this.ez >= 0 ? 1 : -1;
    return { dist: Math.sqrt(bestD2), t: n.t, tx: n.tx, tz: n.tz, nx: n.x, nz: n.z, side };
  }
}
