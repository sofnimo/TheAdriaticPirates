import * as THREE from 'three';

/**
 * THE DEPTH FIELD — owner of the bathymetry texture, and the only writer of it.
 *
 * Per the doc index's cross-doc dependency: 02's colour ramp and 02b's foam must read the
 * SAME depth signal. This class produces it; `sea_depth.glsl` is the only reader; both the
 * ocean shader and (from Step 4) the shoreline call that one function.
 *
 * STEP 2 STATE: the bathymetry is a placeholder generated here rather than baked from an
 * island heightmap. It exists so the depth interface is exercised — and so the shelf band
 * can be judged — before 03's generator exists. Step 3 replaces `generatePlaceholder()`
 * with a bake from the real heightmap; nothing downstream changes.
 *
 * Depth comes from a TRUE 2-D DISTANCE TRANSFORM of the land mask, not from a per-column
 * "distance north to the shoreline". That distinction is not cosmetic: with a 1-D measure a
 * bay reads as DEEPER than the open coast either side of it, because the shoreline it
 * measures against has moved further away — the exact opposite of what a cove looks like.
 * The exact Euclidean transform below is also the same shape of operation 02b §1.2 will do
 * on the GPU with jump flooding, so the two stay conceptually aligned.
 *
 * Encoding (02 §2.1): R = 0 at the shoreline, 1 at abyssal.
 */

export interface DepthFieldOptions {
  resolution?: number;
  worldSize?: number;
  origin?: THREE.Vector2;
  /**
   * The land mask this bathymetry shelves against.
   *
   * Supplied by the island once Step 3 exists, so the shore the terrain mesh was built from
   * and the shore the water reads are the same shore — `02b — Coastal Waves.md` §1.2 makes
   * one owner for the shore signal a requirement, and passing the mask in is how that is
   * enforced rather than hoped for. Omitted, it falls back to the Step 2 placeholder coast.
   */
  landAt?: (worldX: number, worldZ: number) => boolean;
}

/**
 * Depth-vs-distance-from-shore control points, in metres.
 *
 * This is the shape of the shelf, and it is what decides how much of the frame the turquoise
 * gets. It is not a band table any more — the ramp is continuous — so these are just the
 * shape of the curve.
 *
 * WIDENED IN STEP 3. The Step 2 profile reached depth01 0.5 by 70 m from shore, which put the
 * whole turquoise range into a strip a few pixels wide; measured against image-3.jpg, whose
 * turquoise fills a large part of the frame, that was the ramp being starved rather than the
 * ramp being wrong. The colour ladder matched the reference at every point on it, so the
 * error was here. 0.5 now sits at 190 m and 0.75 at 420 m.
 */
const SHELF_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.0],
  [60, 0.25],
  [190, 0.5],
  [420, 0.75],
  [900, 0.95],
  [1600, 1.0],
];

export class DepthField {
  readonly texture: THREE.DataTexture;
  readonly origin: THREE.Vector2;
  readonly worldSize: number;
  readonly resolution: number;
  private readonly depth: Float32Array;
  private readonly landAt: ((x: number, z: number) => boolean) | undefined;
  /**
   * The land mask this bathymetry was actually built from.
   *
   * Kept rather than inferred back out of the depth values. Depth 0 does NOT uniquely mean
   * land: the contour wander in generate() can drive a shallow water texel's
   * distance-from-shore to zero, which sampleProfile maps to 0 as well. A gate that inferred
   * land from depth reported 163 texels of disagreement between the terrain and the water for
   * a coastline both were reading from the same callback.
   */
  private readonly landMask: Uint8Array;

