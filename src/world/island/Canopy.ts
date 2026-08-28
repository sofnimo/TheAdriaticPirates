import * as THREE from 'three';
import { ISLAND_COVER } from '../../art/islandCover';
import { ISLANDS } from '../../art/budgets';
import { clamp01, hash2, rng } from './noise';
import type { CoverField } from './CoverField';

/**
 * TIER C — THE OAK CANOPY. `05 — Distant Terrain Layering.md` §7.
 *
 * IRREGULAR LOW-POLY HULLS, ONE INSTANCED DRAW. §7 rejects both obvious alternatives by name:
 * camera-facing cards rotate with the camera and destroy any fixed sun-side dab placement, and
 * crossed planes collapse to nearly no projected area from directly above — which is the
 * dominant camera in a flying game. A hull has real volume from every angle, and volume is the
 * whole reason the tier exists.
 *
 * THE HULL IS A DOME, NOT A SPHERE. A crown seen from a seaplane is a lid over a trunk you
 * never see; meshing the bottom hemisphere spends half the triangles on geometry that is
 * inside the hill. The dome is cut at the equator and its rim is left open — nothing can look
 * up at it from below, and the ground layer is directly under it.
 *
 * PLACEMENT IS PER CELL, NOT PER TEXEL. §7 scatters hulls in world cells of a fixed size, so
 * density is a property of the cell rather than of the mask's resolution; changing the cover
 * bake resolution then cannot change how many trees there are. Within a cell the hulls are
 * jittered off a hash of the cell index, which makes the whole scatter a pure function of the
 * seed — the same island regenerates identically, and no scatter state has to be stored.
 *
 * SIZE VARIATION IS NON-UNIFORM PER AXIS. One scalar scale makes every crown the same shape at
 * different sizes, which reads as a repeated asset even when the positions are random. Three
 * independent radii cost the same and break that.
 */

export interface CanopyResult {
  mesh: THREE.Mesh;
  hulls: number;
  triangles: number;
}

/**
 * A unit dome: radius 1 across, height 1, flat-bottomed at y = 0, faceted.
 *
 * `flatShading` is deliberately NOT used to get the facets — the canopy shader discards the
 * geometric normal entirely and builds a synthetic one (§8.1), so the facet normals would be
 * computed and thrown away. What the vertex shader actually needs is `position` to be a clean
 * unit-dome coordinate it can use as the ellipsoid parameter, which is what this builds.
 */
function buildHullGeometry(rings: number, segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  // Rows from the apex down to the rim. The angular step is squashed toward the rim so the
  // silhouette — the only part of a crown that reads at range — carries most of the vertices.
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const phi = Math.pow(t, 0.78) * (Math.PI / 2);
    const y = Math.cos(phi);
    const radius = Math.sin(phi);
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      positions.push(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
    }
  }

  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * segments + s;
      const b = r * segments + ((s + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // The instances carry the real extent; the base geometry's own sphere is meaningless once
  // per-instance radii are applied, so frustum culling is turned off on the mesh instead.
  geometry.computeBoundingSphere();
  return geometry;
}

export interface CanopyOptions {
  readonly material: THREE.Material;
  /** Restricts the scatter to one island's texels. Omitted, the whole tile is scattered. */
  readonly owner?: number;
  readonly maxHulls?: number;
}

/**
 * Scatter hulls over every wooded cell of the cover field.
 *
 * The instance attributes are `aCenter`, `aRadius` and `aSeed` rather than an `instanceMatrix`:
 * the hulls never rotate (a crown has no meaningful orientation and rotating one only changes
 * which facet faces the sun, which the synthetic normal ignores anyway), so a full 4x4 per
 * instance would be 16 floats to express 7.
 */
export function buildCanopy(cover: CoverField, options: CanopyOptions): CanopyResult {
  const cfg = ISLAND_COVER;
  const field = cover.island;
  const cell = Math.max(8, cfg.canopyCellSize);
  const cap = Math.min(options.maxHulls ?? cfg.canopyMaxHulls, ISLANDS.maxFoliageInstances);

  const centers: number[] = [];
  const radii: number[] = [];
  const seeds: number[] = [];

  const cellsX = Math.ceil(cover.mapSize / cell);
  const cellsZ = Math.ceil(cover.mapSize / cell);
  const [ox, oz] = cover.mapOrigin;

  for (let cz = 0; cz < cellsZ && centers.length / 3 < cap; cz++) {
    for (let cx = 0; cx < cellsX && centers.length / 3 < cap; cx++) {
      // The cell centre decides whether the cell is wooded at all, before any per-hull work.
      const centreX = ox + (cx + 0.5) * cell;
      const centreZ = oz + (cz + 0.5) * cell;
      const density = cover.forestAt(centreX, centreZ);
      if (density < cfg.forestThreshold * 0.5) continue;

      const r = rng(hash2(field.spec.seed ^ 0xc0f7, cx * 73856093 + cz * 19349663));
      // §7's 1-4 hulls, scaled by how wooded the cell is. A grove thins out at its edge
      // because fewer hulls are placed, not because each hull shrinks.
      const wanted = cfg.hullsPerCell * clamp01((density - cfg.forestThreshold * 0.5) / 0.5);
      const count = Math.floor(wanted + r());

      for (let k = 0; k < count; k++) {
        const x = ox + (cx + r()) * cell;
        const z = oz + (cz + r()) * cell;
        // Re-checked at the hull's own position: the cell test is a cheap reject, and using it
        // alone would push crowns over cliff edges and onto beaches at every grove boundary.
        if (cover.forestAt(x, z) < cfg.forestThreshold * 0.5) continue;
        if (options.owner !== undefined && field.ownerAt(x, z) !== options.owner) continue;

        const ground = field.heightAt(x, z);
        if (ground <= 0.5) continue;

        const j = cfg.hullJitter;
        const rx = cfg.hullRadius * (1 + (r() - 0.5) * 2 * j);
        const rz = cfg.hullRadius * (1 + (r() - 0.5) * 2 * j);
        const ry = cfg.hullHeight * (1 + (r() - 0.5) * 2 * j);

        // Sunk slightly, so the rim of the dome is under the ground rather than sitting on it
        // as a visible circular edge on a slope.
        centers.push(x, ground - ry * 0.18, z);
        radii.push(rx, ry, rz);
        seeds.push(r());

        if (centers.length / 3 >= cap) break;
      }
    }
  }

  const hulls = centers.length / 3;
  const geometry = buildHullGeometry(3, 7);
  const instanced = new THREE.InstancedBufferGeometry();
  instanced.index = geometry.index;
  instanced.setAttribute('position', geometry.getAttribute('position'));
  instanced.instanceCount = hulls;
  instanced.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(centers), 3));
  instanced.setAttribute('aRadius', new THREE.InstancedBufferAttribute(new Float32Array(radii), 3));
  instanced.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1));

  const mesh = new THREE.Mesh(instanced, options.material);
  // Every hull is placed in world space by its own attribute, so the mesh has no meaningful
  // transform and no meaningful bounding volume of its own.
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  const triangles = hulls * (geometry.index ? geometry.index.count / 3 : 0);
  return { mesh, hulls, triangles };
}
