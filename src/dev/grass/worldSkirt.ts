import * as THREE from 'three';

/**
 * THE SKIRT — a wall around the world's outer edge, so you cannot see under it.
 *
 * Both surfaces in this scene are open shells. The terrain is a heightfield with
 * no underside and the sea is a single plane, so from any camera low enough to get
 * near their outer edges you look straight past them into the sky: the land reads
 * as a sheet of paper and the sea as a puddle floating in space. A skirt closes
 * that off by hanging a band of geometry from the perimeter.
 *
 * ── Why one rectangle for both ──────────────────────────────────────────────
 *
 * The land and the water overlap — the sea runs inland under the beach — but they
 * span the same x, so their union is still a rectangle. That means the outer
 * silhouette is four axis-aligned walls, which is worth a great deal: the outward
 * normal of each is a constant, so it can be written down rather than derived from
 * winding order. Skirts are exactly the geometry where a flipped winding leaves an
 * invisible wall and a puzzling hole, and there is no winding to get wrong here.
 *
 * ── The top edge ────────────────────────────────────────────────────────────
 *
 * `topAt` returns whichever surface is HIGHER at that point, which is what makes
 * the seam disappear: along the seaward flank the wall meets the water where the
 * water is above the drowned beach, and meets the ground where the beach has
 * climbed back out. It is sampled along each edge rather than assumed flat, so the
 * top follows the terrain's own relief.
 *
 * The band is a constant `depth` BELOW that contour rather than dropping to a flat
 * floor. A flat floor would make the wall vary from a few centimetres to several
 * metres depending on the relief above it; a following band is the same thickness
 * everywhere, which is what "four metres deep" means and reads as a cut-away slab
 * of coastline.
 */

export interface WorldSkirtOptions {
  /** Footprint to wrap, in world XZ. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** How far the wall hangs below the surface contour, metres. */
  depth: number;
  /** Highest surface at a world point — see the header. */
  topAt: (x: number, z: number) => number;
  /** True where the SEA is the surface at that point, so the wall can change colour. */
  isWater: (x: number, z: number) => boolean;
  /** Soil cross-section colour, under the land. */
  earthColor: THREE.ColorRepresentation;
  /** Under the sea. */
  seabedColor: THREE.ColorRepresentation;
  /** Samples per metre along the perimeter. */
  samplesPerMetre?: number;
}

/**
 * Lift the top edge by a whisker so it overlaps the surfaces it hangs from.
 *
 * Meeting them exactly coplanar leaves a hairline of background showing through
 * wherever the two rasterise a pixel differently, and a one-pixel crack along the
 * horizon is more distracting than the wall is.
 */
const OVERLAP = 0.03;

export function buildWorldSkirt(options: WorldSkirtOptions): THREE.Mesh {
  const perMetre = options.samplesPerMetre ?? 1.4;
  const earth = new THREE.Color(options.earthColor);
  const seabed = new THREE.Color(options.seabedColor);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  /** One wall, walked from (x0,z0) to (x1,z1) with a fixed outward normal. */
  const wall = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number): void => {
    const length = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(2, Math.round(length * perMetre));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const top = options.topAt(x, z) + OVERLAP;
      const colour = options.isWater(x, z) ? seabed : earth;

      positions.push(x, top, z, x, top - options.depth, z);
      normals.push(nx, 0, nz, nx, 0, nz);
      colors.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);

      if (i > 0) {
        // Two triangles per step. The base index counts vertices already emitted
        // by every previous wall, so the walls concatenate into one mesh.
        const b = (positions.length / 3) - 4;
        indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
    }
  };

  const { minX, maxX, minZ, maxZ } = options;
  wall(minX, minZ, maxX, minZ, 0, -1);
  wall(maxX, minZ, maxX, maxZ, 1, 0);
  wall(maxX, maxZ, minX, maxZ, 0, 1);
  wall(minX, maxZ, minX, minZ, -1, 0);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    // The normals above are authored, so a face whose winding came out the other
    // way would be culled rather than merely lit oddly — and a missing wall is the
    // exact failure this whole mesh exists to prevent. DoubleSide costs nothing on
    // a few hundred triangles and removes the possibility.
    side: THREE.DoubleSide,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'world-skirt';
  // Neither casts nor receives: it is a backdrop element standing outside the
  // scene, and adding it to a frozen shadow map would only widen the frustum.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
