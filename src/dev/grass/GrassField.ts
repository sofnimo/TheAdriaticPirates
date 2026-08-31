import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGrassFieldUniforms, type GrassFieldUniforms, type SurfaceUniforms } from '../../vendor/grassField/uniforms';
import { MAX_ROCKS } from '../../vendor/grassField/shaders/grassBlade';
import { makeGroundMaterial } from '../../vendor/grassField/materials/groundMaterial';
import { makePineLeafMaterial, makePineLeafDepthMaterial } from '../../vendor/grassField/materials/pineLeafMaterial';
import { makeBarkMaterial } from '../../vendor/grassField/materials/barkMaterial';
import { scatterBlades, scatterFlowers } from '../../vendor/grassField/utils/scatter';
import { GRASS_PRESETS } from '../../vendor/grassField/presets';
import { GRASS_DEFAULTS, FLOWER_DEFAULTS, type GrassParams, type FlowerParams } from './grassParams';
import { MAQUIS, makeMaquisSurface } from './maquis';
import { makeLeafAtlas } from './leafTexture';
import { buildShrub } from './shrub';
import { ProceduralTerrain, scatterPoints, seededRandom, groundDirt, type DirtSettings, type FlatRegion } from './proceduralGround';

/**
 * THE GRASS FIELD, GENERATED.
 *
 * The vendored GLB is not treated as a map any more. It is treated as a LIBRARY,
 * and everything in the world is placed from it:
 *
 *   · 13 tree clusters and 9 rock shapes are lifted out as prototypes, each
 *     re-centred on its own base so it can be dropped anywhere.
 *   · The ground is generated — a continuous heightfield of any size (see
 *     `proceduralGround.ts`), not the GLB's 14.8 m quad repeated.
 *   · Trees and rocks are scattered with Poisson-ish dart throwing, so they read
 *     as a wood rather than as a grid or as a clump.
 *   · Grass and flowers were always procedural: area-weighted sampling of the
 *     ground's own triangles, which now means the generated ground.
 *   · Dirt patches were always procedural too — world-XZ noise in the shader.
 *
 * The last two are what tie it together. `groundDirt` is evaluated on the CPU at
 * placement time from the SAME formula the shader paints with, so trees keep off
 * the bare earth and rocks gather on it. The clearings you can see are the
 * clearings the props were placed against; nothing had to be authored twice.
 *
 * ── What the GLB still decides ──────────────────────────────────────────────
 *
 * The look. Every mesh, material, texture and shader is the vendored scene's;
 * this file only decides how many of each there are and where they go. Swap the
 * GLB for one with the same four material names and a different forest comes out.
 */

export interface GrassFieldOptions {
  url?: string;
  groundMesh?: string;
  rockMaterial?: string;
  trunkMaterial?: string;
  leafMaterial?: string;
  barkTextures?: readonly [string, string, string];
  flowerTexturesA?: readonly [string, string, string];
  flowerTexturesB?: readonly [string, string, string];

  /** Land footprint in metres. */
  width: number;
  depth: number;
  centreX?: number;
  centreZ?: number;
  /** Ground patches across and down — a partition, not tiles. See proceduralGround. */
  patchesX?: number;
  patchesZ?: number;
  /** Trees and rocks per 100 m² of land. */
  treeDensity?: number;
  /** Maquis stands per 100 m². Denser than the trees — scrub grows as a thicket. */
  maquisDensity?: number;
  /** Broadleaf shrubs per 100 m2. Generated, not lifted from the GLB — see shrub.ts. */
  shrubDensity?: number;
  rockDensity?: number;
  /** World Z at which the ground is exactly at sea level — the waterline. */
  shoreZ?: number;
  /** Sea level, so the beach can be built to cross it. */
  waterLevel?: number;
  /** How far the ground keeps going past the waterline, under the sea. */
  submergedRun?: number;
  /** A meadow: no trees, no rocks. World XZ centre and radius. */
  clearing?: { x: number; z: number; radius: number };
  /** A levelled shelf in the relief — see FlatRegion. Nothing is scattered on it. */
  flat?: FlatRegion;
  /** Everything is placed from this one seed. */
  seed?: number;

  params?: Partial<GrassParams>;
  flowers?: Partial<FlowerParams>;
}

const DEFAULTS = {
  url: '/assets/grass-scene.glb',
  groundMesh: 'grass-floor',
  rockMaterial: 'RocksStylized_M',
  trunkMaterial: 'Material.011',
  // Blender exported the pine-needle material with a hash for a name.
  leafMaterial: '2237f4d60830642a24d65276e7abe1e6',
  barkTextures: [
    '/assets/textures/bark/bark_color.png',
    '/assets/textures/bark/bark_AO.png',
    '/assets/textures/bark/bark_height.png',
  ] as const,
  flowerTexturesA: [
    '/assets/textures/flower/flowers.png',
    '/assets/textures/flower/flowersRGB.png',
    '/assets/textures/flower/flowersGradient.png',
  ] as const,
  flowerTexturesB: [
    '/assets/textures/flower3/flowers.png',
    '/assets/textures/flower3/flowersRGB.png',
    '/assets/textures/flower3/flowersGradient.png',
  ] as const,
};

/** One placeable thing lifted out of the GLB, re-centred on its own base. */
interface Prototype {
  group: THREE.Group;
  /** Footprint radius in XZ, for the minimum-distance test. */
  radius: number;
  height: number;
}

