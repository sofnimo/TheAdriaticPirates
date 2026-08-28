import * as THREE from 'three';
import { ISLAND_COVER } from '../../art/islandCover';
import { clamp01, coverageThreshold, fbm, smoothstep } from './noise';
import type { IslandField } from './IslandField';

/**
 * THE THREE COVER MASKS — `05 — Distant Terrain Layering.md` §3.1.
 *
 * Three world-space control fields, baked once into one RGBA texture:
 *
 *   R  uDryGrassMask   fine, sparse, soft-edged dried-grass flecks inside the A0 green
 *   G  uLongGrassMask  medium-scale irregular islands of raised tier-B long grass
 *   B  uForestMask     broad, low-frequency oak forest regions
 *   A  suitability     the terrain's own veto: slope, altitude, and distance from the sea
 *
 * THEY DO NOT SHARE A NOISE SAMPLE. §3.1: "Do not reuse one noise sample at three thresholds.
 * That produces visibly nested contour lines." Each mask starts from its own seed and its own
 * scale; dry grass is correlated to the others only through one very-low-frequency moisture
 * field, which lets it prefer the drier side of an island without tracing anyone's edges.
 *
 * TIER C IS THE ONE EXCEPTION, AND IT IS DELIBERATE. Oaks are confined to the long grass: the
 * forest mask keeps its own seed and its own broad scale, then is cut by tier B. So a forest
 * edge DOES trace a long-grass edge — that is the intent, trees standing in the grass rather
 * than on bare limestone — and it costs roughly two thirds of the crowns, because the wooded
 * fraction is now a fraction of the grass rather than of the whole island. `forestCoverage`
 * still reads as "of eligible ground"; what changed is what counts as eligible.
 *
 * SUITABILITY IS A MULTIPLIER, NOT A FOURTH MASK. §7.1: multiply by suitability rather than
 * letting noise put oaks on beaches, cliffs or water. Keeping it in its own channel means the
 * shader can apply the same veto to all three tiers, so the boundary where cover stops is the
 * same boundary for every tier and does not have to be maintained three times.
 */

/**
 * The low end of `longGrassWeight`'s breakup term in land_cover.glsl, `mix(0.75, 1.25, ...)`.
 *
 * Carried here rather than derived, because a .ts file and a .glsl file cannot share a
 * constant. If that mix ever changes, this follows it: it is what makes "wooded" a subset of
 * "grass that is actually drawn" rather than a subset of "grass on average".
 */
const LONG_GRASS_BREAKUP_MIN = 0.75;

/**
 * Half-width of the treeline's fade at the edge of a long-grass patch, in mask units.
 *
 * Narrow on purpose. This is a boundary the eye can see — a grove stopping where the grass
 * stops — and a wide blend would put a halo of thinning trees on ground that reads as bare.
 */
const GRASS_GATE_SOFTNESS = 0.08;

export interface CoverFieldOptions {
  /** Samples per side. Defaults to half the elevation field's, which is ample: these are
   *  shape-scale masks and baking them at terrain resolution buys nothing but memory. */
  readonly resolution?: number;
}

export class CoverField {
  readonly island: IslandField;
  readonly resolution: number;
  readonly metresPerSample: number;
  readonly texture: THREE.DataTexture;

  /** A1 dried grass, 0-1. */
  readonly dry: Float32Array;
  /** Tier B long grass occupancy, 0-1. */
  readonly long: Float32Array;
  /** Tier C forest weight, 0-1. The single source of truth for where forest exists (§7.1). */
  readonly forest: Float32Array;
  /** 0-1 terrain veto, shared by all three tiers. */
  readonly suitability: Float32Array;

  /** Driving fields, kept because the hull scatter and the probes both read them. */
  readonly slope: Float32Array;
  /** Metres inland of the coastline. 0 at sea. */
  readonly distanceToSea: Float32Array;