  constructor(options: DepthFieldOptions = {}) {
    this.resolution = options.resolution ?? 1024;
    this.worldSize = options.worldSize ?? 4096;
    this.origin = options.origin ?? new THREE.Vector2(-2048, -2048);

    this.landAt = options.landAt;
    this.landMask = new Uint8Array(this.resolution * this.resolution);
    this.depth = this.generate();

    const bytes = new Uint8Array(this.depth.length);
    for (let i = 0; i < this.depth.length; i++) bytes[i] = Math.round(this.depth[i]! * 255);

    this.texture = new THREE.DataTexture(bytes, this.resolution, this.resolution, THREE.RedFormat);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  /** World XZ -> depth01, CPU-side. Mirrors sea_depth.glsl for probes and, later, physics. */
  sampleDepth01(x: number, z: number): number {
    const u = (x - this.origin.x) / this.worldSize;
    const v = (z - this.origin.y) / this.worldSize;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 1;
    const px = Math.min(this.resolution - 1, Math.max(0, Math.round(u * (this.resolution - 1))));
    const py = Math.min(this.resolution - 1, Math.max(0, Math.round(v * (this.resolution - 1))));
    return this.depth[py * this.resolution + px] ?? 1;
  }

  /**
   * A hand-shaped stand-in coastline: a wavy shore running east-west with a bay cut into
   * it, plus one offshore shoal. The shoal matters — it produces closed band contours out in
   * open water, which a shore-parallel-only test would never exercise.
   */
  /**
   * Depth at a world position, 0 at or above the waterline and 1 at abyssal.
   *
   * Nearest-sample, not bilinear: the gate that uses this is comparing land-versus-sea against
   * the terrain's own mask, and interpolating across the shoreline would manufacture
   * half-land texels that belong to neither side and report them as disagreements.
   */
  /** Was this world position land when the bathymetry was baked? */
  isLand(worldX: number, worldZ: number): boolean {
    return this.landMask[this.texelIndex(worldX, worldZ)] === 1;
  }

  private texelIndex(worldX: number, worldZ: number): number {
    const metresPerTexel = this.worldSize / this.resolution;
    const px = Math.max(0, Math.min(this.resolution - 1, Math.round((worldX - this.origin.x) / metresPerTexel)));
    const py = Math.max(0, Math.min(this.resolution - 1, Math.round((worldZ - this.origin.y) / metresPerTexel)));
    return py * this.resolution + px;
  }

  depthAt(worldX: number, worldZ: number): number {
    return this.depth[this.texelIndex(worldX, worldZ)] ?? 0;
  }

  private generate(): Float32Array {
    const n = this.resolution;
    const metresPerTexel = this.worldSize / n;
    const land = new Uint8Array(n * n);

    for (let py = 0; py < n; py++) {
      const worldZ = this.origin.y + py * metresPerTexel;
      for (let px = 0; px < n; px++) {
        const worldX = this.origin.x + px * metresPerTexel;

        if (this.landAt) {
          // Step 3 onward: the island's own baked mask. Same array the terrain mesh was
          // built from, so the two coastlines are the same coastline by construction.
          land[py * n + px] = this.landAt(worldX, worldZ) ? 1 : 0;
          continue;
        }

        // Step 2 fallback, kept so the ocean scene still runs with no island in it.
        const shoreZ =
          -420 +
          90 * Math.sin(worldX / 260) +
          38 * Math.sin(worldX / 97 + 1.3) +
          14 * Math.sin(worldX / 41 + 2.7);

        // A bay cut northward into the land around x = -150.
        const coveT = Math.max(0, 1 - Math.abs(worldX - -150) / 150);
        const cove = 210 * smoothstep(0, 1, coveT) ** 1.3;

        land[py * n + px] = worldZ < shoreZ - cove ? 1 : 0;
      }
    }

    this.landMask.set(land);

    // Exact Euclidean distance (in texels) from every water texel to the nearest land texel.
    const distanceTexels = euclideanDistanceTransform(land, n, n);

    const depth = new Float32Array(n * n);
    for (let py = 0; py < n; py++) {
      const worldZ = this.origin.y + py * metresPerTexel;
      for (let px = 0; px < n; px++) {
        const i = py * n + px;
        const worldX = this.origin.x + px * metresPerTexel;

        if (land[i] === 1) {
          depth[i] = 0;
          continue;
        }

        let metres = distanceTexels[i]! * metresPerTexel;
        // Long-wavelength wander so depth contours are never parallel to the coastline.
        metres += 45 * Math.sin(worldX / 190 + worldZ / 320) + 18 * Math.sin(worldX / 83 - worldZ / 110);
        metres = Math.max(0, metres);

        let d = sampleProfile(metres);

        // Offshore shoal in open water.
        const shoalR = Math.hypot(worldX - 380, (worldZ - 120) * 1.6);
        if (shoalR < 300) d = Math.max(0, d - Math.exp(-((shoalR / 150) ** 2)) * 0.62);

        depth[i] = Math.min(1, Math.max(0, d));
      }
    }
    return smooth(depth, land, n, 2);
  }
}

/**
 * Separable box blur over the depth field.
 *
 * The land mask is binary at 4 m per texel, so the EDT's distance — and therefore the depth —
 * steps in whole texels along the coast. Bilinear filtering hides that in open water, but at
 * the shoreline, where the profile is steepest (0 to 0.25 over 25 m), the steps project to
 * several screen pixels and read as a pixelated staircase along the waterline.
 *
 * Two texels of blur removes it and moves band positions by well under a metre. This smooths
 * the PLACEHOLDER; Step 3's real island generator replaces the mask outright, and this can go
 * with it if the SDF it produces is already continuous.
 */
function smooth(field: Float32Array, land: Uint8Array, n: number, radius: number): Float32Array {
  const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const idx = horizontal ? a * n + b : b * n + a;
        // Land stays at exactly zero. Blurring across the waterline drags a little depth on
        // to the land side, which moves the shoreline the water reads a texel or two away
        // from the shoreline the terrain mesh was built from — measured, 80 texels of
        // disagreement. The blur exists to smooth the shelf, not to relocate the coast.
        if (land[idx] === 1) { out[idx] = 0; continue; }
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k++) {
          const c = b + k;
          if (c < 0 || c >= n) continue;
          const s = horizontal ? a * n + c : c * n + a;
          if (land[s] === 1) continue;
          sum += src[s]!;
          count++;
        }
        out[idx] = count > 0 ? sum / count : src[idx]!;
      }
    }
    return out;
  };
  return pass(pass(field, true), false);
}

/**
 * Felzenszwalb & Huttenlocher exact EDT: a 1-D squared-distance transform along rows, then
 * along columns. Linear time, exact Euclidean result — no chamfer approximation artefacts
 * showing up as faceted band contours.
 */
function euclideanDistanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e20;
  const grid = new Float32Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] === 1 ? 0 : INF;

  const size = Math.max(width, height);
  const f = new Float32Array(size);
  const d = new Float32Array(size);
  const v = new Int32Array(size);
  const z = new Float32Array(size + 1);

  const transform1D = (n: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      const dist = q - v[k]!;
      d[q] = dist * dist + f[v[k]!]!;
    }
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x]!;
    transform1D(width);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x]!;
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]!;
    transform1D(height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]!;
  }

  for (let i = 0; i < grid.length; i++) grid[i] = Math.sqrt(grid[i]!);
  return grid;
}

function sampleProfile(distance: number): number {
  const pts = SHELF_PROFILE;
  if (distance <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    const [d1, v1] = pts[i]!;
    const [d0, v0] = pts[i - 1]!;
    if (distance <= d1) return v0 + ((v1 - v0) * (distance - d0)) / (d1 - d0);
  }
  return pts[pts.length - 1]![1];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
