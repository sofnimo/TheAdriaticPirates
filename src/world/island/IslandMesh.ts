import * as THREE from 'three';
import type { IslandField } from './IslandField';

/**
 * THE TERRAIN MESH — §1.2's heightmap-displaced regular grid.
 *
 * THE MESH GRID IS THE FIELD GRID, SUBSAMPLED BY A WHOLE NUMBER. An independent grid stretched
 * to fit a bounding box re-samples the field at a non-integer ratio, and the interpolation
 * weight then cycles with a fixed period across the island — a REGULAR aliasing pattern, which
 * the eye reads as banding running the length of the ridge. Snapping to an integer stride
 * means every vertex sits exactly on a sample: the height is read, not reconstructed, and the
 * normals are central differences over the mesh's own neighbours, so the shaded surface is the
 * drawn surface.
 *
 * WHY THE TRIM IS A DEPTH CONTOUR AND NOTHING ELSE. The old builder dropped any quad whose
 * four corners were all below a cut-off depth, on a seabed that carried the same noise as the
 * land. A noisy field crossing a threshold produces a ragged boundary, and a ragged boundary
 * on a mesh edge is a row of triangular spikes — the underwater "teeth" behind every island.
 * Two things fix it together and neither is sufficient alone:
 *
 *   1. `topography.ts` fades all seabed roughness out by 25 m of depth, so the contour this
 *      trim runs along is a smooth curve rather than a noisy one;
 *   2. the trim sits at 45 m, far below the roughness AND far below anything a wave trough can
 *      expose, so the boundary is under opaque water even at the deepest trough.
 */

export interface IslandMeshResult {
  geometry: THREE.BufferGeometry;
  triangles: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Metres below sea level past which submerged terrain is not meshed. See the header. */
const TRIM_DEPTH = 45;
/** Metres of sea kept around the land box before the trim gets a say. */
const SHORE_PAD = 700;

export interface IslandMeshOptions {
  readonly bounds?: IslandMeshResult['bounds'];
  /** Metres per grid segment — the knob the triangle budget is spent with. */
  readonly metresPerSegment?: number;
  /** Hard cap on segments across either axis, whatever the density asks for. */
  readonly maxSegments?: number;
}

export function buildIslandMesh(field: IslandField, options: IslandMeshOptions = {}): IslandMeshResult {
  const res = field.resolution;
  const mps = field.metresPerSample;
  const request = padBounds(options.bounds ?? landBounds(field), SHORE_PAD);

  const toIndex = (world: number, origin: number): number =>
    Math.max(0, Math.min(res - 1, Math.round((world - origin) / mps)));
  const ix0 = toIndex(request.minX, field.originX);
  const ix1 = toIndex(request.maxX, field.originX);
  const iz0 = toIndex(request.minZ, field.originZ);
  const iz1 = toIndex(request.maxZ, field.originZ);

  const cap = options.maxSegments ?? 384;
  let stride = Math.max(1, Math.round((options.metresPerSegment ?? 9) / mps));
  let nx = 0;
  let nz = 0;
  for (;;) {
    nx = Math.floor((ix1 - ix0) / stride);
    nz = Math.floor((iz1 - iz0) / stride);
    if (Math.max(nx, nz) <= cap || stride > res) break;
    stride++;
  }
  nx = Math.max(2, nx);
  nz = Math.max(2, nz);

  const step = stride * mps;
  const sampleX = (i: number): number => Math.min(res - 1, ix0 + i * stride);
  const sampleZ = (j: number): number => Math.min(res - 1, iz0 + j * stride);

  const vertexCount = (nx + 1) * (nz + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const exposures = new Float32Array(vertexCount);
  const heights = new Float32Array(vertexCount);

  for (let j = 0; j <= nz; j++) {
    const sz = sampleZ(j);
    const z = field.originZ + sz * mps;
    for (let i = 0; i <= nx; i++) {
      const sx = sampleX(i);
      const v = j * (nx + 1) + i;
      const s = sz * res + sx;
      heights[v] = field.height[s]!;
      positions[v * 3 + 0] = field.originX + sx * mps;
      positions[v * 3 + 1] = heights[v]!;
      positions[v * 3 + 2] = z;
      exposures[v] = field.exposure[s]!;
    }
  }

  const at = (i: number, j: number): number => heights[j * (nx + 1) + i]!;
  const normal = new THREE.Vector3();
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const iL = Math.max(0, i - 1);
      const iR = Math.min(nx, i + 1);
      const jD = Math.max(0, j - 1);
      const jU = Math.min(nz, j + 1);
      const dhdx = (at(iR, j) - at(iL, j)) / ((iR - iL) * step);
      const dhdz = (at(i, jU) - at(i, jD)) / ((jU - jD) * step);
      normal.set(-dhdx, 1, -dhdz).normalize();
      const v = j * (nx + 1) + i;
      normals[v * 3 + 0] = normal.x;
      normals[v * 3 + 1] = normal.y;
      normals[v * 3 + 2] = normal.z;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const deep =
        at(i, j) <= -TRIM_DEPTH && at(i + 1, j) <= -TRIM_DEPTH &&
        at(i, j + 1) <= -TRIM_DEPTH && at(i + 1, j + 1) <= -TRIM_DEPTH;
      if (deep) continue;
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + (nx + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aExposure', new THREE.BufferAttribute(exposures, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return {
    geometry,
    triangles: indices.length / 3,
    bounds: {
      minX: field.originX + sampleX(0) * mps,
      maxX: field.originX + sampleX(nx) * mps,
      minZ: field.originZ + sampleZ(0) * mps,
      maxZ: field.originZ + sampleZ(nz) * mps,
    },
  };
}

function padBounds(b: IslandMeshResult['bounds'], pad: number): IslandMeshResult['bounds'] {
  return { minX: b.minX - pad, maxX: b.maxX + pad, minZ: b.minZ - pad, maxZ: b.maxZ + pad };
}

function landBounds(field: IslandField): IslandMeshResult['bounds'] {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
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
  return Number.isFinite(minX)
    ? { minX, maxX, minZ, maxZ }
    : { minX: field.originX, maxX: field.originX + field.worldSize, minZ: field.originZ, maxZ: field.originZ + field.worldSize };
}
