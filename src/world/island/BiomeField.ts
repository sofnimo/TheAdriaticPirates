import * as THREE from 'three';
import { clamp01, fbm, smoothstep } from './noise';
import type { IslandField } from './IslandField';

/**
 * THE BIOME FIELD — `03 — Procedural Islands.md` §7, baked once, read by everything.
 *
 * This exists because §8's vegetation and §7's ground cover have to agree. A cypress
 * standing on pasture-coloured ground is not a tuning problem, it is two systems answering
 * the same question separately — the exact failure `02b` §1.2 made a rule about for the
 * shoreline, one step inland. The island already solved that for the coast by giving the
 * shore one array; this gives cover assignment one array too.
 *
 * Before this, `terrain_color.glsl` evaluated the biome per fragment from continuous fields.
 * That was correct on its own terms and impossible for the CPU to reproduce: the vegetation
 * placer would have had to reimplement `fbm2`/`hash22` in JS and hope the two agreed, which
 * is the two-owners bug with extra steps. The assignment now happens here, once, and the
 * shader samples the result.
 *
 * §7.3 is the art-direction-critical part and it survives intact: one biome per COARSE CELL
 * (55 m, jittered), never per texel, so the boundaries are shape-scale rather than the
 * speckled "noise mush" 00 §3 rule 7 forbids. The few-metre boundary wobble stays in the
 * shader, where it can be applied below texel resolution.
 */

/** 03 §7.2's table, in the order the doc lists it. Values are stored in the texture's R. */
export const BIOME = Object.freeze({
  sea: 0,
  beach: 1,
  bareRock: 2,
  macchia: 3,
  pasture: 4,
  denseForest: 5,
  sparseForest: 6,
  terrace: 7,
});

export const BIOME_NAMES: Record<number, string> = {
  0: 'sea',
  1: 'beach',
  2: 'bare rock',
  3: 'macchia',
  4: 'dry pasture',
  5: 'dense forest',
  6: 'sparse forest',
  7: 'terraced olive',
};

export interface BiomeFieldOptions {
  /** Cell size in metres. 03 §7.3: 30-80 — bigger than any tree cluster, smaller than a hillside. */
  readonly cellSize?: number;
}

export class BiomeField {
  readonly island: IslandField;
  readonly resolution: number;
  readonly cellSize: number;

  /** Per-texel biome id. One value per island-field texel. */
  readonly biome: Uint8Array;
  /** Metres to the nearest sea texel — 03 §7.1's distance-to-sea driving field. */
  readonly distanceToSea: Float32Array;
  /** 0-1 moisture — §7.1: low-frequency noise, dried by altitude and by SW exposure. */
  readonly moisture: Float32Array;
  /** 0-1 vegetation cover density. What §8.3's placement density map is baked from. */
  readonly density: Float32Array;
  /** 0-1 terrain slope, 0 flat. Cached so the placer does not re-difference the heightmap. */
  readonly slope: Float32Array;

  /** RGBA8, NearestFilter: R = biome id, G = density, B = moisture. */
  readonly texture: THREE.DataTexture;

  constructor(island: IslandField, options: BiomeFieldOptions = {}) {
    this.island = island;
    this.resolution = island.resolution;
    this.cellSize = options.cellSize ?? 55;

    const n = this.resolution * this.resolution;
    this.biome = new Uint8Array(n);
    this.distanceToSea = new Float32Array(n);
    this.moisture = new Float32Array(n);
    this.density = new Float32Array(n);
    this.slope = new Float32Array(n);

    this.bakeDistanceToSea();
    this.bakeSlope();
    this.assign();
    this.texture = this.bakeTexture();
  }

  // ------------------------------------------------------------------ lookups

  private index(x: number, z: number): number {
    const f = this.island;
    const ix = Math.max(0, Math.min(this.resolution - 1, Math.round((x - f.originX) / f.metresPerSample)));
    const iz = Math.max(0, Math.min(this.resolution - 1, Math.round((z - f.originZ) / f.metresPerSample)));
    return iz * this.resolution + ix;
  }

  biomeAt(x: number, z: number): number {
    return this.biome[this.index(x, z)]!;
  }

  densityAt(x: number, z: number): number {
    return this.density[this.index(x, z)]!;
  }

  slopeAt(x: number, z: number): number {
    return this.slope[this.index(x, z)]!;
  }

  distanceToSeaAt(x: number, z: number): number {
    return this.distanceToSea[this.index(x, z)]!;
  }

  /** World-space min corner, for the shader's texture lookup. */
  get mapOrigin(): [number, number] {
    return [this.island.originX, this.island.originZ];
  }

  get mapSize(): number {
    return this.island.worldSize;
  }

  // ------------------------------------------------------------------ bake

