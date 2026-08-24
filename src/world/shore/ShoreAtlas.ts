import * as THREE from 'three';
import type { IslandField } from '../island/IslandField';
import type { DepthField } from '../depth/DepthField';

/**
 * SHORE-DISTANCE ATLAS — `02b — Coastal Waves.md` §1.
 *
 * Four channels over the island's world region, baked once:
 *
 *   R  signed distance to the shoreline, 0.5 + d / maxDist * 0.5 (negative under land)
 *   G  depth below sea level, taken from the SAME field the shelf ramp reads
 *   B  shore-normal bearing, atan2 packed to 0..1
 *   A  coastline exposure: 0 sheltered cove, 1 exposed headland
 *
 * WHY THIS IS BAKED AND NOT DERIVED FROM THE DEPTH BUFFER. 02b §1.1 is explicit: the camera
 * sits at 200-1500 m and can look at an island from any azimuth including near-vertical, and
 * a camera-depth "edge foam" trick only finds intersections inside the current frustum. It
 * breaks at steep angles and on an island's far side. A world-space bake has no view
 * dependency at all.
 *
 * WHY AN EXACT EDT AND NOT THE JUMP FLOOD §1.2 DESCRIBES. Jump flooding is the right answer
 * when the bake has to happen on the GPU while the player flies, and 02b assumes streaming
 * islands. Nothing streams yet, and an exact Felzenszwalb-Huttenlocher transform — already
 * written and already used by the bathymetry — is both cheaper here and *exact*, where JFA is
 * an approximation with known error at cell corners. Swapping in the GPU path is a change of
 * bake implementation behind the same texture; §1.4's spread-over-frames budget is what makes
 * it necessary, and neither applies to one hand-authored island.
 */

export interface ShoreAtlasOptions {
  /** Metres of shore distance the R channel spans either side of the waterline. 02b §8.5. */
  readonly maxShoreDistance?: number;
  /** Metres of depth over which G saturates. 02b §8.5. */
  readonly depthFalloff?: number;
  /** Radius in metres of the disc used to judge headland versus cove. */
  readonly exposureRadius?: number;
  readonly resolution?: number;
}

export class ShoreAtlas {
  readonly texture: THREE.DataTexture;
  readonly resolution: number;
  readonly worldSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly maxShoreDistance: number;
  readonly depthFalloff: number;

  /** Signed distance in metres, kept for the gate; negative under land. */
  readonly signedDistance: Float32Array;

  constructor(field: IslandField, depthField: DepthField, options: ShoreAtlasOptions = {}) {
    this.maxShoreDistance = options.maxShoreDistance ?? 60;
    this.depthFalloff = options.depthFalloff ?? 16;
    const exposureRadius = options.exposureRadius ?? 150;

    // The atlas shares the island field's grid outright. 02b §1.3 tiers resolution by island
    // footprint, but the reason the two grids match here is the doc header's requirement that
    // the atlas and the bathymetry "be baked from the same island heightmap pass so they never
    // disagree" — one lattice is the strongest form of that, and Step 3 already had to match
    // the island field to the depth field for the same reason.
    this.resolution = options.resolution ?? field.resolution;
    this.worldSize = field.worldSize;
    this.originX = field.originX;
    this.originZ = field.originZ;

    const n = this.resolution;
    const metresPerTexel = this.worldSize / n;

    // Two exact distance transforms: one to the nearest land texel, one to the nearest water
    // texel. Their difference is the signed distance, and taking both is what puts the zero
    // contour exactly on the mask boundary instead of half a texel off it.
    const toLand = exactDistance(field.land, n, (v) => v === 1);
    const toWater = exactDistance(field.land, n, (v) => v === 0);

    this.signedDistance = new Float32Array(n * n);
    const data = new Uint8Array(n * n * 4);

    for (let iz = 0; iz < n; iz++) {
      const worldZ = this.originZ + iz * metresPerTexel;
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const worldX = this.originX + ix * metresPerTexel;
        const isLand = field.land[i] === 1;

        // Positive seaward, negative under land.
        const signed = isLand ? -toWater[i]! * metresPerTexel : toLand[i]! * metresPerTexel;
        this.signedDistance[i] = signed;

        const r = 0.5 + (signed / this.maxShoreDistance) * 0.5;

        // G comes from the bathymetry itself, not from a second reading of the heightmap.
        // 02b §9's checklist requires the depth channel to be the same signal the shelf ramp
        // uses; sampling DepthField is the only version of that with no room to drift.
        const g = depthField.depthAt(worldX, worldZ);

        data[i * 4 + 0] = clamp255(r * 255);
        data[i * 4 + 1] = clamp255(g * 255);
        data[i * 4 + 3] = 0; // A filled below, once the whole distance field exists
      }
    }

