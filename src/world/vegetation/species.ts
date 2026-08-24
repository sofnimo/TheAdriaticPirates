import * as THREE from 'three';
import type { SpeciesSpec } from './VegetationSpec';

/**
 * SILHOUETTE GEOMETRY — `03 — Procedural Islands.md` §8.1.
 *
 * "Every tree is a 2-4 triangle-fan cross-billboard or low-poly hero shape, not a modelled
 * trunk+branches... never model bark." So each builder here is a lathe over a hand-written
 * profile: the profile IS the silhouette, and there is nothing else in the mesh.
 *
 * Every shape is built with its base at y=0 and a unit-ish scale, so the instance matrix
 * carries position, yaw and size, and the vertex shader can derive sway weight from
 * `position.y / height` without a second attribute.
 *
 * The profiles are lumped rather than smooth. A perfectly circular lathe reads as a machined
 * cone the moment two of them stand next to each other at the same yaw, and 00 §3 rule 7's
 * "shape-scale variation" is exactly the level this wants: the lumps are metres across, not
 * centimetres.
 */

/** One ring of the lathe: radius as a fraction of `radius`, height as a fraction of `height`. */
type Ring = readonly [r: number, y: number];

/**
 * Deterministic per-vertex lump. Seeded off the species so two species standing together do
 * not share the same dents, and off the ring so the lumps run up the shape rather than
 * around it in a stripe.
 *
 * Indexed by side INDEX rather than by angle, so side 0 and side `sides` are the same vertex
 * and there is no seam to make wrap-safe.
 */
function lump(seed: number, ring: number, side: number): number {
  const a = Math.sin(side * 12.9898 + ring * 78.233 + seed * 4.1414) * 43758.5453;
  const b = Math.sin(side * 39.3468 + ring * 11.135 + seed * 9.271) * 24634.6345;
  return (a - Math.floor(a)) * 0.6 + (b - Math.floor(b)) * 0.4;
}

/**
 * Lathe a profile into an indexed mesh.
 *
 * Rings with r=0 collapse to a single apex vertex, so a closed tip costs `sides` triangles
 * instead of `sides * 2`. That is what keeps these inside §8.4's 8-24 triangle budget.
 */
function lathe(
  profile: readonly Ring[],
  sides: number,
  height: number,
  radius: number,
  seed: number,
  lumpAmount: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  // Index of the first vertex of each ring, and whether that ring is a single apex.
  const ringStart: number[] = [];
  const ringApex: boolean[] = [];

  for (let ri = 0; ri < profile.length; ri++) {
    const [rFrac, yFrac] = profile[ri]!;
    const y = yFrac * height;
    ringStart.push(positions.length / 3);
    if (rFrac <= 1e-5) {
      ringApex.push(true);
      positions.push(0, y, 0);
      continue;
    }
    ringApex.push(false);
    for (let s = 0; s < sides; s++) {
      const theta = (s / sides) * Math.PI * 2;
      const l = 1 + (lump(seed, ri, s) - 0.5) * 2 * lumpAmount;
      const r = rFrac * radius * l;
      positions.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
    }
  }

  // Winding: rings ascend in y and vertices run counter-clockwise seen from +y, so
  // (a[s], b[s+1], a[s+1]) is the front-facing order. Getting this backwards renders the
  // whole canopy inside-out under FrontSide culling, which looks like missing trees rather
  // than like flipped ones.
  for (let ri = 0; ri < profile.length - 1; ri++) {
    const a0 = ringStart[ri]!;
    const b0 = ringStart[ri + 1]!;
    const aApex = ringApex[ri]!;
    const bApex = ringApex[ri + 1]!;
    if (aApex && bApex) continue;
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      if (aApex) {
        indices.push(a0, b0 + s, b0 + s1);
      } else if (bApex) {
        indices.push(a0 + s, b0, a0 + s1);
      } else {
        indices.push(a0 + s, b0 + s1, a0 + s1);
        indices.push(a0 + s, b0 + s, b0 + s1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // Smooth normals. The Ghibli band quantises anyway, so faceted normals would only add
  // triangle-shaped bands to a shape whose whole job is to read as one mass.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// Ring counts are chosen against §8.4's 8-24 triangles per near instance, and the arithmetic
// is worth having written down because it is easy to add "just one more ring" to a profile
// and quietly triple a species that has four thousand instances. A band between two full
// rings costs `sides * 2` triangles; a band into an apex costs `sides`. So a four-ring
// profile at six sides is 12 + 12 + 6 = 30, and a three-ring one is 12 + 6 = 18.

/** §8.1: "tall narrow teardrop". Widest a third of the way up, tapering to a point. */
const TEARDROP: readonly Ring[] = [
  [0.34, 0.0],
  [1.0, 0.32],
  [0.0, 1.0],
];

/**
 * §8.1: "flattened umbrella — a wide flat disc canopy on a short trunk".
 *
 * The trunk is three rings of a thin cylinder and costs six triangles; it is in the mesh
 * because the gap between ground and canopy is what makes an umbrella read as an umbrella
 * from a low camera. From above it is invisible and free.
 */
const UMBRELLA: readonly Ring[] = [
  [0.07, 0.0],
  [0.055, 0.52],
  [0.9, 0.72],  // canopy underside, flaring fast
  [1.0, 0.86],  // widest point
  [0.45, 1.0],  // domed top, well short of a cone
];

/** Rounded broadleaf mass, base slightly pinched so it does not read as a ball on the ground. */
const BLOB: readonly Ring[] = [
  [0.32, 0.0],
  [1.0, 0.4],
  [0.74, 0.78],
  [0.0, 1.0],
];

/** Low scrub mound. */
const DOME: readonly Ring[] = [
  [0.82, 0.0],
  [1.0, 0.38],
  [0.0, 1.0],
];

/**
 * The mid-LOD clump: a wide, low, heavily lumped crown standing for a dozen trees.
 *
 * Flatter than any individual species on purpose. Seen from above — which is the only way it
 * is ever seen, since it is gone by 70 m — a forest patch is a rumpled sheet, and a clump
 * shaped like a big tree would read as a big tree rather than as a group of ordinary ones.
 */
const CROWN: readonly Ring[] = [
  [0.72, 0.0],
  [1.0, 0.42],
  [0.0, 1.0],
];

const PROFILES = {
  teardrop: TEARDROP,
  umbrella: UMBRELLA,
  blob: BLOB,
  dome: DOME,
  crown: CROWN,
} as const;

/** Lump amplitude per archetype — a cypress is tidy, a scrub bush is not. */
const LUMPINESS = {
  teardrop: 0.09,
  umbrella: 0.16,
  blob: 0.26,
  dome: 0.32,
  // The heaviest, and the one that matters most: this lump IS the clump's read. A smooth
  // crown at mid range is the "smooth green shell" the whole middle rung exists to break.
  crown: 0.4,
} as const;

export interface SpeciesGeometry {
  geometry: THREE.BufferGeometry;
  trianglesPerInstance: number;
}

export function buildSpeciesGeometry(spec: SpeciesSpec, seed: number): SpeciesGeometry {
  const geometry = lathe(
    PROFILES[spec.shape],
    spec.sides,
    spec.height,
    spec.radius,
    seed,
    LUMPINESS[spec.shape],
  );
  return { geometry, trianglesPerInstance: (geometry.getIndex()?.count ?? 0) / 3 };
}