export interface GrassFieldStats {
  patches: number;
  blades: number;
  flowers: number;
  trees: number;
  /** Adriatic evergreen maquis stands. A separate community, not small trees. */
  maquis: number;
  /** Generated broadleaf shrubs, with independent leaves. */
  shrubs: number;
  rocks: number;
  treePrototypes: number;
  rockPrototypes: number;
  bounds: THREE.Box3;
  clearing: { x: number; z: number; radius: number };
  flat: FlatRegion | undefined;
  /** Size of the GLB's original ground quad. Kept as the scene's unit of area. */
  tileSize: THREE.Vector2;
  groundBox: THREE.Box3;
}

export class GrassField {
  readonly group = new THREE.Group();
  readonly uniforms: GrassFieldUniforms = createGrassFieldUniforms();
  readonly params: GrassParams = { ...GRASS_DEFAULTS };
  readonly flowerParams: FlowerParams = { ...FLOWER_DEFAULTS };
  terrain!: ProceduralTerrain;
  stats: GrassFieldStats = {
    patches: 0,
    blades: 0,
    flowers: 0,
    trees: 0,
    maquis: 0,
    shrubs: 0,
    rocks: 0,
    treePrototypes: 0,
    rockPrototypes: 0,
    bounds: new THREE.Box3(),
    clearing: { x: 0, z: 0, radius: 0 },
    flat: undefined,
    tileSize: new THREE.Vector2(),
    groundBox: new THREE.Box3(),
  };

  private readonly options: Required<Omit<GrassFieldOptions, 'params' | 'flowers' | 'flat'>> & {
    flat: FlatRegion | undefined;
  };
  private readonly template: THREE.Group;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly treeProtos: Prototype[] = [];
  /** Maquis stands, derived from the tree prototypes. See maquis.ts. */
  private readonly maquisProtos: Prototype[] = [];
  /** Generated shrubs. See shrub.ts and leafTexture.ts. */
  private readonly shrubProtos: Prototype[] = [];
  /** Leaf materials this field created, so maquis clones know which meshes to re-skin. */
  private readonly leafMaterials = new Set<THREE.Material>();
  private maquisLeaf: THREE.Material | null = null;
  private readonly rockProtos: Prototype[] = [];
  /** Every placed rock as a world sphere, for the blade shader's trampling. */
  private readonly placedRocks: THREE.Vector4[] = [];
  private groundColor: THREE.Color | undefined;
  private time = 0;
  private sun: THREE.DirectionalLight | null = null;
  private readonly sunPos = new THREE.Vector3();
  private readonly sunTarget = new THREE.Vector3();

  private constructor(template: THREE.Group, options: GrassFieldOptions) {
    this.template = template;
    this.options = {
      url: options.url ?? DEFAULTS.url,
      groundMesh: options.groundMesh ?? DEFAULTS.groundMesh,
      rockMaterial: options.rockMaterial ?? DEFAULTS.rockMaterial,
      trunkMaterial: options.trunkMaterial ?? DEFAULTS.trunkMaterial,
      leafMaterial: options.leafMaterial ?? DEFAULTS.leafMaterial,
      barkTextures: options.barkTextures ?? DEFAULTS.barkTextures,
      flowerTexturesA: options.flowerTexturesA ?? DEFAULTS.flowerTexturesA,
      flowerTexturesB: options.flowerTexturesB ?? DEFAULTS.flowerTexturesB,
      width: options.width,
      depth: options.depth,
      centreX: options.centreX ?? 0,
      centreZ: options.centreZ ?? 0,
      patchesX: options.patchesX ?? 4,
      patchesZ: options.patchesZ ?? 2,
      treeDensity: options.treeDensity ?? 3.0,
      maquisDensity: options.maquisDensity ?? 5.5,
      shrubDensity: options.shrubDensity ?? 4.0,
      rockDensity: options.rockDensity ?? 4.5,
      shoreZ: options.shoreZ ?? (options.centreZ ?? 0) + options.depth / 2,
      waterLevel: options.waterLevel ?? -0.6,
      submergedRun: options.submergedRun ?? 9,
      clearing: options.clearing ?? { x: -9, z: -1, radius: 9.5 },
      flat: options.flat,
      seed: options.seed ?? 1337,
    };
    Object.assign(this.params, options.params ?? {});
    Object.assign(this.flowerParams, options.flowers ?? {});
  }

  static async load(scene: THREE.Scene, options: GrassFieldOptions): Promise<GrassField> {
    const gltf = await new GLTFLoader().loadAsync(options.url ?? DEFAULTS.url);
    const field = new GrassField(gltf.scene as THREE.Group, options);
    await field.loadTextures();
    field.extractPrototypes();
    field.build();
    scene.add(field.group);
    return field;
  }

