import * as THREE from 'three';
import { leafCellUV, LEAF_VARIANTS } from './leafTexture';

/**
 * A SHRUB, GENERATED — short multi-stem woody base under a mass of independent leaves.
 *
 * WHY PROCEDURAL IS THE RIGHT CALL HERE, and would not be for a tree. The part generated
 * plants are genuinely bad at is branch structure: a readable trunk-and-limb silhouette comes
 * out either too regular or too noisy, and that is where hand-authoring earns its keep. A shrub
 * hides exactly that. It is a dense volume of leaves with barely any wood showing, so what has
 * to convince is the leaf mass and its outline — which is arithmetic, and reproducible from a
 * seed, and costs no binary in a repo that gitignores model files.
 *
 * THE LEAVES ARE INDEPENDENT QUADS, one per leaf, each with its own position, orientation and
 * variant off the atlas. Not a billboard sheet and not a needle spray: the brief was small
 * rounded leaves you can pick out individually, and that means one quad each.
 *
 * TWO MESHES PER SHRUB, NOT TWO HUNDRED. Every leaf quad is merged into ONE BufferGeometry in
 * the shrub's own local space, and the stems into another. A shrub is therefore two draw calls
 * however many leaves it carries, and — because the prototype is cloned by reference the way
 * the GLB trees are — every copy after the first costs no vertex memory at all.
 *
 * IT FOLLOWS THE GRASS TREES' OWN CONTRACT, so the rest of the field needs no special case:
 * the group is re-centred on its base with its origin at ground level, and the leaf geometry
 * carries a real bounding box because `makePineLeafMaterial` reads it to build the wind's
 * height mask — leaves near the base stay put while the outer ones move.
 */

export interface ShrubOptions {
  /** Metres, sole to crown. Mediterranean scrub runs waist to head height. */
  height?: number;
  /** Crown width as a multiple of height. Above 1 the shrub is broader than tall. */
  spread?: number;
  /** How many leaf quads. Two triangles each. */
  leafCount?: number;
  /** Metres, the long axis of one leaf. */
  leafSize?: number;
  /** Woody stems rising from the base. */
  stems?: number;
}

export interface ShrubBuild {
  group: THREE.Group;
  leafMesh: THREE.Mesh;
  stemMesh: THREE.Mesh;
  /** Footprint radius in XZ, for the scatter's minimum-distance test. */
  radius: number;
  height: number;
  leaves: number;
}

const DEFAULTS = {
  height: 1.45,
  spread: 1.15,
  leafCount: 320,
  leafSize: 0.115,
  stems: 5,
};

/** Cheap deterministic RNG, so a shrub is a pure function of its seed. */
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Stems: a few tapered spars leaning out from a common base.
 *
 * Four sides each, not a cylinder. Almost none of this is ever visible — it exists so the leaf
 * mass has something to sit on and so the silhouette has a dark core where the light does not
 * reach — and spending real geometry on wood the leaves cover would be paying for nothing.
 */