    // Shore normal from the gradient of the finished distance field — 02b §1.2 step 4, which
    // prefers deriving it over storing a separate one. Done in a second pass because a central
    // difference needs neighbours that the first pass has not written yet.
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const xm = this.signedDistance[iz * n + Math.max(0, ix - 1)]!;
        const xp = this.signedDistance[iz * n + Math.min(n - 1, ix + 1)]!;
        const zm = this.signedDistance[Math.max(0, iz - 1) * n + ix]!;
        const zp = this.signedDistance[Math.min(n - 1, iz + 1) * n + ix]!;
        const angle = Math.atan2(zp - zm, xp - xm); // -pi..pi
        data[i * 4 + 2] = clamp255(((angle + Math.PI) / (2 * Math.PI)) * 255);
      }
    }

    const exposure = computeExposure(field, n, metresPerTexel, exposureRadius);
    for (let i = 0; i < n * n; i++) data[i * 4 + 3] = clamp255(exposure[i]! * 255);

    this.texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    // Raw data, not colour: no sRGB decode. Tagging this the way the sea ramp LUT is tagged
    // would silently gamma-curve a distance field.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  /** Signed shore distance in metres at a world position. Positive seaward. */
  distanceAt(worldX: number, worldZ: number): number {
    const m = this.worldSize / this.resolution;
    const ix = Math.max(0, Math.min(this.resolution - 1, Math.round((worldX - this.originX) / m)));
    const iz = Math.max(0, Math.min(this.resolution - 1, Math.round((worldZ - this.originZ) / m)));
    return this.signedDistance[iz * this.resolution + ix]!;
  }

  /** Bytes resident, against 02b §7.2's 16 MB ceiling for all loaded islands. */
  get bytes(): number {
    return this.resolution * this.resolution * 4;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Coastline exposure — 02b §1.1 channel A, "0 = sheltered cove, 1 = exposed headland".
 *
 * Measured as how much land surrounds the point: a headland has open water on three sides, a
 * cove is enclosed. That is the curvature the channel is a proxy for, without needing the
 * coastline extracted as a spline first.
 *
 * Sampled on a ring rather than a filled disc. A filled disc's land fraction is dominated by
 * the near field, which is nearly identical for a headland and a cove at the same distance
 * offshore; the ring at radius R asks the question the channel is actually about — what is
 * around this stretch of coast at the scale of a bay.
 */
function computeExposure(field: IslandField, n: number, metresPerTexel: number, radiusM: number): Float32Array {
  const out = new Float32Array(n * n);
  const radius = Math.max(2, Math.round(radiusM / metresPerTexel));
  const samples = 24;
  const offsets: Array<[number, number]> = [];
  for (let k = 0; k < samples; k++) {
    const a = (k / samples) * Math.PI * 2;
    offsets.push([Math.round(Math.cos(a) * radius), Math.round(Math.sin(a) * radius)]);
  }

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      let land = 0;
      for (const [dx, dz] of offsets) {
        const sx = Math.max(0, Math.min(n - 1, ix + dx));
        const sz = Math.max(0, Math.min(n - 1, iz + dz));
        land += field.land[sz * n + sx]!;
      }
      // All water around => fully exposed; half or more land => sheltered.
      const fraction = land / samples;
      out[iz * n + ix] = Math.max(0, Math.min(1, 1 - fraction * 2));
    }
  }
  return out;
}

/**
 * Exact Euclidean distance in texels to the nearest texel satisfying `isSeed`.
 *
 * Felzenszwalb & Huttenlocher: a 1-D squared-distance transform along rows, then along
 * columns. Linear time and exact, so band edges never show the faceting a chamfer
 * approximation leaves. The bathymetry uses the same routine; this one is parameterised by a
 * predicate so it can be run in both directions to build a signed field.
 */
function exactDistance(mask: Uint8Array, n: number, isSeed: (v: number) => boolean): Float32Array {
  const INF = 1e20;
  const grid = new Float32Array(n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = isSeed(mask[i]!) ? 0 : INF;

  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);

  const transform1D = (): void => {
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

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) f[x] = grid[y * n + x]!;
    transform1D();
    for (let x = 0; x < n; x++) grid[y * n + x] = d[x]!;
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = grid[y * n + x]!;
    transform1D();
    for (let y = 0; y < n; y++) grid[y * n + x] = d[y]!;
  }
  for (let i = 0; i < grid.length; i++) grid[i] = Math.sqrt(grid[i]!);
  return grid;
}