  private async loadTextures(): Promise<void> {
    const loader = new THREE.TextureLoader();
    const o = this.options;
    const [barkColor, barkAO, barkHeight, maskA, rgbA, gradA, maskB, rgbB, gradB] = await Promise.all(
      [...o.barkTextures, ...o.flowerTexturesA, ...o.flowerTexturesB].map((url) => loader.loadAsync(url)),
    );

    // Bark tiles through uBarkScale, so the maps must wrap. Only the colour map is
    // sRGB — AO and height are data, and decoding them as colour bends the relief.
    for (const t of [barkColor!, barkAO!, barkHeight!]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
    }
    barkColor!.colorSpace = THREE.SRGBColorSpace;
    barkAO!.colorSpace = THREE.NoColorSpace;
    barkHeight!.colorSpace = THREE.NoColorSpace;

    const u = this.uniforms;
    u.bark.uBarkColorMap.value = barkColor!;
    u.bark.uBarkAOMap.value = barkAO!;
    u.bark.uBarkHeightMap.value = barkHeight!;
    u.flowerTexA.uFlowerMask.value = maskA!;
    u.flowerTexA.uFlowerRGB.value = rgbA!;
    u.flowerTexA.uFlowerGradient.value = gradA!;
    u.flowerTexB.uFlowerMask.value = maskB!;
    u.flowerTexB.uFlowerRGB.value = rgbB!;
    u.flowerTexB.uFlowerGradient.value = gradB!;

    for (const t of [barkColor!, barkAO!, barkHeight!, maskA!, rgbA!, gradA!, maskB!, rgbB!, gradB!]) {
      this.disposables.push(t);
    }
  }