function buildStems(o: Required<ShrubOptions>, rng: () => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const norm: number[] = [];

  for (let s = 0; s < o.stems; s++) {
    const yaw = (s / o.stems) * Math.PI * 2 + rng() * 0.7;
    const lean = 0.18 + rng() * 0.30;
    const len = o.height * (0.55 + rng() * 0.35);
    const r0 = 0.022 + rng() * 0.014;

    const dir = new THREE.Vector3(Math.sin(yaw) * lean, 1, Math.cos(yaw) * lean).normalize();
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).normalize();
    const other = new THREE.Vector3().crossVectors(dir, side).normalize();

    const SEGS = 3;
    const base = pos.length / 3;
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const r = r0 * (1 - t * 0.75);
      const centre = dir.clone().multiplyScalar(len * t);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        const off = side.clone().multiplyScalar(Math.cos(a) * r).addScaledVector(other, Math.sin(a) * r);
        pos.push(centre.x + off.x, centre.y + off.y, centre.z + off.z);
        const n = off.clone().normalize();
        norm.push(n.x, n.y, n.z);
      }
    }
    for (let i = 0; i < SEGS; i++) {
      for (let k = 0; k < 4; k++) {
        const a = base + i * 4 + k;
        const b = base + i * 4 + ((k + 1) % 4);
        const c = a + 4;
        const d = b + 4;
        idx.push(a, c, b, b, c, d);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * The leaf mass: `leafCount` quads over a squashed hemisphere, each independently oriented.
 *
 * PLACED IN A SHELL, NOT THROUGH THE VOLUME. Leaves inside a dense shrub are shaded out and
 * invisible, so scattering uniformly through the volume spends most of the quads where nothing
 * can see them. Biasing them outward puts the geometry where the silhouette is, which is the
 * only place it reads.
 *
 * FACING IS SEMI-OUTWARD. Every leaf turned exactly along the surface normal gives one smooth
 * shell that lights as a single dome; every leaf turned at random gives noise. The compromise —
 * mostly outward with a wide random tilt — is what makes some leaves catch the sun while their
 * neighbours do not, which is what a real bush does, and is the same reasoning the island
 * canopy's blades used.
 */
function buildLeaves(o: Required<ShrubOptions>, rng: () => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const norm: number[] = [];
  const idx: number[] = [];

  const rx = o.height * o.spread * 0.5;
  const ry = o.height * 0.5;
  // The crown sits above the woody base rather than starting at the ground.
  const cy = o.height * 0.52;

  for (let i = 0; i < o.leafCount; i++) {
    // A direction in the upper hemisphere, biased away from straight down.
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(1 - rng() * 1.55);
    const dir = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    );
    // Shell bias: cube-rooted radius would fill the volume evenly, so this stays near 1.
    const shell = 0.72 + rng() * 0.28;
    const centre = new THREE.Vector3(dir.x * rx * shell, cy + dir.y * ry * shell, dir.z * rx * shell);

    // Outward, then tilted hard. `mix` toward a random axis rather than a small jitter — a
    // narrow spread still reads as one shell.
    const outward = new THREE.Vector3(dir.x, dir.y * 0.75 + 0.25, dir.z).normalize();
    const jitter = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    const face = outward.multiplyScalar(0.45).addScaledVector(jitter, 0.55);
    if (face.lengthSq() < 1e-6) face.copy(dir);
    face.normalize();

    // An in-plane basis, spun so the blades do not all point the same way up the shrub.
    const ref = Math.abs(face.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(ref, face).normalize();
    const v = new THREE.Vector3().crossVectors(face, u).normalize();
    const spin = rng() * Math.PI * 2;
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const su = u.clone().multiplyScalar(cs).addScaledVector(v, sn);
    const sv = v.clone().multiplyScalar(cs).addScaledVector(u, -sn);

    const size = o.leafSize * (0.72 + rng() * 0.56);
    const halfW = size * 0.42;
    const halfL = size * 0.5;

    const [u0, v0, u1, v1] = leafCellUV(Math.floor(rng() * LEAF_VARIANTS));
    const base = pos.length / 3;
    // Corners run base-left, base-right, tip-right, tip-left, so the atlas cell's V axis
    // matches the blade's stalk-to-tip axis and the leaf is not drawn sideways.
    const corners: Array<[number, number, number, number]> = [
      [-halfW, -halfL, u0, v0],
      [halfW, -halfL, u1, v0],
      [halfW, halfL, u1, v1],
      [-halfW, halfL, u0, v1],
    ];
    for (const [cu, cv, tu, tv] of corners) {
      pos.push(
        centre.x + su.x * cu + sv.x * cv,
        centre.y + su.y * cu + sv.y * cv,
        centre.z + su.z * cu + sv.z * cv,
      );
      norm.push(face.x, face.y, face.z);
      uv.push(tu, tv);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  // REQUIRED, not tidiness: makePineLeafMaterial reads this box to build the wind's height
  // mask, and without it the material would divide by an undefined extent.
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * One shrub prototype. Cloned per placement, exactly like the GLB tree prototypes.
 *
 * Materials are supplied by the caller so the shrub uses the SAME leaf and bark materials as
 * the grass world's trees — the shared wind bag included, which is what keeps every plant in
 * the scene swaying to one gust.
 */
export function buildShrub(
  leafMaterial: THREE.Material,
  stemMaterial: THREE.Material,
  seed: number,
  options: ShrubOptions = {},
): ShrubBuild {
  const o: Required<ShrubOptions> = {
    height: options.height ?? DEFAULTS.height,
    spread: options.spread ?? DEFAULTS.spread,
    leafCount: options.leafCount ?? DEFAULTS.leafCount,
    leafSize: options.leafSize ?? DEFAULTS.leafSize,
    stems: options.stems ?? DEFAULTS.stems,
  };
  const rng = rand(seed);

  const stemGeo = buildStems(o, rng);
  const leafGeo = buildLeaves(o, rng);

  const stemMesh = new THREE.Mesh(stemGeo, stemMaterial);
  stemMesh.castShadow = true;
  stemMesh.receiveShadow = true;

  const leafMesh = new THREE.Mesh(leafGeo, leafMaterial);
  leafMesh.castShadow = true;
  leafMesh.receiveShadow = true;

  const group = new THREE.Group();
  group.name = 'shrub';
  group.add(stemMesh, leafMesh);
  group.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());

  return {
    group,
    leafMesh,
    stemMesh,
    radius: Math.max(size.x, size.z) * 0.5,
    height: size.y,
    leaves: o.leafCount,
  };
}
