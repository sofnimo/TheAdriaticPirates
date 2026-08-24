import * as THREE from 'three';
import { clamp01, fbm, smoothstep } from '../island/noise';
import { BIOME, type BiomeField } from '../island/BiomeField';
import type { IslandField } from '../island/IslandField';
import { LOD } from './VegetationSpec';

/**
 * CANOPY AS MASS — `03 — Procedural Islands.md` §8.2's far LOD.
 *
 * "At far distance (dense-forest biome, viewed from altitude), do not render individual
 * trees at all — replace with a single low-poly hull mesh matching the forest patch's
 * silhouette, shaded with the same stepped forest-shadow ramp, optionally with a coarse
 * noise-perturbed top surface for canopy bumpiness."
 *
 * This is not a fallback that only matters at range. 00 §3 rule 9 puts the game camera at
 * 200-1500 m, so the mass IS the primary representation of a forest and the instances are
 * what happens when the plane comes down. The hull is therefore always drawn, and the
 * instances shrink into it rather than the other way round — see foliage.vert.glsl, where an
 * instance past `LOD.farRange` collapses to nothing and this carries the silhouette alone.
 *
 * The silhouette is the whole point. Cover colour on flat terrain gives an aerial view a
 * green PATCH; a lifted hull gives it a green MASS with a lit top and a shaded flank, which
 * is what every forest in the reference frames actually is.
 */

export interface CanopyMassResult {
  geometry: THREE.BufferGeometry;
  triangles: number;
  /** Fraction of the island's land area the canopy hull covers. */
  landCoverFraction: number;
}

/** Metres between hull vertices. Coarse on purpose — this is a mass, not a tree. */
const HULL_STEP = 14;
/** Below this canopy fraction the hull is not emitted at all, so patches have edges. */
const EDGE_CUTOFF = 0.06;

/**
 * Canopy fraction at a point: how much of a forest is here, 0-1.
 *
 * Smoothed over a radius rather than read per texel. A hull built straight off the biome
 * enum would have a hard cliff at every cell boundary and the "patch silhouette" would be
 * the 55 m Voronoi lattice, in relief, which is the lattice-visible failure 00 §3 rule 7
 * bans — and far more obvious in geometry than it ever was in colour.
 */
function canopyAt(biomes: BiomeField, x: number, z: number): number {
  const R = 22;
  let sum = 0;
  let weight = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const w = dx === 0 && dz === 0 ? 2 : 1;
      const b = biomes.biomeAt(x + dx * R, z + dz * R);
      const d = biomes.densityAt(x + dx * R, z + dz * R);
      const canopy = b === BIOME.denseForest ? 1 : b === BIOME.sparseForest ? 0.55 : 0;
      sum += canopy * d * w;
      weight += w;
    }
  }
  return clamp01(sum / weight);
}

export function buildCanopyMass(island: IslandField, biomes: BiomeField,
                                bounds: { minX: number; maxX: number; minZ: number; maxZ: number }): CanopyMassResult {
  const nx = Math.max(2, Math.ceil((bounds.maxX - bounds.minX) / HULL_STEP));
  const nz = Math.max(2, Math.ceil((bounds.maxZ - bounds.minZ) / HULL_STEP));
  const stepX = (bounds.maxX - bounds.minX) / nx;
  const stepZ = (bounds.maxZ - bounds.minZ) / nz;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  /** Metres this vertex sits above the terrain. The shader needs it to retract the hull. */
  const lifts: number[] = [];
  // -1 where no vertex was emitted; the quad loop skips any quad with a missing corner.
  const vertexOf = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  const canopy = new Float32Array((nx + 1) * (nz + 1));

  let covered = 0;
  let landSamples = 0;

  for (let j = 0; j <= nz; j++) {
    const z = bounds.minZ + j * stepZ;
    for (let i = 0; i <= nx; i++) {
      const x = bounds.minX + i * stepX;
      const k = j * (nx + 1) + i;
      if (island.isLand(x, z)) landSamples++;

      const c = canopyAt(biomes, x, z);
      canopy[k] = c;
      if (c < EDGE_CUTOFF || !island.isLand(x, z)) continue;
      covered++;

      // Lift, tapered to zero at the patch edge so the hull meets the ground rather than
      // ending in a wall. `smoothstep` from the cutoff, not from zero, or the taper starts
      // where the mesh has already stopped existing.
      const lift = LOD.canopyLift * smoothstep(EDGE_CUTOFF, 0.55, c);
      // Coarse bumpiness — §8.2's "noise-perturbed top surface". Two scales: crown-sized
      // lumps and a slower undulation, so a hillside of forest is not one smooth shell.
      const bump = (fbm(x / 46, z / 46, 3, island.spec.seed + 91) - 0.5) * 3.4
                 + (fbm(x / 175, z / 175, 2, island.spec.seed + 137) - 0.5) * 2.6;

      const total = lift + bump * smoothstep(EDGE_CUTOFF, 0.4, c);
      vertexOf[k] = positions.length / 3;
      positions.push(x, island.heightAt(x, z) + total, z);
      normals.push(0, 1, 0);
      lifts.push(total);
    }
  }

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = vertexOf[j * (nx + 1) + i]!;
      const b = vertexOf[j * (nx + 1) + i + 1]!;
      const c = vertexOf[(j + 1) * (nx + 1) + i]!;
      const d = vertexOf[(j + 1) * (nx + 1) + i + 1]!;
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aLift', new THREE.Float32BufferAttribute(lifts, 1));
  geometry.setIndex(indices);
  // Normals from the built surface, not from the terrain underneath: the lift and the bump
  // are exactly what gives the mass its lit top and shaded flank, and reusing the ground's
  // normals would light the canopy as though it were flat.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return {
    geometry,
    triangles: indices.length / 3,
    landCoverFraction: landSamples ? covered / landSamples : 0,
  };
}