  constructor(island: IslandField, options: CoverFieldOptions = {}) {
    this.island = island;
    this.resolution = options.resolution ?? Math.max(128, Math.floor(island.resolution / 2));
    this.metresPerSample = island.worldSize / this.resolution;

    const n = this.resolution;
    const count = n * n;
    this.dry = new Float32Array(count);
    this.long = new Float32Array(count);
    this.forest = new Float32Array(count);
    this.suitability = new Float32Array(count);
    this.slope = new Float32Array(count);
    this.distanceToSea = new Float32Array(count);

    this.texture = new THREE.DataTexture(
      new Uint8Array(count * 4), n, n, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;

    this.bake();
  }

  get mapOrigin(): [number, number] {
    return [this.island.originX, this.island.originZ];
  }

  get mapSize(): number {
    return this.island.worldSize;
  }

  worldX(ix: number): number {
    return this.island.originX + ix * this.metresPerSample;
  }

  worldZ(iz: number): number {
    return this.island.originZ + iz * this.metresPerSample;
  }

  /**
   * Tier C weight at a world point, nearest-sample.
   *
   * The hull scatter reads this rather than the texture, so CPU placement and the shader's own
   * `forestWeight` are looking at the same field. Nearest rather than bilinear on purpose: a
   * hull either is or is not placed, and interpolating only moves a grove edge by half a
   * sample while costing four taps per candidate.
   */
  forestAt(x: number, z: number): number {
    const n = this.resolution;
    const ix = Math.round((x - this.island.originX) / this.metresPerSample);
    const iz = Math.round((z - this.island.originZ) / this.metresPerSample);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return 0;
    return this.forest[iz * n + ix]!;
  }

  /** Re-run against the current `ISLAND_COVER` values. Structural edits call this. */
  bake(): void {
    const cfg = ISLAND_COVER;
    const n = this.resolution;
    const seed = this.island.spec.seed;

    this.bakeDrivingFields();

    // Hoisted: these are functions of the config alone. The blend half-widths beside them are
    // in raw fbm units, where one standard deviation is about 0.2 — so 0.12 is a little over
    // half a sigma, which is a patch with a readable outline rather than a soft cloud.
    const dryCut = coverageThreshold(cfg.dryCoverage);
    const longCut = coverageThreshold(cfg.longGrassCoverage);
    const forestCut = coverageThreshold(cfg.forestCoverage);

    for (let iz = 0; iz < n; iz++) {
      const z = this.worldZ(iz);
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const x = this.worldX(ix);

        if (this.distanceToSea[i]! <= 0) {
          this.dry[i] = 0; this.long[i] = 0; this.forest[i] = 0; this.suitability[i] = 0;
          continue;
        }

        // §7.1's suitability product. Every term is a veto the noise is not allowed to
        // override, which is why they multiply rather than blend.
        const gentle = 1 - smoothstep(cfg.coverMaxSlope - 0.14, cfg.coverMaxSlope, this.slope[i]!);
        const inland = smoothstep(0, 26, this.distanceToSea[i]!);
        const notShore = smoothstep(cfg.shoreSandWidth, cfg.shoreSandWidth + 18, this.distanceToSea[i]!);
        const suit = clamp01(gentle * inland * notShore);
        this.suitability[i] = suit;

        // One shared macro field. Broad enough that it never draws a visible boundary of its
        // own; its whole job is to make the three masks agree about which end of an island is
        // the greener one.
        const moisture = clamp01(fbm(x, z, seed ^ 0x4d01, cfg.moistureScale, 2) * 0.5 + 0.5);

        // --- R: dried grass, own seed, fine scale, two decorrelated octaves ---------------
        const dryRaw =
          fbm(x, z, seed ^ 0xd47, cfg.dryScale, 3) * (1 - cfg.dryDetailAmount) +
          fbm(x + 313, z - 197, seed ^ 0xd48, cfg.dryDetailScale, 2) * cfg.dryDetailAmount;
        this.dry[i] = clamp01(
          smoothstep(dryCut - cfg.drySoftness, dryCut + cfg.drySoftness,
            dryRaw - cfg.moistureBias * (moisture - 0.5)) * suit,
        );

        // --- G: long grass, own seed, medium scale ----------------------------------------
        const longRaw = fbm(x, z, seed ^ 0x1069, cfg.longGrassScale, 3);
        this.long[i] = clamp01(
          smoothstep(longCut - 0.12, longCut + 0.12,
            longRaw + cfg.moistureBias * 0.5 * (moisture - 0.5)) * suit,
        );

        // --- B: forest, own seed, broad scale ---------------------------------------------
        const forestRaw = fbm(x, z, seed ^ 0xf0e5, cfg.forestScale, 3);
        // Oaks want shelter: §7.1's "inlandOrSheltered". The exposure field already knows
        // which flank the bora scours, so the forest reads it rather than re-deriving it.
        const shelter = clamp01(0.62 - this.exposureAt(ix, iz) * 0.38);
        // OAKS STAND IN THE LONG GRASS AND NOWHERE ELSE.
        //
        // This is the one place tier C is deliberately NOT decorrelated from tier B. The rest
        // of the independence rule still holds — the forest keeps its own seed and its own
        // 420 m scale, so its regions are its own shape — but that shape is then cut to the
        // grass. What §3.1 actually warns against is thresholding ONE noise three times, which
        // draws visibly nested contours; two independent noises intersected draw no such
        // family of curves, only the ragged overlap of two unrelated patterns.
        //
        // Gated on the WORST-CASE breakup, not on the mean. `longGrassWeight` in
        // land_cover.glsl raggeds the patch edges with `mix(0.75, 1.25, breakup)` and the
        // overlay then discards below `uLongGrassThreshold`, so a texel whose baked occupancy
        // only just clears that threshold is grass in some places and bare in others according
        // to a noise this bake never sees. Requiring it to clear even at 0.75 keeps the crowns
        // over grass that is actually drawn, instead of leaving a fringe of trees standing on
        // bare ground wherever the breakup happened to cut the patch back.
        // The threshold is the LOWER bound of the blend, not its midpoint. Centring it there
        // let the fade reach below the line and put a handful of crowns on ground the overlay
        // was not guaranteed to be drawing — few enough to miss by eye, which is exactly why
        // it is worth pinning: below this occupancy the gate is zero, not merely small.
        const grassGate = smoothstep(
          cfg.longGrassThreshold,
          cfg.longGrassThreshold + GRASS_GATE_SOFTNESS,
          this.long[i]! * LONG_GRASS_BREAKUP_MIN,
        );
        this.forest[i] = clamp01(
          smoothstep(forestCut - 0.14, forestCut + 0.14,
            forestRaw + cfg.moistureBias * (moisture - 0.5)) * suit * shelter * grassGate,
        );
      }
    }

    this.upload();
  }