  /**
   * Two-pass chamfer distance transform on the land mask.
   *
   * 03 §7.1 lists distance-to-sea as a driving field and the biome table uses it in three
   * rows ("near coast", "mid", "inland"). A chamfer pass is exact enough at this scale and
   * runs in two sweeps over the grid rather than a search per texel.
   */
  private bakeDistanceToSea(): void {
    const n = this.resolution;
    const m = this.island.metresPerSample;
    const d = this.distanceToSea;
    const BIG = 1e9;

    for (let i = 0; i < d.length; i++) d[i] = this.island.land[i] === 1 ? BIG : 0;

    const straight = m;
    const diag = m * Math.SQRT2;

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        if (d[i] === 0) continue;
        let best = d[i]!;
        if (ix > 0) best = Math.min(best, d[i - 1]! + straight);
        if (iz > 0) best = Math.min(best, d[i - n]! + straight);
        if (ix > 0 && iz > 0) best = Math.min(best, d[i - n - 1]! + diag);
        if (ix < n - 1 && iz > 0) best = Math.min(best, d[i - n + 1]! + diag);
        d[i] = best;
      }
    }
    for (let iz = n - 1; iz >= 0; iz--) {
      for (let ix = n - 1; ix >= 0; ix--) {
        const i = iz * n + ix;
        let best = d[i]!;
        if (ix < n - 1) best = Math.min(best, d[i + 1]! + straight);
        if (iz < n - 1) best = Math.min(best, d[i + n]! + straight);
        if (ix < n - 1 && iz < n - 1) best = Math.min(best, d[i + n + 1]! + diag);
        if (ix > 0 && iz < n - 1) best = Math.min(best, d[i + n - 1]! + diag);
        d[i] = best;
      }
    }
  }

  /** Slope magnitude in 0-1, from the same central differences the mesh normals use. */
  private bakeSlope(): void {
    const n = this.resolution;
    const f = this.island;
    const eps = f.metresPerSample;
    for (let iz = 0; iz < n; iz++) {
      const z = f.originZ + iz * eps;
      for (let ix = 0; ix < n; ix++) {
        const x = f.originX + ix * eps;
        const gx = (f.heightAt(x + eps, z) - f.heightAt(x - eps, z)) / (2 * eps);
        const gz = (f.heightAt(x, z + eps) - f.heightAt(x, z - eps)) / (2 * eps);
        // The same quantity the shader uses: 1 - N.y, N being the heightmap normal.
        const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);
        this.slope[iz * n + ix] = clamp01(1 - ny);
      }
    }
  }

  /**
   * 03 §7.3's two-stage assignment.
   *
   * Stage 1: score the driving fields AT COARSE CELL CENTRES, on a jittered lattice so the
   * result is not axis-aligned rectangles. Stage 2: every texel inherits its cell's biome.
   *
   * Slope is deliberately NOT part of the cell decision. It varies far faster than the cell
   * size, so a cell-centre slope would paint bare rock across a whole hillside because one
   * point in the middle of it happened to be steep. The cover-to-rock blend stays
   * per-fragment in `terrain_color.glsl`, which is where §3.1 puts it.
   */
  private assign(): void {
    const n = this.resolution;
    const f = this.island;
    const cell = this.cellSize;
    const peak = f.spec.peakHeight;

    // One decision per cell, memoised — at 55 m cells and 4 m texels the same cell is hit
    // by ~190 texels, and the scoring function is the expensive part of this bake.
    const cache = new Map<number, { biome: number; moisture: number }>();

    for (let iz = 0; iz < n; iz++) {
      const z = f.originZ + iz * f.metresPerSample;
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const x = f.originX + ix * f.metresPerSample;

        if (f.land[i] !== 1) {
          this.biome[i] = BIOME.sea;
          continue;
        }

        const cx = Math.floor(x / cell);
        const cz = Math.floor(z / cell);
        const key = (cz + 4096) * 16384 + (cx + 4096);
        let decided = cache.get(key);
        if (decided === undefined) {
          // Jitter the cell centre inside its own cell, so two neighbouring cells never
          // share an axis-aligned boundary — the lattice must not be visible (00 §3 rule 7).
          const jx = fbm(cx * 0.71, cz * 0.53, 2, f.spec.seed + 5) - 0.5;
          const jz = fbm(cx * 0.61 + 9.1, cz * 0.83 + 3.7, 2, f.spec.seed + 13) - 0.5;
          decided = this.scoreAt((cx + 0.5 + jx * 0.8) * cell, (cz + 0.5 + jz * 0.8) * cell, peak);
          cache.set(key, decided);
        }

        this.biome[i] = decided.biome;
        this.moisture[i] = decided.moisture;

        // Density is per texel, not per cell: it is a continuous field the placer samples,
        // and 03 §8.3 wants it falling off at a patch edge rather than stopping at one.
        this.density[i] = this.densityFor(decided.biome, x, z, i, peak);
      }
    }
  }

  /** 03 §7.2's table read top to bottom, evaluated at one cell centre. */
  private scoreAt(x: number, z: number, peak: number): { biome: number; moisture: number } {
    const f = this.island;
    const i = this.index(x, z);
    const h01 = clamp01(f.heightAt(x, z) / Math.max(peak, 1));
    const exposure = f.exposure[i]!;
    const distSea = this.distanceToSea[i]!;

    // §7.1's moisture: low-frequency noise, reduced with altitude and with SW exposure
    // (bora-dried). Karst has no surface drainage (§0.3, §6.1), so there is no river term.
    const base = fbm(x / 620, z / 620, 3, f.spec.seed + 41);
    const dry = clamp01(exposure * 0.5 + 0.5);
    const moisture = clamp01(base * 1.15 - dry * 0.42 - h01 * 0.3 + 0.12);
    // "Inland" on a 672 m wide island is not the same distance as "inland" on a continent.
    // The first cut of this used smoothstep(60, 420) and required 0.45 of it, which is 230 m
    // from the sea — a threshold only the central spine of a Dalmatian island ever clears.
    // Dense forest came out at 5% of the land and the island read as bare scrub from the
    // air, against a reference frame (peninsula-coastline-aerial-clouds) that is wooded
    // almost to the waterline.
    const inland = smoothstep(40, 220, distSea);

    let biome: number;
    if (f.heightAt(x, z) < 2.5 && distSea < 30) {
      biome = BIOME.beach;
    } else if (h01 > 0.72) {
      // High ground is bare or sparsely wooded; the doc puts dense forest at mid altitude.
      biome = moisture > 0.45 ? BIOME.sparseForest : BIOME.bareRock;
    } else if (moisture > 0.5 && h01 > 0.12 && inland > 0.3) {
      biome = BIOME.denseForest;
    } else if (exposure < -0.05 && distSea < 280 && h01 < 0.45) {
      // Terraced olive/vine: sheltered flank, near coast — and §5.3 already cut the steps
      // into the heightmap on exactly that flank, so the cover lands on the terraces.
      // Checked BEFORE sparse forest, or the moisture the sheltered flank gets by virtue of
      // being sheltered would claim the whole terraced band for woodland.
      biome = BIOME.terrace;
    } else if (moisture > 0.34) {
      biome = BIOME.sparseForest;
    } else if (dry > 0.5) {
      biome = BIOME.macchia;
    } else {
      biome = BIOME.pasture;
    }

    return { biome, moisture };
  }

  /**
   * Vegetation cover density — what §8.3's placement density map is.
   *
   * Two suppressions apply regardless of biome, and both come from the reference frames as
   * much as from the doc: nothing grows on a cliff face (§3.1 blends those to bare
   * limestone), and nothing grows in the splash zone.
   */
  private densityFor(biome: number, x: number, z: number, i: number, peak: number): number {
    const byBiome: Record<number, number> = {
      [BIOME.sea]: 0,
      [BIOME.beach]: 0,
      [BIOME.bareRock]: 0.06,
      [BIOME.macchia]: 0.55,
      [BIOME.pasture]: 0.12,
      [BIOME.denseForest]: 1.0,
      [BIOME.sparseForest]: 0.5,
      [BIOME.terrace]: 0.45,
    };
    let d = byBiome[biome] ?? 0;
    if (d <= 0) return 0;

    // Cliffs are bare. The 0.42-0.62 window is the same slope band §3.1's cover-to-rock
    // blend uses, so the trees stop exactly where the ground turns to limestone rather than
    // a little before it or a little after.
    d *= 1 - smoothstep(0.42, 0.62, this.slope[i]!);
    // Splash zone: the wave-washed collar in terrain_color is bare rock, so this is bare too.
    d *= smoothstep(1.5, 6.0, this.island.height[i]!);
    // Wind-stripped summits.
    d *= 1 - smoothstep(0.82, 1.0, clamp01(this.island.height[i]! / Math.max(peak, 1)));
    // Patch-scale gaps, so a forest is a shape with clearings in it rather than a fill.
    d *= clamp01(fbm(x / 130, z / 130, 3, this.island.spec.seed + 77) * 1.5 + 0.25);
    return clamp01(d);
  }

  private bakeTexture(): THREE.DataTexture {
    const n = this.resolution;
    const data = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      data[i * 4 + 0] = this.biome[i]!;
      data[i * 4 + 1] = Math.round(this.density[i]! * 255);
      data[i * 4 + 2] = Math.round(this.moisture[i]! * 255);
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    // NEAREST, and no colour-space conversion. R is an enum, not a colour — a
    // linear-to-sRGB pass over it would silently renumber every biome.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** Land-texel counts per biome, for the gate. */
  histogram(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of Object.values(BIOME)) out[BIOME_NAMES[id]!] = 0;
    for (let i = 0; i < this.biome.length; i++) {
      const name = BIOME_NAMES[this.biome[i]!];
      if (name !== undefined) out[name] = (out[name] ?? 0) + 1;
    }
    return out;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