  /**
   * Turn the GLB into a library of placeable prototypes.
   *
   * Rocks are one mesh each, so every rock mesh is a prototype outright. Trees are
   * not: the export groups several of them under one `CylinderNNN` node, with the
   * trunks and canopies as separate sibling meshes and no reliable pairing in the
   * names. So they are clustered by POSITION instead — meshes whose XZ centres sit
   * within a couple of metres of each other are one tree. That is the thing the
   * export actually encodes, and it does not care what anything was named.
   */
  private extractPrototypes(): void {
    this.template.updateMatrixWorld(true);
    const o = this.options;

    const groundMesh = this.findGround();
    if (groundMesh) {
      const src = (Array.isArray(groundMesh.material) ? groundMesh.material[0] : groundMesh.material) as
        | THREE.MeshStandardMaterial
        | undefined;
      this.groundColor = src?.color?.clone();
      const box = new THREE.Box3().setFromObject(groundMesh);
      const size = box.getSize(new THREE.Vector3());
      this.stats.tileSize.set(size.x, size.z);
      this.stats.groundBox.copy(box);
    }

    const woody: THREE.Mesh[] = [];
    this.template.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh === groundMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      if (materials.some((m) => m.name === o.rockMaterial)) {
        const proto = this.makePrototype([mesh]);
        if (proto) this.rockProtos.push(proto);
        return;
      }
      if (materials.some((m) => m.name === o.trunkMaterial || m.name === o.leafMaterial)) {
        woody.push(mesh);
      }
    });

    // Cluster the woody meshes by XZ proximity. 1.8 m is comfortably wider than a
    // trunk-and-canopy pair and comfortably narrower than the gap between two
    // neighbouring trees in the export.
    const CLUSTER_RADIUS = 1.8;
    const clusters: Array<{ centre: THREE.Vector2; members: THREE.Mesh[] }> = [];
    const centre = new THREE.Vector3();
    for (const mesh of woody) {
      new THREE.Box3().setFromObject(mesh).getCenter(centre);
      let found = clusters.find((c) => c.centre.distanceTo(new THREE.Vector2(centre.x, centre.z)) < CLUSTER_RADIUS);
      if (!found) {
        found = { centre: new THREE.Vector2(centre.x, centre.z), members: [] };
        clusters.push(found);
      }
      found.members.push(mesh);
    }
    for (const cluster of clusters) {
      const proto = this.makePrototype(cluster.members);
      // A cluster with no canopy is a bare stump the export left behind; a tree is
      // worth placing, a stump on its own is not.
      if (proto && proto.height > 2) this.treeProtos.push(proto);
    }

    this.buildMaquisProtos();
    this.buildShrubProtos();

    this.stats.treePrototypes = this.treeProtos.length;
    this.stats.rockPrototypes = this.rockProtos.length;

    if (this.treeProtos.length === 0) console.warn('[GrassField] no tree prototypes found — check the material names');
    if (this.rockProtos.length === 0) console.warn('[GrassField] no rock prototypes found — check the material names');
  }

  private findGround(): THREE.Mesh | null {
    let ground: THREE.Mesh | null = null;
    this.template.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.name === this.options.groundMesh) ground = child as THREE.Mesh;
    });
    return ground;
  }

  /**
   * Bake a set of source meshes into a standalone prototype.
   *
   * Each clone carries the source's WORLD matrix, so the prototype looks exactly
   * as it did in the GLB, and the whole thing is then shifted so its base sits at
   * y = 0 and its footprint is centred on the origin. That is what makes it
   * droppable: the caller sets a position and a rotation and nothing else.
   */
  private makePrototype(sources: readonly THREE.Mesh[]): Prototype | null {
    const group = new THREE.Group();

    for (const source of sources) {
      const clone = new THREE.Mesh(source.geometry, this.materialFor(source));
      clone.castShadow = true;
      clone.receiveShadow = true;
      // Geometry is shared with the template, so the world transform has to ride
      // on the clone rather than being baked into the vertices.
      source.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
      if (source.customDepthMaterial) clone.customDepthMaterial = source.customDepthMaterial;
      const materials = Array.isArray(source.material) ? source.material : [source.material];
      if (materials.some((m) => m.name === this.options.leafMaterial)) {
        clone.customDepthMaterial = makePineLeafDepthMaterial(materials[0] as THREE.MeshStandardMaterial);
      }
      group.add(clone);
    }

    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    for (const child of group.children) {
      child.position.x -= mid.x;
      child.position.z -= mid.z;
      child.position.y -= box.min.y;
    }
    group.updateMatrixWorld(true);

    return { group, radius: Math.max(size.x, size.z) * 0.5, height: size.y };
  }

  /**
   * MAQUIS PROTOTYPES, cloned off the trees and re-skinned.
   *
   * One leaf material for the whole species, not one per prototype: the shrubs differ from the
   * pines only in colour, so they can share a single program across every stand. It is built
   * from the FIRST tree prototype's leaf material, which carries the GLB's alpha texture — the
   * blade cut-out is the same leaf shape, and only the RGB the shader paints over it changes.
   *
   * The clone is deep in materials but shallow in geometry: `THREE.Object3D.clone` shares the
   * BufferGeometry, so a second species costs no vertex memory at all.
   */
  /**
   * SHRUB PROTOTYPES — generated, not lifted from the GLB.
   *
   * The one thing they need from the GLB is a material to borrow the SHAPE of: `makePineLeafMaterial`
   * cuts its silhouette from the map's alpha, so a broadleaf shrub needs a different alpha and
   * nothing else. The source material is therefore a bare MeshStandardMaterial carrying the
   * generated leaf atlas, handed to the same factory the pines use — which means the shrubs
   * inherit the colour gradient, the shared wind gust, and the depth material that keeps their
   * shadows the shape of their leaves rather than the shape of their quads.
   *
   * Three prototypes off three seeds, so a thicket is not one bush repeated.
   */
  private buildShrubProtos(): void {
    const atlas = makeLeafAtlas();
    this.disposables.push(atlas);

    // The stand-in the material factory reads `map` and `alphaTest` off. Never rendered.
    const source = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5 });
    this.disposables.push(source);

    const bark = makeBarkMaterial(this.uniforms.bark);
    this.disposables.push(bark);

    for (let i = 0; i < 3; i++) {
      // Built once with a placeholder so the leaf geometry exists, then given the real material:
      // the factory needs the MESH to read its bounding box for the wind's height mask, and the
      // mesh needs a geometry to have one.
      const build = buildShrub(source, bark, this.options.seed * 977 + i * 31, {
        height: 1.15 + i * 0.28,
        spread: 1.05 + i * 0.12,
      });
      const leaf = makePineLeafMaterial(source, build.leafMesh, this.uniforms.surface);
      this.disposables.push(leaf);
      build.leafMesh.material = leaf;
      build.leafMesh.customDepthMaterial = makePineLeafDepthMaterial(source);
      this.shrubProtos.push({ group: build.group, radius: build.radius, height: build.height });
    }
  }

  private buildMaquisProtos(): void {
    if (this.treeProtos.length === 0) return;

    for (const proto of this.treeProtos) {
      const group = proto.group.clone();
      let hasLeaves = false;
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const current = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!current || !this.leafMaterials.has(current)) return;
        if (!this.maquisLeaf) {
          const leaf = makePineLeafMaterial(
            current as THREE.MeshStandardMaterial,
            mesh,
            makeMaquisSurface(this.uniforms.surface),
          );
          this.disposables.push(leaf);
          this.maquisLeaf = leaf;
        }
        mesh.material = this.maquisLeaf;
        hasLeaves = true;
      });
      // A cluster whose foliage did not resolve would render as a bare trunk squashed into the
      // ground, which reads as damage rather than as a shrub.
      if (hasLeaves) this.maquisProtos.push({ group, radius: proto.radius, height: proto.height });
    }
  }

  /** The vendored material swap, by name. Built once per prototype and shared by
   *  every copy of it, so N trees of one shape still compile one program. */
  private materialFor(source: THREE.Mesh): THREE.Material {
    const materials = Array.isArray(source.material) ? source.material : [source.material];
    const first = materials[0] as THREE.MeshStandardMaterial;
    const o = this.options;

    if (materials.some((m) => m.name === o.leafMaterial)) {
      const leaf = makePineLeafMaterial(first, source, this.uniforms.surface);
      this.disposables.push(leaf);
      // Recorded so `buildMaquisProtos` can tell foliage from bark on a cloned prototype. The
      // clone carries material REFERENCES, and after the vendored swap the leaf material no
      // longer answers to the GLB's material name, so identity is the only reliable test.
      this.leafMaterials.add(leaf);
      return leaf;
    }
    if (materials.some((m) => m.name === o.trunkMaterial)) {
      const bark = makeBarkMaterial(this.uniforms.bark);
      this.disposables.push(bark);
      return bark;
    }
    // Rocks and anything else: keep the authored material, flattened out of its
    // photographic PBR look so it sits with the stylized rest.
    const clone = first.clone();
    clone.roughness = 1;
    clone.metalness = 0;
    clone.envMapIntensity = 0.4;
    clone.flatShading = true;
    clone.needsUpdate = true;
    this.disposables.push(clone);
    return clone;
  }

  private get dirtSettings(): DirtSettings {
    const p = this.params;
    const u = this.uniforms.surface;
    return {
      scale: p.grDirtScale,
      coverage: p.grDirtCoverage,
      softness: p.grDirtSoftness,
      warp: p.grDirtWarp,
      // Mirrors the uniforms the shader is about to paint with, so a tree is never
      // placed against a mask that disagrees with the ground under it.
      shoreStart: u.uShoreDirtStart.value,
      shoreEnd: u.uShoreDirtEnd.value,
      shore: u.uShoreDirt.value,
    };
  }

  private build(): void {
    const o = this.options;

    // The ground runs PAST the waterline and keeps descending, so the beach goes
    // into the sea rather than ending at it. Those extra metres are terrain, not
    // land: the "8 tiles" of grass is still `width x depth`, and everything from
    // the waterline out is submerged sand nobody walks on.
    const totalDepth = o.depth + o.submergedRun;
    this.terrain = new ProceduralTerrain({
      width: o.width,
      depth: totalDepth,
      centreX: o.centreX,
      // Grow the field on the +z side only, so the land keeps its position and the
      // beach is added seaward of it.
      centreZ: o.centreZ + o.submergedRun / 2,
      patchesX: o.patchesX,
      // One extra row for the beach, so its blade batch and its ground patch are
      // separate from the grass behind it.
      patchesZ: o.patchesZ + 1,
      shoreZ: o.shoreZ,
      waterLevel: o.waterLevel,
      submergedRun: o.submergedRun,
      seed: o.seed,
      flat: o.flat,
    });

    // The sand band, published to every shader that reads the dirt mask. Starting
    // it well inland of the waterline is what makes the grass THIN into sand over
    // several metres instead of stopping at a line.
    const su = this.uniforms.surface;
    su.uShoreDirtStart.value = o.shoreZ - 7;
    su.uShoreDirtEnd.value = o.shoreZ - 0.5;
    su.uShoreDirt.value = 1;

    const land = new THREE.Box3(
      new THREE.Vector3(o.centreX - o.width / 2, 0, o.centreZ - o.depth / 2),
      new THREE.Vector3(o.centreX + o.width / 2, 0, o.centreZ + o.depth / 2),
    );
    const area = o.width * o.depth;
    const rng = seededRandom(o.seed);
    const dirt = this.dirtSettings;

    // The meadow. A hard core nothing is placed in, plus a fringe that thins out,
    // so the edge reads as a clearing rather than as a stamped circle.
    const clearing = o.clearing;
    const inClearing = (x: number, z: number): boolean =>
      (x - clearing.x) ** 2 + (z - clearing.z) ** 2 < clearing.radius ** 2;
    const clearingFringe = (x: number, z: number): number => {
      const d = Math.hypot(x - clearing.x, z - clearing.z);
      const outer = clearing.radius * 1.45;
      if (d >= outer) return 1;
      return Math.min(1, Math.max(0, (d - clearing.radius) / (outer - clearing.radius)));
    };

    // Nothing is placed on the sand: the beach is where the ground has to read
    // cleanly into the sea, and a pine growing out of the surf hides that. The
    // margin matches the shore band above, so props stop where the grass does.
    const nearShore = (z: number): boolean => z > o.shoreZ - 6.5;

    // Nothing is scattered on the levelled shelf or in the margin that ramps into
    // it. The shelf exists to be built on, and the ramp is the one part of the
    // ground steep enough that a trunk would visibly lean.
    const onShelf = (x: number, z: number): boolean => this.onShelf(x, z);

    // ── Rocks ────────────────────────────────────────────────────────────────
    // Biased TOWARD bare earth: the dirt mask is where the grass thins out, and
    // stone showing through thin grass is the reason it is thin.
    const rockPoints = scatterPoints(
      land,
      {
        count: Math.round((area / 100) * o.rockDensity),
        minDistance: 1.6,
        reject: (x, z) => nearShore(z) || inClearing(x, z) || onShelf(x, z) || this.terrain.slopeAt(x, z) > 0.6,
        weight: (x, z) => (0.25 + 0.75 * groundDirt(x, z, dirt)) * clearingFringe(x, z),
      },
      rng,
    );

    for (const point of rockPoints) {
      const proto = this.rockProtos[Math.floor(rng() * this.rockProtos.length)];
      if (!proto) break;
      const instance = proto.group.clone();
      const scale = 0.6 + rng() * 0.9;
      instance.position.set(point.x, this.terrain.heightAt(point.x, point.y) - 0.12 * scale, point.y);
      instance.rotation.set((rng() - 0.5) * 0.25, rng() * Math.PI * 2, (rng() - 0.5) * 0.25);
      instance.scale.setScalar(scale);
      this.group.add(instance);
      this.placedRocks.push(new THREE.Vector4(point.x, instance.position.y, point.y, proto.radius * scale));
    }

    // ── Trees ────────────────────────────────────────────────────────────────
    // Biased AWAY from bare earth and off the steep ground, and kept clear of the
    // rocks — a pine growing out of a boulder is the tell that this was scattered
    // rather than grown.
    const treePoints = scatterPoints(
      land,
      {
        count: Math.round((area / 100) * o.treeDensity),
        minDistance: 3.2,
        reject: (x, z) => {
          if (nearShore(z) || inClearing(x, z) || onShelf(x, z) || this.terrain.slopeAt(x, z) > 0.45) return true;
          for (const rock of this.placedRocks) {
            if ((rock.x - x) ** 2 + (rock.z - z) ** 2 < (rock.w + 0.8) ** 2) return true;
          }
          return false;
        },
        weight: (x, z) => (1 - 0.85 * groundDirt(x, z, dirt)) * clearingFringe(x, z),
      },
      rng,
    );

    let trees = 0;
    for (const point of treePoints) {
      const proto = this.treeProtos[Math.floor(rng() * this.treeProtos.length)];
      if (!proto) break;
      const instance = proto.group.clone();
      const scale = 0.75 + rng() * 0.55;
      // Sunk very slightly, so the trunk meets the ground instead of hovering on
      // the one triangle the base happens to land on.
      instance.position.set(point.x, this.terrain.heightAt(point.x, point.y) - 0.15, point.y);
      instance.rotation.y = rng() * Math.PI * 2;
      instance.scale.setScalar(scale);
      this.group.add(instance);
      trees++;
    }

    // ── Maquis ───────────────────────────────────────────────────────────────
    // THE OPPOSITE GROUND TO THE TREES, deliberately. Maquis is the community that holds the
    // dry, thin, exposed, rocky slopes a forest has given up on, so this inverts the pines'
    // preferences instead of sharing them: it takes steeper ground (0.72 against their 0.45),
    // it is drawn TOWARD the bare-earth mask they are pushed away from, and it comes nearer the
    // shore. Scattering it on the same ground with the same weights would have produced small
    // trees among big ones; competing for different ground is what makes it a second plant.
    //
    // It still keeps out of the rocks and the clearing — a shrub growing from a boulder is the
    // same tell a pine growing from one is.
    const maquisPoints = scatterPoints(
      land,
      {
        count: Math.round((area / 100) * o.maquisDensity),
        minDistance: MAQUIS.minDistance,
        reject: (x, z) => {
          if (inClearing(x, z) || onShelf(x, z) || this.terrain.slopeAt(x, z) > MAQUIS.maxSlope) return true;
          // Closer to the water than a pine will go, but not onto the sand itself.
          if (z > o.shoreZ - 3.0) return true;
          for (const rock of this.placedRocks) {
            if ((rock.x - x) ** 2 + (rock.z - z) ** 2 < (rock.w + 0.5) ** 2) return true;
          }
          return false;
        },
        weight: (x, z) => (0.3 + 0.7 * groundDirt(x, z, dirt)) * clearingFringe(x, z),
      },
      rng,
    );

    let maquis = 0;
    for (const point of maquisPoints) {
      const proto = this.maquisProtos[Math.floor(rng() * this.maquisProtos.length)];
      if (!proto) break;
      const instance = proto.group.clone();
      // ANISOTROPIC on purpose: squashed down and spread out. A uniformly smaller tree is a
      // sapling, which is a different thing entirely — the low broad silhouette is most of what
      // says "scrub" at any distance where the leaves themselves are not resolvable.
      const h = MAQUIS.heightScale[0] + rng() * (MAQUIS.heightScale[1] - MAQUIS.heightScale[0]);
      const w = MAQUIS.widthScale[0] + rng() * (MAQUIS.widthScale[1] - MAQUIS.widthScale[0]);
      instance.position.set(
        point.x,
        this.terrain.heightAt(point.x, point.y) - MAQUIS.sink * h,
        point.y,
      );
      instance.rotation.y = rng() * Math.PI * 2;
      instance.scale.set(w, h, w);
      this.group.add(instance);
      maquis++;
    }

    // ── Shrubs ───────────────────────────────────────────────────────────────
    // Placed like the trees rather than like the maquis: shrubs are a broadleaf understorey,
    // so they want the same sheltered, greener ground the pines take, and they fill in beneath
    // and between them. The only real difference is that they are allowed closer to each other
    // and are not pushed off the bare earth as hard, because a shrub is what colonises a gap.
    const shrubPoints = scatterPoints(
      land,
      {
        count: Math.round((area / 100) * o.shrubDensity),
        minDistance: 2.1,
        reject: (x, z) => {
          if (nearShore(z) || inClearing(x, z) || onShelf(x, z) || this.terrain.slopeAt(x, z) > 0.55) return true;
          for (const rock of this.placedRocks) {
            if ((rock.x - x) ** 2 + (rock.z - z) ** 2 < (rock.w + 0.6) ** 2) return true;
          }
          return false;
        },
        weight: (x, z) => (1 - 0.45 * groundDirt(x, z, dirt)) * clearingFringe(x, z),
      },
      rng,
    );

    let shrubs = 0;
    for (const point of shrubPoints) {
      const proto = this.shrubProtos[Math.floor(rng() * this.shrubProtos.length)];
      if (!proto) break;
      const instance = proto.group.clone();
      const scale = 0.8 + rng() * 0.5;
      instance.position.set(point.x, this.terrain.heightAt(point.x, point.y) - 0.08, point.y);
      instance.rotation.y = rng() * Math.PI * 2;
      instance.scale.setScalar(scale);
      this.group.add(instance);
      shrubs++;
    }

    // ── Ground patches, blades, flowers ──────────────────────────────────────
    let blades = 0;
    let flowers = 0;
    const p = this.params;
    const f = this.flowerParams;

    for (const patch of this.terrain.patches) {
      // Rocks that could reach this patch, nearest first, capped at the shader's
      // fixed array length.
      const reach = patch.bounds.clone().expandByScalar(3);
      const near = this.placedRocks
        .filter((r) => r.x >= reach.min.x && r.x <= reach.max.x && r.z >= reach.min.z && r.z <= reach.max.z)
        .sort(
          (a, b) =>
            (a.x - patch.centre.x) ** 2 + (a.z - patch.centre.z) ** 2 -
            ((b.x - patch.centre.x) ** 2 + (b.z - patch.centre.z) ** 2),
        )
        .slice(0, MAX_ROCKS);

      const patchUniforms: SurfaceUniforms = {
        ...this.uniforms.surface,
        uRocks: { value: Array.from({ length: MAX_ROCKS }, () => new THREE.Vector4()) },
        uRockCount: { value: near.length },
      };
      near.forEach((rock, i) => patchUniforms.uRocks.value[i]!.copy(rock));

      const groundMat = makeGroundMaterial(patchUniforms, this.groundColor);
      this.disposables.push(groundMat);
      const groundMesh = new THREE.Mesh(patch.geometry, groundMat);
      groundMesh.receiveShadow = true;
      groundMesh.castShadow = false;
      this.group.add(groundMesh);
      groundMesh.updateMatrixWorld(true);

      // Nothing grows ON the levelled shelf, and only a quarter as much grows on the
      // strip of beach in FRONT of it.
      //
      // A patch-level rule rather than a per-blade reject, because the shelf is
      // aligned to a patch boundary: a patch is either entirely town or entirely
      // not. It is also the difference between a scene that runs and one that does
      // not — the island grew from four columns of patches to eighteen to carry the
      // town, and at 16k blades a patch that is 864,000 blades, most of them under
      // a building. Skipping the town's own patches takes it to 416,000; thinning
      // the verge in front of it takes it to 248,000, against 192,000 before any of
      // this existed. The verge is thinned rather than cleared because a town on a
      // coast has a grassy quay, and bare sand up to the doorsteps reads as unbuilt.
      const townPatch = this.onShelf(patch.centre.x, patch.centre.z);
      if (townPatch) continue;
      const vergePatch = this.onShelfX(patch.centre.x);

      const bladeMesh = scatterBlades(groundMesh, {
        uniforms: patchUniforms,
        density: p.grDensity,
        maxCount: vergePatch ? Math.round(p.grMaxCount * 0.25) : p.grMaxCount,
        minWidth: p.grMinWidth,
        maxWidth: p.grMaxWidth,
        minLength: p.grMinLength,
        maxLength: p.grMaxLength,
        tiltMax: p.grTiltMax,
        segments: p.grSegments,
      });
      this.group.add(bladeMesh);
      blades += bladeMesh.count;
      this.disposables.push(bladeMesh.material as THREE.Material, bladeMesh.geometry);

      if (f.flEnabled) {
        for (const im of scatterFlowers(groundMesh, {
          uniforms: this.uniforms.flower,
          texA: this.uniforms.flowerTexA,
          texB: this.uniforms.flowerTexB,
          dirt: patchUniforms,
          density: f.flDensity,
          maxCount: f.flMaxCount,
          size: f.flSize,
          mixA: f.flMixA,
        })) {
          this.group.add(im);
          flowers += im.count / 2;
          this.disposables.push(im.material as THREE.Material, im.geometry);
        }
      }
    }

    this.stats.patches = this.terrain.patches.length;
    this.stats.blades = blades;
    this.stats.flowers = flowers;
    this.stats.trees = trees;
    this.stats.maquis = maquis;
    this.stats.shrubs = shrubs;
    this.stats.rocks = this.placedRocks.length;
    this.stats.clearing = clearing;
    this.stats.flat = o.flat;
    this.stats.bounds.setFromObject(this.group);
  }

  /**
   * Is this world point on the levelled shelf, or on the margin ramping into it?
   *
   * One test, used by the prop scatters AND by the blade patch skip, so "the town
   * is bare" cannot come to mean two different rectangles.
   */
  onShelf(x: number, z: number): boolean {
    const f = this.options.flat;
    if (!f) return false;
    const m = f.blend;
    return this.onShelfX(x) && z > f.minZ - m && z < f.maxZ + m;
  }

  /**
   * Is this point in the shelf's X range, whatever its Z?
   *
   * The shelf stops short of the waterline on purpose (see `TOWN_SHELF`), so the
   * beach row in front of the town is NOT on the shelf and keeps its natural
   * relief — but it is still the town's foreshore rather than open meadow, and it
   * is thinned accordingly.
   */
  onShelfX(x: number): boolean {
    const f = this.options.flat;
    if (!f) return false;
    return x > f.minX - f.blend && x < f.maxX + f.blend;
  }

  /** Land height at a world point — for putting anything else down on the ground. */
  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  applyPreset(key: string): void {
    const preset = GRASS_PRESETS[key];
    if (!preset) {
      console.warn(`[GrassField] unknown preset "${key}"`);
      return;
    }
    // On top of the DEFAULTS, never on top of the previous preset: a preset names
    // only what it changes, so without the reset a switch A -> B -> A would not
    // land back on A.
    Object.assign(this.params, GRASS_DEFAULTS, preset.values);
  }

  /** Per-frame uniform sync. No recompiles, no respawns. */
  update(dt: number, scene: THREE.Scene): void {
    const s = this.uniforms.surface;
    const fl = this.uniforms.flower;
    const b = this.uniforms.bark;
    const p = this.params;
    const f = this.flowerParams;

    this.time = (this.time + dt) % 3600;
    s.uTime.value = this.time;

    // The injected GLSL cannot reach Lambert's own light uniforms, so the sun is
    // mirrored into uSunDir/uSunColor for the translucency lobe. Resolved once.
    if (!this.sun) {
      scene.traverse((o) => {
        if (!this.sun && (o as THREE.DirectionalLight).isDirectionalLight) this.sun = o as THREE.DirectionalLight;
      });
    }
    if (this.sun) {
      this.sun.getWorldPosition(this.sunPos);
      this.sun.target.getWorldPosition(this.sunTarget);
      s.uSunDir.value.subVectors(this.sunPos, this.sunTarget).normalize();
      s.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    }

    const rad = p.grWindDir * (Math.PI / 180);
    s.uWindDir.value.set(Math.cos(rad), Math.sin(rad));
    s.uWindStrength.value = p.grWindStrength;
    s.uWindSpeed.value = p.grWindSpeed;
    s.uWindFreq.value = p.grWindFreq;
    s.uWindTurb.value = p.grWindTurb;
    s.uWindLean.value = p.grWindLean;

    s.uGrassBottom.value.set(p.grColorBottom);
    s.uGrassTop.value.set(p.grColorTop);
    s.uGradStart.value = p.grGradStart;
    s.uGradEnd.value = p.grGradEnd;
    s.uGradPower.value = p.grGradPower;
    s.uBrightness.value = p.grBrightness;

    if (p.grPatchLinkColors) {
      s.uPatchLush.value.set(p.grColorBottom);
      s.uPatchDry.value.set(p.grColorTop);
    } else {
      s.uPatchLush.value.set(p.grPatchLush);
      s.uPatchDry.value.set(p.grPatchDry);
    }
    s.uPatchStrength.value = p.grPatchStrength;
    s.uPatchScale.value = p.grPatchScale;
    s.uPatchBias.value = p.grPatchBias;

    s.uShadowStrength.value = p.grShadowStrength;
    s.uShadowSamples.value = p.grShadowSamples;
    s.uShadowSampleY.value = p.grShadowSampleY;
    s.uShadowRadius.value = p.grShadowRadius;

    s.uTransColor.value.set(p.grTransColor);
    s.uTransStrength.value = p.grTransStrength;
    s.uTransPower.value = p.grTransPower;
    s.uTransTip.value = p.grTransTip;
    s.uTransShadow.value = p.grTransShadow;

    s.uDebugChannel.value = p.grDebugChannel;
    s.uWindFixLocal.value = p.grWindFixLocal ? 1 : 0;

    s.uRockFlatten.value = p.grRockFlatten;
    s.uRockBend.value = p.grRockBend;
    s.uRockRadiusMul.value = p.grRockRadiusMul;
    s.uRockFalloff.value = p.grRockFalloff;

    s.uTintFloor.value = p.grTintFloor ? 1 : 0;
    s.uFlatFloorNormal.value = p.grFlatFloorNormal;
    s.uDirtColor.value.set(p.grDirtColor);
    s.uDirtCoverage.value = p.grDirtCoverage;
    s.uDirtScale.value = p.grDirtScale;
    s.uDirtSoftness.value = p.grDirtSoftness;
    s.uDirtWarp.value = p.grDirtWarp;
    s.uDirtCut.value = p.grDirtCut;
    s.uDirtBlend.value = p.grDirtBlend;
    s.uGndVarColor.value.set(p.grGndVarColor);
    s.uGndVarScale.value = p.grGndVarScale;
    s.uGndVarStrength.value = p.grGndVarStrength;
    s.uGndGrainScale.value = p.grGndGrainScale;
    s.uGndGrainStrength.value = p.grGndGrainStrength;
    s.uGndReliefScale.value = p.grGndReliefScale;
    s.uGndReliefStrength.value = p.grGndReliefStrength;

    s.uLeafBottom.value.set(p.grLeafBottom);
    s.uLeafTop.value.set(p.grLeafTop);
    s.uLeafGradPower.value = p.grLeafGradPower;
    s.uLeafBrightness.value = p.grLeafBrightness;
    s.uLeafVarColor.value.set(p.grLeafVarColor);
    s.uLeafVarStrength.value = p.grLeafVarStrength;
    s.uLeafVarScale.value = p.grLeafVarScale;
    s.uLeafWindStrength.value = p.grLeafWindStrength;
    s.uLeafFlutterAmp.value = p.grLeafFlutterAmp;
    s.uLeafFlutterSpeed.value = p.grLeafFlutterSpeed;
    s.uLeafDip.value = p.grLeafDip;

    b.uBarkScale.value = p.grBarkScale;
    b.uBarkTint.value.set(p.grBarkTint);
    b.uBarkTintStrength.value = p.grBarkTintStrength;
    b.uBarkSaturation.value = p.grBarkSaturation;
    b.uBarkBrightness.value = p.grBarkBrightness;
    b.uBarkAOStrength.value = p.grBarkAOStrength;
    b.uBarkRelief.value = p.grBarkRelief;

    fl.uTime.value = s.uTime.value;
    fl.uWindDir.value.copy(s.uWindDir.value);
    fl.uGrassColor.value.copy(s.uGrassBottom.value);
    fl.uColorR.value.set(f.flColorR);
    fl.uColorG.value.set(f.flColorG);
    fl.uColorB.value.set(f.flColorB);
    fl.uColorStem.value.set(f.flColorStem);
    fl.uBrightness.value = f.flBrightness;
    fl.uWindStrength.value = f.flWindStrength;
    fl.uWindSpeed.value = f.flWindSpeed;
    fl.uWindFreq.value = f.flWindFreq;
    fl.uWindTurb.value = f.flWindTurb;
    fl.uWindLean.value = f.flWindLean;
    fl.uBendAmp.value = f.flBendAmp;
    fl.uBendFreq.value = f.flBendFreq;
    fl.uFlDirtMax.value = f.flDirtMax;
  }

  setWireframe(on: boolean): void {
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ('wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = on;
      }
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.terrain?.dispose();
    this.group.removeFromParent();
  }
}
