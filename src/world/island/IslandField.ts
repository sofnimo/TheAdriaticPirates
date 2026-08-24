import { clamp01, domainWarp, fbm, ridged, smoothstep } from './noise';
import type { IslandSpec } from './IslandSpec';

/**
 * THE ISLAND FIELD — baked once, read by everything.
 *
 * Produces a height grid, a land mask, and an exposure field over a square world region.
 * Both the terrain mesh and the sea's bathymetry read these arrays, so the coastline the
 * player sees and the coastline the water shelves against are the same coastline by
 * construction rather than by coincidence.
 *
 * Order follows `03 — Procedural Islands.md` §2: spine SDF first, warp it, threshold to a
 * mask, then synthesise height inside the mask. Skeleton-first, never blob-first (§2.1).
 */

export interface IslandFieldOptions {
  /** Samples per side. */
  readonly resolution?: number;
  /** World size of the square region, in metres. */
  readonly worldSize?: number;
  /** World-space origin (min corner) in XZ. */
  readonly originX?: number;
  readonly originZ?: number;
}

/** Metres the seabed drops over SHORE_APRON_RUN metres beyond the mask boundary. */
const SHORE_APRON_DEPTH = 9;
const SHORE_APRON_RUN = 55;

export class IslandField {
  readonly spec: IslandSpec;
  readonly resolution: number;
  readonly worldSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly metresPerSample: number;

  /** Height above sea level in metres. Zero everywhere the mask is sea. */
  readonly height: Float32Array;
  /** 1 where land, 0 where sea. Binary — the shore is a hard edge (00 §3, and the frames). */
  readonly land: Uint8Array;
  /** Signed exposure in -1..1: +1 fully facing the open sea, -1 fully sheltered (03 §3.5). */
  readonly exposure: Float32Array;

  constructor(spec: IslandSpec, options: IslandFieldOptions = {}) {
    this.spec = spec;
    this.resolution = options.resolution ?? 512;
    this.worldSize = options.worldSize ?? 4096;
    this.originX = options.originX ?? -2048;
    this.originZ = options.originZ ?? -2048;
    this.metresPerSample = this.worldSize / this.resolution;

    const n = this.resolution;
    this.height = new Float32Array(n * n);
    this.land = new Uint8Array(n * n);
    this.exposure = new Float32Array(n * n);
    this.generate();
  }

  /** World XZ -> sample index, clamped. */
  private index(x: number, z: number): number {
    const ix = Math.max(0, Math.min(this.resolution - 1, Math.round((x - this.originX) / this.metresPerSample)));
    const iz = Math.max(0, Math.min(this.resolution - 1, Math.round((z - this.originZ) / this.metresPerSample)));
    return iz * this.resolution + ix;
  }

