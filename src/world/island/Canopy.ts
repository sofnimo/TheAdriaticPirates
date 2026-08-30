import * as THREE from 'three';
import { ISLAND_COVER } from '../../art/islandCover';
import { ISLANDS } from '../../art/budgets';
import { clamp01, hash2, rng } from './noise';
import type { CoverField } from './CoverField';

/**
 * TIER C — THE OAK CANOPY: hulls clad in 2D leaves. `05 — Distant Terrain Layering.md` §7.
 *
 * IRREGULAR LOW-POLY HULLS, ONE INSTANCED DRAW. §7 rejects both obvious alternatives by name:
 * camera-facing cards rotate with the camera and destroy any fixed sun-side dab placement, and
 * crossed planes collapse to nearly no projected area from directly above — which is the
 * dominant camera in a flying game. A hull has real volume from every angle, and volume is the
 * whole reason the tier exists.
 *
 * THE LEAVES DO NOT REOPEN THAT ARGUMENT. §7's objection is to quads that TURN TO FACE THE
 * CAMERA; the blades added here are pinned in the world, their planes fixed on the CPU in the
 * crown's frame. Circle a tree and the same leaves stay lit. Move the sun and different ones
 * light up — which is the point of them, and is not something a hull alone can do, because a
 * hull has one smooth normal field and therefore one lit flank.
 *
 * §215 also says to suppress per-leaf normals, on the grounds that they "shift with camera
 * motion and mip level". The first half does not apply once the normals are world-fixed. The
 * second half does: a blade smaller than a pixel sparkles, so leaves shrink away over
 * `leafFadeStart..leafFadeEnd` and the smooth hull carries the crown at range, which is the
 * painted mass the doc is protecting. Near, leaves; far, mass; a size ramp between.
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
  /** Leaf quads per crown, so the budget readout can say where the triangles went. */
  leavesPerHull: number;
}

/**
 * How far a leaf's normal is pushed off the crown surface, 0..1.
 *
 * Kept here rather than in `art/islandCover.ts` because it is not a look control so much as
 * the thing that makes the tier work: at 0 every blade faces straight out and the crown has
 * one smooth outward normal field — the hull's own field, merely drawn in pieces, and the sun
 * would light one flank of it exactly as before. The tilt is what gives the crown blades
 * pointing in every direction at once, which is the whole of "the leaves respond to the sun".
 */
const LEAF_TILT = 0.62;

/** Per-leaf size variation, +/- fraction. A crown of identical blades reads as a pattern. */
const LEAF_SIZE_JITTER = 0.35;

/**
 * ONE CROWN'S GEOMETRY: a dome, clad in leaves.
 *
 * Built ONCE and shared by every instance. That is the whole trick that makes leaves
 * affordable here — the leaves are baked into the crown's own frame rather than scattered per
 * tree on the CPU, so the draw stays a single instanced call over `aCenter`/`aRadius`/`aSeed`
 * and adding foliage costs no instances, no extra draw and no new scatter code. The per-crown
 * yaw in the vertex shader is what stops every tree wearing the identical arrangement.
 *
 * TWO PARTS, AND THE DOME IS NOT DECORATION. A crown of blades alone is a sieve: a few dozen
 * leaves over a 21 m dome cover a few percent of it, so the hillside shows straight through
 * and the crown stops being a mass. The dome remains as the opaque body and the leaves clad it
 * — the dome supplies the volume and the silhouette at range, the leaves supply the broken
 * edge and the per-leaf sun response up close. The dome is pulled in slightly so the blades
 * stand proud of it instead of z-fighting its surface.
 *
 * Vertices carry `aLeafCorner`, `aLeafU`, `aLeafV` and `aLeafInfo`; on the dome's own vertices
 * those are zero and `aLeafInfo.x` is 0, which is how both shaders tell the two apart.
 */