  private exposureAt(ix: number, iz: number): number {
    const s = this.island.resolution / this.resolution;
    const jx = Math.min(this.island.resolution - 1, Math.round(ix * s));
    const jz = Math.min(this.island.resolution - 1, Math.round(iz * s));
    return this.island.exposure[jz * this.island.resolution + jx]!;
  }

  /**
   * Slope and distance-to-sea, both read off the elevation field.
   *
   * Distance is a two-pass chamfer transform rather than an exact Euclidean one: it is used
   * for margins measured in tens of metres, its error is a few per cent, and the exact
   * transform already exists in the shore atlas for the one consumer that needs exactness.
   */
  private bakeDrivingFields(): void {
    const n = this.resolution;
    const mps = this.metresPerSample;
    const field = this.island;
    const s = field.resolution / n;

    const BIG = 1e9;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const jx = Math.min(field.resolution - 1, Math.round(ix * s));
        const jz = Math.min(field.resolution - 1, Math.round(iz * s));
        const j = jz * field.resolution + jx;

        const step = field.metresPerSample;
        const hx0 = field.height[jz * field.resolution + Math.max(0, jx - 1)]!;
        const hx1 = field.height[jz * field.resolution + Math.min(field.resolution - 1, jx + 1)]!;
        const hz0 = field.height[Math.max(0, jz - 1) * field.resolution + jx]!;
        const hz1 = field.height[Math.min(field.resolution - 1, jz + 1) * field.resolution + jx]!;
        const dx = (hx1 - hx0) / (2 * step);
        const dz = (hz1 - hz0) / (2 * step);
        this.slope[i] = 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);

        this.distanceToSea[i] = field.land[j] === 1 ? BIG : 0;
      }
    }

    const d = this.distanceToSea;
    const straight = mps;
    const diagonal = mps * Math.SQRT2;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        if (d[i] === 0) continue;
        let best = d[i]!;
        if (iz > 0) best = Math.min(best, d[i - n]! + straight);
        if (ix > 0) best = Math.min(best, d[i - 1]! + straight);
        if (iz > 0 && ix > 0) best = Math.min(best, d[i - n - 1]! + diagonal);
        if (iz > 0 && ix < n - 1) best = Math.min(best, d[i - n + 1]! + diagonal);
        d[i] = best;
      }
    }
    for (let iz = n - 1; iz >= 0; iz--) {
      for (let ix = n - 1; ix >= 0; ix--) {
        const i = iz * n + ix;
        if (d[i] === 0) continue;
        let best = d[i]!;
        if (iz < n - 1) best = Math.min(best, d[i + n]! + straight);
        if (ix < n - 1) best = Math.min(best, d[i + 1]! + straight);
        if (iz < n - 1 && ix < n - 1) best = Math.min(best, d[i + n + 1]! + diagonal);
        if (iz < n - 1 && ix > 0) best = Math.min(best, d[i + n - 1]! + diagonal);
        d[i] = best;
      }
    }
    for (let i = 0; i < d.length; i++) if (d[i]! >= BIG) d[i] = 0;
  }

  private upload(): void {
    const data = this.texture.image.data as Uint8Array;
    for (let i = 0; i < this.dry.length; i++) {
      data[i * 4 + 0] = Math.round(this.dry[i]! * 255);
      data[i * 4 + 1] = Math.round(this.long[i]! * 255);
      data[i * 4 + 2] = Math.round(this.forest[i]! * 255);
      data[i * 4 + 3] = Math.round(this.suitability[i]! * 255);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
