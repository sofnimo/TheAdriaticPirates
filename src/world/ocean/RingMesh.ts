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
  // WAVES EVERYWHERE, not just in the near field. Displacement used to die before the first
  // ring boundary at 50 m, because the fine ring's extra edge vertices would otherwise lift
  // off the coarse ring's straight chord and tear the seam open. That is now handled in the
  // vertex shader by stitching (see buildAnnulus below and `aStitch` in ocean.vert.glsl), so
  // the boundaries no longer bound the waves and these rings can be sized for what they need
  // to DESCRIBE rather than for where the cracks were.
  //
  // Sized so each ring can actually CARRY the swell, now that seam stitching lets waves cross
  // the boundaries. The dominant swell is 170 m and the shortest component in any sea state is
  // 35 m; a wave needs roughly eight samples across it to read as a curve rather than a
  // zigzag, so the useful measure of a ring is samples per wavelength, not cells per ring:
  //
  //     0-150 m     1.25 m cells   136 samples across the swell, 28 across the chop
  //   150-600 m     5.00 m          34                          7.0
  //   600-1200 m   20.00 m           8.5                        1.8   (the fade lives here)
  //  1200-24000 m   flat             —                          —
  //
  // THE STEPS ARE IN INTEGER RATIOS — 1.25, 5, 20, 1200 — and that is a correctness
  // requirement, not tidiness. Stitching fixes the fine ring's extra vertices, but it can do
  // nothing about a COARSE vertex with no fine counterpart: that one is a T-junction pointing
  // the other way, and it cracks just as readily. Only an integer step ratio guarantees every
  // coarse vertex on a seam is also a fine vertex. An earlier attempt used 5.36 m here, giving
  // a ratio of 2.8 at the 600 m boundary, and would have left that seam open.
  //
  // Which is where the fade belongs: displacement runs at full strength to 600 m, tapers
  // across the 20 m ring, and is gone before 1200 m where the mesh could no longer describe a
  // wave anyway. Past that the surface is flat and the fragment shader's analytic normal
  // carries it, which is correct — 02 §1.1 has the wave silhouette sub-pixel from 200 m up, so
  // what reads at a kilometre is shading rather than shape.
  { extent: 150, cells: 240 },
  { extent: 600, cells: 240 },
  { extent: 1200, cells: 120 },
  // Horizon skirt. 02 §6.1's radii stop at 2500 m, which suits a world full of islands but
  // leaves the empty sea visibly ENDING short of the horizon, so one coarse ring runs out to
  // 24 km. Its cell count is 40 rather than a rounder number because the hole has to land on
  // its own grid: `buildAnnulus` carves the hole by skipping cells whose CENTRE is inside
  // `inner`, so unless (inner + outer) * cells / (2 * outer) is a whole number the hole is cut
  // at the wrong radius. At the old 32 it missed so badly that no cell was skipped at all and
  // this ring was a solid 24 km square lying under every other one — coplanar with them, and
  // winning the depth test wherever the near field displaced below sea level.
  { extent: 24000, cells: 40 },
];

/**
 * Builds one square annulus between `inner` and `outer` half-extents.
 * `inner` of 0 produces a filled square (the innermost patch).
 */
export function buildAnnulus(
  inner: number,
  outer: number,
  cells: number,
  /**
   * Cell size of the ring immediately OUTSIDE this one, or 0 if there is none.
   *
   * Only used to mark the outer-edge vertices that fall BETWEEN two vertices of that ring.
   * Those are the T-junctions, and the vertex shader closes them by displacing such a vertex
   * to the interpolated position of its two coarse neighbours rather than to its own. Without
   * it, displacement has to fade to nothing before every boundary — which is what used to
   * limit real waves to the innermost ring.
   */
  coarseStep = 0,
): THREE.BufferGeometry {
  const step = (outer * 2) / cells;
  const positions: number[] = [];
  const stitch: number[] = [];
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

    // Seam data. A vertex qualifies only if it sits on the OUTER edge, is not a corner
    // (corners land on the coarse grid, because the ring extents are chosen as multiples of
    // it), and does not itself coincide with a coarse vertex.
    let a0 = 0;
    let a1 = 0;
    let b0 = 0;
    let b1 = 0;
    if (coarseStep > 0) {
      const onVertical = ix === 0 || ix === cells;
      const onHorizontal = iz === 0 || iz === cells;
      if (onVertical !== onHorizontal) {
        const along = onVertical ? z : x;
        const lo = Math.floor(along / coarseStep) * coarseStep;
        // A tolerance rather than an equality: both grids come from divisions that do not
        // land exactly in binary, so a vertex mathematically ON the coarse grid can miss it by
        // a few ulps. Marking such a vertex would be harmless — it would be moved onto a chord
        // it already lies on — but the tolerance keeps the attribute sparse and honest.
        if (Math.abs(along - lo) > 1e-4 && Math.abs(along - (lo + coarseStep)) > 1e-4) {
          if (onVertical) {
            a1 = lo - z;
            b1 = lo + coarseStep - z;
          } else {
            a0 = lo - x;
            b0 = lo + coarseStep - x;
          }
        }
      }
    }
    stitch.push(a0, a1, b0, b1);
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
  geometry.setAttribute('aStitch', new THREE.Float32BufferAttribute(stitch, 4));
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
    // The next level out is the one this ring must agree with along its outer edge.
    const next = levels[i + 1];
    const coarseStep = next ? (next.extent * 2) / next.cells : 0;
    const geometry = buildAnnulus(inner, level.extent, level.cells, coarseStep);
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
