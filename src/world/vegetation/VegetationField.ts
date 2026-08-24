import { valueNoise } from '../island/noise';
import type { BiomeField } from '../island/BiomeField';
import type { IslandField } from '../island/IslandField';
import { SPECIES, SPECIES_NAMES, type SpeciesName } from './VegetationSpec';

/**
 * VEGETATION PLACEMENT — `03 — Procedural Islands.md` §8.3.
 *
 * "Per-species density is a texture baked once per chunk from the biome assignment (§7) plus
 * a blue-noise (Poisson-disc) jitter for placement — blue noise avoids both clumping and
 * grid-alignment artifacts."
 *
 * The density map is `BiomeField.density`, which is already baked; this is the jitter half.
 * A jittered grid at the species' own spacing, one candidate per cell, accepted against the
 * density field. That is not a true Poisson-disc set, and the difference matters in exactly
 * one direction worth writing down: a jittered grid guarantees a MINIMUM spacing (two
 * candidates in adjacent cells can be no closer than `spacing * (1 - 2*jitter)`), which is
 * the property the doc wants it for — no clumping — while a true dart-throwing pass would
 * also guarantee an even fill, which nothing here needs because the density field is
 * deliberately patchy. Per-species grids are offset from each other so a bush and an oak do
 * not share a lattice.
 *
 * Everything is a pure function of the island seed (§1.1). Nothing samples a shader, and
 * nothing here re-derives a field the CPU already baked — biome, density and slope all come
 * from `BiomeField`, which is the point of that class existing.
 */

export interface Instance {
  x: number;
  y: number;
  z: number;
  /** Radians. */
  yaw: number;
  scale: number;
  /** Which of the species' two colour maps this instance uses. */
  mapIndex: 0 | 1;
  /** 0-1, phase offset for the wind sway. */
  phase: number;
}

export interface PlacementStats {
  /** Candidates the grid produced, before any rejection. */
  candidates: number;
  /** Rejected because the density field was zero or the roll failed. */
  rejectedDensity: number;
  /** Rejected because the biome does not host this species. */
  rejectedBiome: number;
  /** Rejected because the ground was too steep — 03 §3.1's bare cliffs. */
  rejectedSlope: number;
  /** Rejected because the site was below the splash line or in the sea. */
  rejectedShore: number;
}

export interface SpeciesPlacement {
  species: SpeciesName;
  instances: Instance[];
  stats: PlacementStats;
}

/** Above this slope nothing is planted at all, whatever the density field says. */
const MAX_PLANTING_SLOPE = 0.62;
/** Metres above sea level below which the ground is wave-washed rock. */
const MIN_PLANTING_HEIGHT = 2.0;

export class VegetationField {
  readonly placements: Readonly<Record<SpeciesName, SpeciesPlacement>>;

  constructor(
    private readonly island: IslandField,
    private readonly biomes: BiomeField,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    densityScale = 1,
  ) {
    const out: Partial<Record<SpeciesName, SpeciesPlacement>> = {};
    for (let s = 0; s < SPECIES_NAMES.length; s++) {
      const name = SPECIES_NAMES[s]!;
      out[name] = this.place(name, bounds, s, densityScale);
    }
    this.placements = out as Record<SpeciesName, SpeciesPlacement>;
  }

  get total(): number {
    return SPECIES_NAMES.reduce((n, s) => n + this.placements[s].instances.length, 0);
  }

  private place(
    name: SpeciesName,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    speciesIndex: number,
    densityScale: number,
  ): SpeciesPlacement {
    const spec = SPECIES[name];
    const seed = this.island.spec.seed + speciesIndex * 1013;
    const step = spec.spacing;
    // Offset each species' lattice by an irrational fraction of its own spacing, so the four
    // grids never share a cell boundary and a clearing in one is not a clearing in all four.
    const offX = bounds.minX + step * (speciesIndex * 0.37);
    const offZ = bounds.minZ + step * (speciesIndex * 0.61);

    const instances: Instance[] = [];
    const stats: PlacementStats = {
      candidates: 0,
      rejectedDensity: 0,
      rejectedBiome: 0,
      rejectedSlope: 0,
      rejectedShore: 0,
    };

    const nx = Math.ceil((bounds.maxX - offX) / step);
    const nz = Math.ceil((bounds.maxZ - offZ) / step);

    for (let jz = 0; jz < nz; jz++) {
      for (let jx = 0; jx < nx; jx++) {
        stats.candidates++;

        // Jitter inside the cell. 0.4 of a cell either way keeps the minimum-spacing
        // guarantee at 0.2 * spacing while removing every trace of the lattice.
        const r1 = valueNoise(jx * 1.7 + 0.5, jz * 1.3 + 0.5, seed);
        const r2 = valueNoise(jx * 2.3 + 11.7, jz * 1.9 + 5.1, seed + 7);
        const r3 = valueNoise(jx * 0.9 + 31.3, jz * 3.1 + 17.9, seed + 19);
        const r4 = valueNoise(jx * 4.1 + 3.7, jz * 0.7 + 23.3, seed + 41);

        const x = offX + (jx + 0.5 + (r1 - 0.5) * 0.8) * step;
        const z = offZ + (jz + 0.5 + (r2 - 0.5) * 0.8) * step;

        if (!this.island.isLand(x, z)) {
          stats.rejectedShore++;
          continue;
        }
        const y = this.island.heightAt(x, z);
        if (y < MIN_PLANTING_HEIGHT) {
          stats.rejectedShore++;
          continue;
        }
        if (this.biomes.slopeAt(x, z) > MAX_PLANTING_SLOPE) {
          stats.rejectedSlope++;
          continue;
        }

        const biomeWeight = spec.biomes[this.biomes.biomeAt(x, z)] ?? 0;
        if (biomeWeight <= 0) {
          stats.rejectedBiome++;
          continue;
        }

        const density = this.biomes.densityAt(x, z) * biomeWeight * densityScale;
        if (r3 > density) {
          stats.rejectedDensity++;
          continue;
        }

        const [lo, hi] = spec.scaleRange;
        instances.push({
          x,
          // Sunk a little, so a lumpy base ring on sloping ground never shows daylight under
          // the canopy. The mesh's own base ring is well inside its silhouette, so this
          // costs nothing visible.
          y: y - spec.height * 0.02,
          z,
          yaw: r4 * Math.PI * 2,
          scale: lo + (hi - lo) * r1,
          // 03 §8.3's phase offset, and the colour-map choice. Both come off the same
          // deterministic rolls, so re-running generation reproduces the same forest.
          mapIndex: r2 > 0.5 ? 1 : 0,
          phase: r3,
        });
      }
    }

    return { species: name, instances, stats };
  }

