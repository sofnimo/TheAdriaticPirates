import * as THREE from 'three';
import type { IslandField } from './IslandField';

/**
 * Heightmap-displaced grid, built once on the CPU — `03 — Procedural Islands.md` §1.2.
 *
 * A regular grid rather than anything cleverer: the doc is explicit that 95% of the terrain
 * is representable as one height per XZ, and that marching-cubes escalation is reserved for
 * one or two hero overhangs (§3.4). This island has none, so it does not pay for them.
 *
 * The grid is cropped to the island's bounding box rather than covering the whole 4 km field.
 * Meshing empty sea would spend the entire triangle budget on triangles at y=0 that the ocean
 * already draws over.
 */

export interface IslandMeshResult {
  geometry: THREE.BufferGeometry;
  triangles: number;
  /** World-space bounds actually meshed, for the probe and for camera framing. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Metres below sea level past which submerged terrain is no longer meshed. */
const DEEP_CULL = 7;

export function buildIslandMesh(field: IslandField, segments = 384): IslandMeshResult {
  const bounds = landBounds(field, 120);

  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  const nx = segments;
  const nz = Math.max(8, Math.round((segments * spanZ) / Math.max(spanX, 1)));

  const vertexCount = (nx + 1) * (nz + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  // Per-vertex exposure, so the fragment shader can pick cliff versus terrace without
  // re-deriving the spine geometry it has no access to.
  const exposures = new Float32Array(vertexCount);

  for (let j = 0; j <= nz; j++) {
    const z = bounds.minZ + (spanZ * j) / nz;
    for (let i = 0; i <= nx; i++) {
      const x = bounds.minX + (spanX * i) / nx;
      const v = j * (nx + 1) + i;
      positions[v * 3 + 0] = x;
      positions[v * 3 + 1] = field.heightAt(x, z);
      positions[v * 3 + 2] = z;
      exposures[v] = field.exposure[clampIndex(field, x, z)]!;
    }
  }

  // Analytic-ish normals from the baked field rather than from the coarser mesh: the mesh is
  // sampled below the field's own resolution, and taking normals from the mesh would round
  // off exactly the cliff faces §3.3 exists to sharpen.
  const eps = field.metresPerSample;
  for (let j = 0; j <= nz; j++) {
    const z = bounds.minZ + (spanZ * j) / nz;
    for (let i = 0; i <= nx; i++) {
      const x = bounds.minX + (spanX * i) / nx;
      const v = j * (nx + 1) + i;
      const hL = field.heightAt(x - eps, z);
      const hR = field.heightAt(x + eps, z);
      const hD = field.heightAt(x, z - eps);
      const hU = field.heightAt(x, z + eps);
      const n = new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
      normals[v * 3 + 0] = n.x;
      normals[v * 3 + 1] = n.y;
      normals[v * 3 + 2] = n.z;
    }
  }

  // Index only the quads with at least one corner above water. A quad entirely at sea level
  // is invisible under the ocean surface and is pure cost.
  const indices: number[] = [];
  const heightOf = (i: number, j: number): number => positions[(j * (nx + 1) + i) * 3 + 1]!;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + (nx + 1);
      const d = c + 1;
      // Keep a submerged apron rather than culling at the waterline: the terrain now passes
      // UNDER the sea surface, and cutting it off at zero would put the mesh's edge exactly
      // where the intersection is, leaving a crack along the whole coast.
      const deep =
        heightOf(i, j) <= -DEEP_CULL && heightOf(i + 1, j) <= -DEEP_CULL &&
        heightOf(i, j + 1) <= -DEEP_CULL && heightOf(i + 1, j + 1) <= -DEEP_CULL;
      if (deep) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aExposure', new THREE.BufferAttribute(exposures, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return { geometry, triangles: indices.length / 3, bounds };
}

function clampIndex(field: IslandField, x: number, z: number): number {
  const ix = Math.max(0, Math.min(field.resolution - 1, Math.round((x - field.originX) / field.metresPerSample)));
  const iz = Math.max(0, Math.min(field.resolution - 1, Math.round((z - field.originZ) / field.metresPerSample)));
  return iz * field.resolution + ix;
}

/** Bounding box of the land mask, expanded by `pad` metres so the shore is never clipped. */
function landBounds(field: IslandField, pad: number): IslandMeshResult['bounds'] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let iz = 0; iz < field.resolution; iz++) {
    for (let ix = 0; ix < field.resolution; ix++) {
      if (field.land[iz * field.resolution + ix] !== 1) continue;
      const x = field.originX + ix * field.metresPerSample;
      const z = field.originZ + iz * field.metresPerSample;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
  return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
}
