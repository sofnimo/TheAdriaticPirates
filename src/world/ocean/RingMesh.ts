import * as THREE from 'three';

/**
 * Concentric ring ocean mesh — `02 — Water.md` §1.2.
 *
 * 02 compares projected-grid, CDLOD and simple concentric rings, and recommends shipping
 * the rings first: at altitude the mesh silhouette barely matters, and rings need no
 * quadtree bookkeeping or per-frame re-tessellation. Upgrade to a projected grid only if
 * geometry popping becomes visible during descent.
 *
 * The rings are square annuli of doubling extent, snapped to the camera each frame so they
 * are never re-tessellated. Displacement amplitude fades to zero before the boundary
 * between two ring resolutions, so the LOD change never produces a visible crack.
 */

export interface RingLevel {
  /** Half-extent in metres. */
  extent: number;
  /** Cells along one side of this level's grid. */
  cells: number;
}

/** 02 §6.1 starting point: radii ~50/150/400/1000/2500 m, halving density per ring. */
export const DEFAULT_RING_LEVELS: readonly RingLevel[] = [
  { extent: 50, cells: 96 },    // displaced near field
  { extent: 150, cells: 96 },
  { extent: 600, cells: 64 },
  // Horizon skirt. 02 §6.1's radii stop at 2500 m, which suits a world full of islands but
  // leaves the empty sea visibly ENDING short of the horizon. Beyond the 45 m displacement
  // fade the surface is dead flat, so vertex density out here buys nothing — one coarse
  // ring covers 600 m to 24 km and keeps the whole ocean inside 02 §6.3's 3-5 draw calls.
  { extent: 24000, cells: 32 },
];

/**
 * Builds one square annulus between `inner` and `outer` half-extents.
 * `inner` of 0 produces a filled square (the innermost patch).
 */
export function buildAnnulus(inner: number, outer: number, cells: number): THREE.BufferGeometry {
  const step = (outer * 2) / cells;
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexIndex = new Map<number, number>();

  const key = (ix: number, iz: number): number => ix * (cells + 3) + iz;

  const vertexAt = (ix: number, iz: number): number => {
    const k = key(ix, iz);
    const existing = vertexIndex.get(k);
    if (existing !== undefined) return existing;
    const x = -outer + ix * step;
    const z = -outer + iz * step;
    const index = positions.length / 3;
    positions.push(x, 0, z);
    vertexIndex.set(k, index);
    return index;
  };

  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const cx = -outer + (ix + 0.5) * step;
      const cz = -outer + (iz + 0.5) * step;
      // Skip cells that fall inside the hole; the next level inward covers them.
      if (inner > 0 && Math.abs(cx) < inner && Math.abs(cz) < inner) continue;

      const a = vertexAt(ix, iz);
      const b = vertexAt(ix + 1, iz);
      const c = vertexAt(ix + 1, iz + 1);
      const d = vertexAt(ix, iz + 1);
      indices.push(a, d, c, a, c, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export interface OceanRings {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  triangles: number;
}

export function buildOceanRings(material: THREE.Material, levels = DEFAULT_RING_LEVELS): OceanRings {
  const group = new THREE.Group();
  group.name = 'OceanRings';
  const meshes: THREE.Mesh[] = [];
  let triangles = 0;

  levels.forEach((level, i) => {
    const inner = i === 0 ? 0 : levels[i - 1]!.extent;
    const geometry = buildAnnulus(inner, level.extent, level.cells);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'OceanRing' + i;
    // The rings follow the camera; a bounding-sphere cull against their authored origin
    // would pop them out of view the moment the camera moves.
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    group.add(mesh);
    meshes.push(mesh);
    triangles += (geometry.getIndex()?.count ?? 0) / 3;
  });

  return { group, meshes, triangles };
}