  /** Instances per species, for the gate and the HUD. */
  counts(): Record<SpeciesName, number> {
    const out: Partial<Record<SpeciesName, number>> = {};
    for (const s of SPECIES_NAMES) out[s] = this.placements[s].instances.length;
    return out as Record<SpeciesName, number>;
  }

  /**
   * Nearest-neighbour distance statistics for one species.
   *
   * This is what proves the jittered grid did the job it is here for. Clumping shows up as a
   * minimum distance near zero; grid alignment shows up as a nearest-neighbour distance that
   * is always the same number. Neither is visible in a screenshot of a hillside.
   */
  spacingStats(name: SpeciesName): { min: number; mean: number; count: number } {
    const pts = this.placements[name].instances;
    if (pts.length < 2) return { min: 0, mean: 0, count: pts.length };

    // Bucket by the species' own spacing so this stays linear rather than quadratic.
    const cell = SPECIES[name].spacing;
    const grid = new Map<string, Instance[]>();
    for (const p of pts) {
      const key = Math.floor(p.x / cell) + ':' + Math.floor(p.z / cell);
      const bucket = grid.get(key);
      if (bucket) bucket.push(p);
      else grid.set(key, [p]);
    }

    let min = Infinity;
    let sum = 0;
    let n = 0;
    for (const p of pts) {
      const cx = Math.floor(p.x / cell);
      const cz = Math.floor(p.z / cell);
      let best = Infinity;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = grid.get(cx + dx + ':' + (cz + dz));
          if (!bucket) continue;
          for (const q of bucket) {
            if (q === p) continue;
            const d = Math.hypot(q.x - p.x, q.z - p.z);
            if (d < best) best = d;
          }
        }
      }
      if (!Number.isFinite(best)) continue;
      if (best < min) min = best;
      sum += best;
      n++;
    }
    return {
      min: Number.isFinite(min) ? min : 0,
      mean: n ? sum / n : 0,
      count: pts.length,
    };
  }

  /** Fraction of instances standing on ground steeper than the planting limit. Must be 0. */
  onCliffFraction(): number {
    let bad = 0;
    let total = 0;
    for (const s of SPECIES_NAMES) {
      for (const p of this.placements[s].instances) {
        total++;
        if (this.biomes.slopeAt(p.x, p.z) > MAX_PLANTING_SLOPE) bad++;
      }
    }
    return total ? bad / total : 0;
  }

  /** Fraction of instances whose biome does not host their species. Must be 0. */
  offBiomeFraction(): number {
    let bad = 0;
    let total = 0;
    for (const s of SPECIES_NAMES) {
      const spec = SPECIES[s];
      for (const p of this.placements[s].instances) {
        total++;
        if ((spec.biomes[this.biomes.biomeAt(p.x, p.z)] ?? 0) <= 0) bad++;
      }
    }
    return total ? bad / total : 0;
  }

  /** Fraction of instances below the splash line or in the water. Must be 0. */
  inSeaFraction(): number {
    let bad = 0;
    let total = 0;
    for (const s of SPECIES_NAMES) {
      for (const p of this.placements[s].instances) {
        total++;
        if (!this.island.isLand(p.x, p.z) || this.island.heightAt(p.x, p.z) < MIN_PLANTING_HEIGHT) bad++;
      }
    }
    return total ? bad / total : 0;
  }
}

export const PLANTING_LIMITS = Object.freeze({
  maxSlope: MAX_PLANTING_SLOPE,
  minHeight: MIN_PLANTING_HEIGHT,
});