function buildCrownGeometry(
  rings: number,
  segments: number,
  leaves: number,
  domeInset: number,
  seed: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const corners: number[] = [];
  const axisU: number[] = [];
  const axisV: number[] = [];
  const info: number[] = [];
  const indices: number[] = [];

  const pushVertex = (p: THREE.Vector3, c: [number, number], u: THREE.Vector3, v: THREE.Vector3, isLeaf: number, rand: number) => {
    positions.push(p.x, p.y, p.z);
    corners.push(c[0], c[1]);
    axisU.push(u.x, u.y, u.z);
    axisV.push(v.x, v.y, v.z);
    info.push(isLeaf, rand);
  };

  const zero = new THREE.Vector3();

  // ---- the dome ---------------------------------------------------------------------
  // Rows from the apex down to the rim. The angular step is squashed toward the rim so the
  // silhouette — the only part of a crown that reads at range — carries most of the vertices.
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const phi = Math.pow(t, 0.78) * (Math.PI / 2);
    const y = Math.cos(phi);
    const radius = Math.sin(phi);
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const p = new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
      p.multiplyScalar(domeInset);
      pushVertex(p, [0, 0], zero, zero, 0, 0);
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

  // ---- the leaves -------------------------------------------------------------------
  const r = rng(seed);
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < leaves; i++) {
    // A Fibonacci spiral over the upper hemisphere, jittered. Even coverage without the
    // clumping at the pole that naive random spherical angles produce — the apex of a crown
    // is exactly where a bald patch or a knot of leaves would be most obvious from the air.
    const t = (i + 0.5) / leaves;
    const y = Math.sqrt(Math.max(1 - t, 0.0001));
    const ringR = Math.sqrt(Math.max(1 - y * y, 0));
    const theta = i * GOLDEN + (r() - 0.5) * 0.9;
    const anchor = new THREE.Vector3(Math.cos(theta) * ringR, y, Math.sin(theta) * ringR);
    anchor.normalize();

    // THE LEAF'S OWN TILT, and it is what makes the crown respond to the sun rather than
    // merely being lit by it. Facing every blade straight out along the surface normal would
    // give the crown one smooth outward normal field again — the hull's field, drawn in
    // pieces. Tilting each leaf off that by a large random angle means a crown holds blades
    // pointing every way at once, so some catch the sun and their neighbours do not, and which
    // ones catch it changes when the sun moves and at no other time.
    const tilt = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    const normal = anchor.clone().multiplyScalar(1 - LEAF_TILT).add(tilt.multiplyScalar(LEAF_TILT));
    if (normal.lengthSq() < 1e-6) normal.copy(anchor);
    normal.normalize();

    // An in-plane basis, spun at random so the blades do not all point the same way up.
    const ref = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(ref, normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const spin = r() * Math.PI * 2;
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const su = u.clone().multiplyScalar(cs).addScaledVector(v, sn);
    const sv = v.clone().multiplyScalar(cs).addScaledVector(u, -sn);

    const sizeMul = 1 + (r() - 0.5) * 2 * LEAF_SIZE_JITTER;
    const rand = r();
    const base = positions.length / 3;

    pushVertex(anchor, [-1, -1], su, sv, sizeMul, rand);
    pushVertex(anchor, [1, -1], su, sv, sizeMul, rand);
    pushVertex(anchor, [1, 1], su, sv, sizeMul, rand);
    pushVertex(anchor, [-1, 1], su, sv, sizeMul, rand);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aLeafCorner', new THREE.Float32BufferAttribute(corners, 2));
  geometry.setAttribute('aLeafU', new THREE.Float32BufferAttribute(axisU, 3));
  geometry.setAttribute('aLeafV', new THREE.Float32BufferAttribute(axisV, 3));
  // x doubles as the leaf's size multiplier AND as the is-a-leaf flag: a dome vertex gets 0,
  // which both marks it and collapses any blade maths that runs on it anyway.
  geometry.setAttribute('aLeafInfo', new THREE.Float32BufferAttribute(info, 2));
  geometry.setIndex(indices);
  // The instances carry the real extent; the base geometry's own sphere is meaningless once
  // per-instance radii are applied, so the mesh is culled on a sphere built from instance data.
  geometry.computeBoundingSphere();
  return geometry;
}

export interface CanopyOptions {
  readonly material: THREE.Material;
  /**
   * The shadow-pass material, built by the caller because it needs the same uniform block.
   *
   * It cannot be made here any more. Leaf placement now depends on `uLeafSize`, `uLeafAspect`
   * and the rest, and if the depth pass read different values from the visible pass the leaves
   * would cast shadows from somewhere they are not. The uniforms live with the island, so the
   * material that needs them is built there and handed down.
   */
  readonly depthMaterial: THREE.Material;
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
  const leavesPerHull = Math.max(0, Math.round(cfg.leavesPerHull));
  // Seeded off the ISLAND, not off a constant: two islands get differently arranged crowns
  // while every crown within one island shares the geometry, which is what keeps this to a
  // single instanced draw.
  const geometry = buildCrownGeometry(3, 7, leavesPerHull, cfg.domeInset, field.spec.seed ^ 0x1eaf);
  const instanced = new THREE.InstancedBufferGeometry();
  instanced.index = geometry.index;
  instanced.setAttribute('position', geometry.getAttribute('position'));
  instanced.setAttribute('aLeafCorner', geometry.getAttribute('aLeafCorner'));
  instanced.setAttribute('aLeafU', geometry.getAttribute('aLeafU'));
  instanced.setAttribute('aLeafV', geometry.getAttribute('aLeafV'));
  instanced.setAttribute('aLeafInfo', geometry.getAttribute('aLeafInfo'));
  instanced.instanceCount = hulls;
  instanced.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(centers), 3));
  instanced.setAttribute('aRadius', new THREE.InstancedBufferAttribute(new Float32Array(radii), 3));
  instanced.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1));

  // A REAL BOUNDING SPHERE, so this can be culled like anything else.
  //
  // The instances are positioned in the vertex shader, so the base geometry's own sphere is
  // meaningless and the mesh used to opt out of culling entirely. That was survivable while the
  // canopy only drew once; with cascaded shadows it draws once per cascade as well, and an
  // unculled canopy meant every island's crowns were rasterised into all three shadow maps
  // whether or not they were anywhere near the camera. Computing the extent from the instance
  // data costs one pass over an array that was just built.
  const bounds = new THREE.Sphere();
  if (hulls > 0) {
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < hulls; i++) {
      const r = Math.max(radii[i * 3]!, radii[i * 3 + 1]!, radii[i * 3 + 2]!);
      p.set(centers[i * 3]!, centers[i * 3 + 1]!, centers[i * 3 + 2]!);
      box.expandByPoint(p.clone().subScalar(r));
      box.expandByPoint(p.clone().addScalar(r));
    }
    box.getBoundingSphere(bounds);
  }
  instanced.boundingSphere = bounds;

  const mesh = new THREE.Mesh(instanced, options.material);
  // See canopy.depth.vert.glsl: without this the whole canopy casts one shadow from the world
  // origin, because three does not run the canopy vertex shader for the shadow pass.
  mesh.customDepthMaterial = options.depthMaterial;
  // Culled on the sphere computed above rather than opted out. The mesh transform stays
  // identity: every hull is already in world space, so object space and world space coincide
  // and the sphere needs no adjusting.
  mesh.frustumCulled = hulls > 0;
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  const triangles = hulls * (geometry.index ? geometry.index.count / 3 : 0);
  return { mesh, hulls, triangles, leavesPerHull };
}