  /** Bilinear height lookup in world space, for mesh vertices that fall between samples. */
  heightAt(x: number, z: number): number {
    const fx = (x - this.originX) / this.metresPerSample;
    const fz = (z - this.originZ) / this.metresPerSample;
    const x0 = Math.max(0, Math.min(this.resolution - 1, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(this.resolution - 1, Math.floor(fz)));
    const x1 = Math.min(this.resolution - 1, x0 + 1);
    const z1 = Math.min(this.resolution - 1, z0 + 1);
    const tx = clamp01(fx - x0);
    const tz = clamp01(fz - z0);
    const h00 = this.height[z0 * this.resolution + x0]!;
    const h10 = this.height[z0 * this.resolution + x1]!;
    const h01 = this.height[z1 * this.resolution + x0]!;
    const h11 = this.height[z1 * this.resolution + x1]!;
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  isLand(x: number, z: number): boolean {
    return this.land[this.index(x, z)] === 1;
  }

  /**
   * Distance from a world point to the spine polyline, plus the local tangent — the base
   * "island-ness" field of 03 §2.1. Returned together because the exposure term needs the
   * tangent at the same nearest point and recomputing it would double the cost of the
   * hottest loop in generation.
   */
  private spineDistance(x: number, z: number): { distance: number; nearestX: number; nearestZ: number } {
    const pts = this.spec.spine;
    let best = Infinity;
    let nx = x;
    let nz = z;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1]!;
      const [bx, bz] = pts[i]!;
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / lenSq) : 0;
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) {
        best = d;
        nx = px;
        nz = pz;
      }
    }
    return { distance: best, nearestX: nx, nearestZ: nz };
  }

  /** Normalised position along the spine, 0 at the first control point and 1 at the last. */
  private alongSpine(x: number, z: number): number {
    const pts = this.spec.spine;
    const [ax, az] = pts[0]!;
    const [bx, bz] = pts[pts.length - 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    return lenSq > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / lenSq) : 0;
  }

  private generate(): void {
    const s = this.spec;
    const n = this.resolution;

    for (let iz = 0; iz < n; iz++) {
      const worldZ = this.originZ + iz * this.metresPerSample;
      for (let ix = 0; ix < n; ix++) {
        const worldX = this.originX + ix * this.metresPerSample;
        const i = iz * n + ix;

        // --- footprint: warp the sample point, THEN measure to the spine (03 §2.2) -------
        const [wx, wz] = domainWarp(worldX, worldZ, s.warpStrength, s.warpScale, s.seed);
        const { distance, nearestX, nearestZ } = this.spineDistance(wx, wz);

        // Warp strength scales along the spine so the tips get the sharper headlands and
        // the mid-island coast stays smoother — 03 §2.2's closing note.
        const along = this.alongSpine(wx, wz);
        const tipSharpen = 1 + 0.55 * Math.abs(along * 2 - 1) ** 2;

        // Taper the half-width toward both ends so the island has points, not blunt caps.
        const taper = Math.sin(Math.PI * clamp01(along)) ** 0.55;
        const halfWidth = s.coastHalfWidth * taper * tipSharpen;

        // 1 = land, 0 = sea. The mask itself is a hard threshold: the waterline is a hard
        // edge in every reference frame (measured: 19/255 in the karst cove, 88/255 on the
        // peninsula), so it is not smoothstepped into existence here.
        const mask = halfWidth > 1 ? smoothstep(halfWidth, halfWidth - 40, distance) : 0;
        const isLand = mask > 0.5 ? 1 : 0;
        this.land[i] = isLand;

        // --- exposure: which flank faces the open sea (03 §3.5) --------------------------
        // The outward bearing is simply the vector from the nearest point ON THE SPINE to
        // this sample, normalised, dotted with the prevailing exposure direction.
        //
        // The first version of this reconstructed the offset from the warp displacement and
        // a signed cross-spine bearing, which measured how far the domain warp had moved the
        // sample rather than which flank it was on. The gate caught it: flank asymmetry came
        // back at 0.86:1 and then 0.76:1 — not merely weak but INVERTED, which no amount of
        // adjusting the height profile was ever going to fix.
        const offX = wx - nearestX;
        const offZ = wz - nearestZ;
        const offLen = Math.max(Math.hypot(offX, offZ), 1e-6);
        const exposure = (offX / offLen) * s.exposure[0] + (offZ / offLen) * s.exposure[1];
        this.exposure[i] = exposure;

        if (!isLand) {
          // The seabed continues BELOW the waterline rather than stopping flat at zero.
          //
          // This matters more than it looks. With land clamped to a positive height and water
          // pinned at 0, the terrain forms a low wall at the mask boundary, and at a shallow
          // camera angle that wall hides the first metre or two of water — which is exactly
          // where 02b §2.1's static foam ring lives. The ring was being drawn correctly and
          // occluded entirely. Letting the ground pass under the sea surface puts the visible
          // waterline at the intersection, where it belongs, and the near-shore water back in
          // view.
          const outside = Math.max(0, distance - halfWidth);
          this.height[i] = -SHORE_APRON_DEPTH * clamp01(outside / SHORE_APRON_RUN);
          continue;
        }

        // --- height: ridged multifractal, shaped by distance from the spine -------------
        // Ridged, not fBM: 03 §5.1. A limestone anticline has a crest, and smooth fBM gives
        // dunes. The ridge field is sampled in world space so it is chunk-order independent.
        const ridge = ridged(worldX / s.ridgeScale, worldZ / s.ridgeScale, 5, s.seed + 11);

        // Cross-section: 1 on the spine falling to 0 at the coast. The exponent is what sets
        // the flank profile, and it is where the asymmetry enters.
        const across = clamp01(1 - distance / Math.max(halfWidth, 1));

        // 03 §3.5, the single most important cliff rule.
        //
        // Note the direction. `across` is 1 on the spine and 0 at the coast, so pow(across, k)
        // with a LOW k stays near full height most of the way out and then plunges — that is
        // a cliff. A high k bleeds height away steadily from the crest — that is a gentle
        // flank. The first version had these the wrong way round and the gate caught it:
        // it measured 0.86:1, i.e. the exposed flank coming out gentler than the sheltered
        // one, which is precisely the asymmetry inverted.
        const cliffBias = smoothstep(-0.2, 0.6, exposure);
        const terraceBias = smoothstep(0.2, -0.6, exposure);
        const profileExp = 0.9 - 0.55 * cliffBias + 0.7 * terraceBias;
        const profile = Math.pow(across, profileExp);

        // Long-axis relief so the island is not one uniform ridge end to end.
        const crestRun = 0.55 + 0.45 * fbm(along * 3.1, s.seed * 0.001, 4, s.seed + 29);

        let h = s.peakHeight * profile * (0.45 + 0.55 * ridge) * crestRun * taper;

        // Terracing on the sheltered flank only — 03 §5.3, cultivation steps. Applied to the
        // height rather than the colour, so the silhouette carries it at altitude too.
        if (terraceBias > 0.05 && h > 4) {
          const stepH = 11;
          const terraced = Math.floor(h / stepH) * stepH + stepH * 0.5;
          h = h + (terraced - h) * terraceBias * 0.55;
        }

        // No positive floor: the profile already runs to zero at the coast, and forcing a
        // minimum here is what built the wall described above.
        this.height[i] = h;
      }
    }
  }

  /** Highest point, for the gate and for framing cameras. */
  get summit(): { x: number; z: number; height: number } {
    let best = -Infinity;
    let bx = 0;
    let bz = 0;
    for (let iz = 0; iz < this.resolution; iz++) {
      for (let ix = 0; ix < this.resolution; ix++) {
        const h = this.height[iz * this.resolution + ix]!;
        if (h > best) {
          best = h;
          bx = this.originX + ix * this.metresPerSample;
          bz = this.originZ + iz * this.metresPerSample;
        }
      }
    }
    return { x: bx, z: bz, height: best };
  }

  get landFraction(): number {
    let count = 0;
    for (let i = 0; i < this.land.length; i++) count += this.land[i]!;
    return count / this.land.length;
  }
}
