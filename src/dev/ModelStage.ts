import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGroups } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createGouacheMaterial, type GouacheMaterial } from '../render/shading/GouacheMaterial';
import { makeToonMaterial, TOON_DEFAULT_STEPS } from './toonShading';
import { SURFACES, type SurfaceName } from '../art/surfaces';

/**
 * THE MODEL BENCH — loads one asset at a time and puts it in the world under the project's
 * own lighting and shading.
 *
 * The point of the bench is not "does the file open". Any viewer answers that. The
 * questions this project actually has about an incoming asset are all comparative, and all
 * need the real scene around the model to be answerable:
 *
 *   - Does it read at 00 §3 rule 9's camera range, 200-1500 m, or does it dissolve?
 *   - Does its silhouette hold against sky and against water, backlit and front-lit?
 *   - Is it the right SIZE? Modelling apps export in whatever unit was convenient; the
 *     world is metres, and a 0.01x asset looks fine alone and wrong the moment it is next
 *     to a 260 m island. Hence the scale rod and the measured bounding box, both in metres.
 *   - Does it survive the gouache ramp — 04 §2.3's "one shared chunk, many uniform sets" —
 *     or does it only look right with its own baked PBR maps? An asset that needs its own
 *     shading is an asset that will not match the world.
 *
 * The model hangs off three nested nodes so those questions stay independent of each other:
 *
 *   root   — where the model sits in the world (stage point + altitude)
 *   pivot  — yaw, including the turntable, so "rotate it" never disturbs placement
 *   holder — scale, so "resize it" never disturbs rotation
 *   offset — the recentring shift that puts the asset's own origin where we want it
 *
 * Flattening these is the classic way to end up with a turntable that also drifts the model
 * sideways. `offset` in particular has to be its own node rather than a position written
 * onto the loaded root: an animation clip is entitled to drive that root's transform, and
 * an asset whose recentring is silently overwritten on the first frame of playback is a
 * genuinely baffling bug to chase.
 */

export type MaterialMode = 'original' | 'toon' | SurfaceName;

export const MATERIAL_MODES: ReadonlyArray<MaterialMode> = Object.freeze([
  'original',
  'toon',
  ...(Object.keys(SURFACES) as SurfaceName[]),
]);

export interface ModelReport {
  name: string;
  source: string;
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
  /** Bounding box at the asset's authored scale, world units as exported. */
  nativeSize: THREE.Vector3;
  /** Bounding box as it currently stands in the world, metres. */
  worldSize: THREE.Vector3;
  /** Total factor applied: auto-fit x manual multiplier. */
  scale: number;
  animations: string[];
  skinned: boolean;
  warnings: string[];
}

/**
 * Gloss ceilings for an imported material, in LINEAR space (three's `Color.r` is linear;
 * the sRGB hex an exporter writes is not). 00 §3's surfaces are matte gouache — a mirror
 * highlight is off-model here regardless of what the asset was authored against.
 */
const SPECULAR_CAP = 0.06;
const METALNESS_CAP = 0.1;
const SHININESS_CAP = 8;
const ROUGHNESS_FLOOR = 0.7;

const EXTENSION = /\.([a-z0-9]+)$/i;

function extensionOf(name: string): string {
  return EXTENSION.exec(name)?.[1]?.toLowerCase() ?? '';
}

function baseName(url: string): string {
  const clean = url.split('?')[0] ?? url;
  return clean.slice(clean.lastIndexOf('/') + 1);
}

/**
 * A model with no vertex normals shades as a flat silhouette under any lighting model, which
 * looks exactly like a shader bug. Computing them is the same thing every DCC importer does,
 * so do it here and say so in the report rather than letting it read as our problem.
 */
function ensureNormals(root: THREE.Object3D, warnings: string[]): void {
  let fixed = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.getAttribute('normal')) {
      mesh.geometry.computeVertexNormals();
      fixed++;
    }
  });
  if (fixed > 0) warnings.push(fixed + ' mesh(es) had no normals — computed them');
}

/** One top-level node of the loaded asset, toggleable on its own. */
export interface ModelPart {
  name: string;
  triangles: number;
  object: THREE.Object3D;
}

/**
 * Remove lights and cameras that came in with the asset.
 *
 * Assets ship their studio. This project's rig is ONE directional sun (04 §1) and the whole
 * art direction — band count, terminator position, shadow hardness — is calibrated to that
 * one light; a downloaded FBX carrying a 1500-intensity point light and a 250-intensity spot
 * does not merely look different, it blows every surface it touches past 1.0 on a renderer
 * with no tone mapping (00 §5) and then feeds the result to the bloom pass. The model
 * disappears inside a white ball and nothing about the frame is about the model any more.
 *
 * So they go, and the count is reported rather than swallowed: "this asset expects its own
 * lighting" is a real fact about it, and one worth knowing before it is signed off.
 */
function stripRigging(root: THREE.Object3D, warnings: string[]): void {
  const doomed: THREE.Object3D[] = [];
  root.traverse((child) => {
    if ((child as THREE.Light).isLight || (child as THREE.Camera).isCamera) doomed.push(child);
  });
  if (doomed.length === 0) return;
  const lights = doomed.filter((o) => (o as THREE.Light).isLight).length;
  for (const node of doomed) node.removeFromParent();
  warnings.push(
    'stripped ' + lights + ' light(s) and ' + (doomed.length - lights) +
    ' camera(s) the asset shipped — the scene owns the lighting (04 §1)',
  );
}

/**
 * Per-asset load options, supplied by the caller from a `<name>.parts.json` sidecar.
 *
 * `hide` names top-level parts to switch off before the first fit. It exists because assets
 * arrive with their showroom attached — a water plane, a jetty, a row of barrels, a spare
 * cabin off to one side — and all of it is geometry, so all of it lands in the bounding box
 * and walks off with the auto-fit. Applying the list BEFORE the fit rather than after is
 * what stops the model visibly jumping a moment after it appears.
 */
export interface ModelLoadOptions {
  hide?: readonly string[];
}

/**
 * Collapse a geometry's material groups.
 *
 * A group is a DRAW CALL. Exporters that assign materials per face — FBX out of
 * Blender especially — emit one group per contiguous RUN of faces sharing a
 * material, so a mesh can arrive carrying well over a thousand of them for a
 * handful of actual materials. The Savoia is 38 meshes and 8,237 groups: five
 * thousand draw calls for one aeroplane. That is not a heavy model being heavy,
 * it is a model whose faces have never been sorted by material.
 *
 * Sorting them merges every run of a given material into ONE group. Same
 * triangles, same materials, same picture, two orders of magnitude fewer draws.
 *
 * Two paths, because three only ships the easy one: indexed geometry goes through
 * `mergeGroups`, which reorders the index buffer. FBXLoader emits NON-indexed
 * geometry, where there is no index to reorder — so `sortGroupsNonIndexed` below
 * permutes the vertex attributes themselves.
 */
function collapseGroups(root: THREE.Object3D, warnings: string[]): void {
  let before = 0;
  let after = 0;
  let touched = 0;

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const groups = geometry.groups?.length ?? 0;
    before += Math.max(groups, 1);
    if (groups > 1) {
      try {
        if (geometry.getIndex()) mergeGroups(geometry);
        else sortGroupsNonIndexed(geometry);
        touched++;
      } catch {
        // Interleaved buffers, groups that do not tile the array, anything else
        // unexpected: leave the geometry exactly as it arrived and keep counting.
      }
    }
    after += Math.max(geometry.groups?.length ?? 0, 1);
  });

  if (touched > 0 && after < before) {
    warnings.push(
      'sorted material groups on ' + touched + ' mesh(es): ' +
      before.toLocaleString() + ' draw calls -> ' + after.toLocaleString(),
    );
  }
}

/**
 * Reorder a non-indexed geometry's vertices so each material's faces are
 * contiguous, then emit one group per material.
 *
 * Every attribute is permuted by the same vertex ordering, so the mesh is
 * unchanged in every respect except the order its triangles are stored in.
 */
function sortGroupsNonIndexed(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  if (!position) return;
  const total = position.count;

  const sorted = [...geometry.groups].sort(
    (a, b) => (a.materialIndex ?? 0) - (b.materialIndex ?? 0) || a.start - b.start,
  );

  const order = new Uint32Array(total);
  const merged: Array<{ start: number; count: number; materialIndex: number }> = [];
  let cursor = 0;
  let current = -1;

  for (const group of sorted) {
    const materialIndex = group.materialIndex ?? 0;
    if (materialIndex !== current) {
      merged.push({ start: cursor, count: 0, materialIndex });
      current = materialIndex;
    }
    const end = Math.min(group.start + group.count, total);
    for (let i = group.start; i < end; i++) order[cursor++] = i;
    merged[merged.length - 1]!.count += end - group.start;
  }

  // If the groups do not exactly tile the vertex buffer, the permutation would
  // drop or duplicate vertices. Bail rather than corrupt the mesh.
  if (cursor !== total) return;

  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name];
    if (!attribute || !(attribute as THREE.BufferAttribute).isBufferAttribute) continue;
    const attr = attribute as THREE.BufferAttribute;
    const src = attr.array;
    // `slice` keeps the concrete typed-array type, whatever it is.
    const dst = src.slice();
    const items = attr.itemSize;
    for (let i = 0; i < total; i++) {
      const from = order[i]! * items;
      const to = i * items;
      for (let k = 0; k < items; k++) dst[to + k] = src[from + k]!;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(dst, items, attr.normalized));
  }

  geometry.clearGroups();
  for (const group of merged) geometry.addGroup(group.start, group.count, group.materialIndex);
}

export interface ModelStageOptions {
  /** Where the model sits in the world, XZ metres. Y comes from `setAltitude`. */
  stagePoint: THREE.Vector3;
  /** Longest-axis size the auto-fit normalises to, metres. */
  targetSize?: number;
}

export class ModelStage {
  readonly root = new THREE.Group();
  readonly pivot = new THREE.Group();
  readonly holder = new THREE.Group();
  readonly offset = new THREE.Group();

  /** Set once a model is installed; null while the bench is empty. */
  model: THREE.Object3D | null = null;
  report: ModelReport | null = null;

  autoFit = true;
  targetSize: number;
  scaleMultiplier = 1;
  spin = 0;
  castShadow = true;

  private materialMode: MaterialMode = 'original';
  private wireframe = false;
  private tamed = true;
  /** Original gloss values, so the taming below is reversible. */
  private readonly gloss = new Map<THREE.Material, { specular: number; shininess: number; metalness: number; roughness: number }>();
  private readonly originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private readonly gouacheMaterials: GouacheMaterial[] = [];
  private readonly toonMaterials: THREE.MeshToonMaterial[] = [];
  /**
   * Forced on from outside — the grass world's one "toon the whole scene" switch
   * has to reach the aircraft too. Kept separate from `materialMode` rather than
   * writing into it so the shading dropdown still says what it said, and turning
   * the switch back off returns the model to whatever was actually selected.
   */
  private toonOverride = false;
  private toonSteps = TOON_DEFAULT_STEPS;
  private readonly loadingManager = new THREE.LoadingManager();
  private readonly gltf: GLTFLoader;
  private readonly fbx: FBXLoader;
  private readonly obj: OBJLoader;
  private readonly draco: DRACOLoader;
  /** Object URLs minted for a drag-and-drop load, revoked on the next load. */
  private objectUrls: string[] = [];
  private mixer: THREE.AnimationMixer | null = null;
  /** Clips the asset shipped with. Listed, never auto-played — see `playClip`. */
  clips: THREE.AnimationClip[] = [];
  /** Top-level nodes of the asset, so a display base or pedestal can be switched off. */
  parts: ModelPart[] = [];
  private playing: THREE.AnimationAction | null = null;
  private altitude = 0;
  private yaw = 0;
  private turntable = 0;

  constructor(scene: THREE.Scene, options: ModelStageOptions) {
    this.targetSize = options.targetSize ?? 12;
    this.root.position.copy(options.stagePoint);
    this.root.add(this.pivot);
    this.pivot.add(this.holder);
    this.holder.add(this.offset);
    scene.add(this.root);

    this.draco = new DRACOLoader();
    // Served by the dev middleware in vite.config.ts, copied into the build output for a
    // production bundle. Not a CDN: the bench has to work with the network off.
    this.draco.setDecoderPath('/draco/');
    this.gltf = new GLTFLoader(this.loadingManager);
    this.gltf.setDRACOLoader(this.draco);
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
    this.fbx = new FBXLoader(this.loadingManager);
    this.obj = new OBJLoader(this.loadingManager);
  }

  get position(): THREE.Vector3 {
    return this.root.position;
  }

  /** World-space centre of the model's bounds — what the camera should orbit. */
  centre(target = new THREE.Vector3()): THREE.Vector3 {
    if (!this.model) return target.copy(this.root.position);
    const box = visibleBox(this.model);
    return box.isEmpty() ? target.copy(this.root.position) : box.getCenter(target);
  }

  /** Longest world-space dimension, metres. Drives every framing distance. */
  get radius(): number {
    const size = this.report?.worldSize;
    if (!size) return 10;
    return Math.max(size.x, size.y, size.z, 1) * 0.5;
  }

  async loadUrl(url: string, name = baseName(url), options: ModelLoadOptions = {}): Promise<ModelReport> {
    this.loadingManager.setURLModifier(undefined);
    return this.install(await this.parse(url, extensionOf(name)), name, url, options);
  }

  /**
   * Load from a drag-and-drop or file-picker selection.
   *
   * A .glb is one self-contained file, but a .gltf is a manifest that fetches its own .bin
   * and textures by relative path — and a dropped File has no path to be relative to. So
   * every dropped file gets an object URL, and the loading manager rewrites the asset's
   * internal references onto that map by filename. Dropping the whole export folder then
   * works; dropping the .gltf alone gives an untextured mesh and says so.
   */
  async loadFiles(files: readonly File[], options: ModelLoadOptions = {}): Promise<ModelReport> {
    const byName = new Map<string, string>();
    for (const file of files) {
      const url = URL.createObjectURL(file);
      this.revokeLater(url);
      byName.set(file.name, url);
    }

    const ROOT_TYPES = ['glb', 'gltf', 'fbx', 'obj'];
    const root = files.find((f) => ROOT_TYPES.includes(extensionOf(f.name)));
    if (!root) {
      throw new Error(
        'no .glb / .gltf / .fbx / .obj in the drop (' + files.map((f) => f.name).join(', ') + ')',
      );
    }

    this.loadingManager.setURLModifier((url) => byName.get(baseName(url)) ?? url);
    const rootUrl = byName.get(root.name);
    if (!rootUrl) throw new Error('could not create an object URL for ' + root.name);

    const object = await this.parse(rootUrl, extensionOf(root.name));
    this.loadingManager.setURLModifier(undefined);
    return this.install(object, root.name, 'dropped file', options);
  }

  private async parse(url: string, ext: string): Promise<{ object: THREE.Object3D; clips: THREE.AnimationClip[] }> {
    switch (ext) {
      case 'glb':
      case 'gltf': {
        const gltf = await this.gltf.loadAsync(url);
        return { object: gltf.scene, clips: gltf.animations };
      }
      case 'fbx': {
        const object = await this.fbx.loadAsync(url);
        return { object, clips: object.animations };
      }
      case 'obj': {
        const object = await this.obj.loadAsync(url);
        return { object, clips: [] };
      }
      default:
        throw new Error('unsupported format ".' + ext + '" — use .glb, .gltf, .fbx or .obj');
    }
  }

  private install(
    loaded: { object: THREE.Object3D; clips: THREE.AnimationClip[] },
    name: string,
    source: string,
    options: ModelLoadOptions = {},
  ): ModelReport {
    this.clear();

    const warnings: string[] = [];
    const object = loaded.object;
    stripRigging(object, warnings);
    collapseGroups(object, warnings);
    ensureNormals(object, warnings);

    let meshes = 0;
    let triangles = 0;
    let vertices = 0;
    let skinned = false;
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();

    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;

      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      vertices += position ? position.count : 0;
      const index = geometry.getIndex();
      triangles += index ? index.count / 3 : (position ? position.count / 3 : 0);

      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.castShadow;
      this.originalMaterials.set(mesh, mesh.material);
      for (const material of asArray(mesh.material)) {
        materials.add(material);
        this.rememberGloss(material);
        for (const texture of texturesOf(material)) textures.add(texture);
      }
    });

    if (meshes === 0) warnings.push('no meshes in the file — nothing to shade');
    if (skinned) warnings.push('skinned mesh: the gouache modes read modelMatrix only, so a posed rig will shade from its bind pose');
    if (textures.size === 0 && meshes > 0) warnings.push('no textures — the asset is material-coloured only');

    this.offset.add(object);
    this.model = object;
    this.clips = loaded.clips;
    this.parts = object.children
      .map((child, i) => ({
        name: child.name || 'part ' + (i + 1),
        triangles: triangleCount(child),
        object: child,
      }))
      .filter((part) => part.triangles > 0)
      .sort((a, b) => b.triangles - a.triangles);
    if (loaded.clips.length > 0) this.mixer = new THREE.AnimationMixer(object);

    // Before the fit, so the reported size is the size of what you can see. A name in the
    // list that the asset does not have is worth saying out loud: it usually means the
    // sidecar was written against an older export and is now hiding nothing.
    const hide = options.hide ?? [];
    let hidden = 0;
    for (const partName of hide) {
      const part = this.parts.find((p) => p.name === partName);
      if (part) {
        part.object.visible = false;
        hidden++;
      } else {
        warnings.push('sidecar hides "' + partName + '", which this asset has no part named');
      }
    }
    if (hidden > 0) {
      warnings.push('hid ' + hidden + ' scenery part(s) per the .parts.json sidecar');
    }

    const nativeSize = new THREE.Vector3();
    this.applyFit(nativeSize);

    const report: ModelReport = {
      name,
      source,
      meshes,
      triangles: Math.round(triangles),
      vertices,
      materials: materials.size,
      textures: textures.size,
      nativeSize,
      worldSize: nativeSize.clone().multiplyScalar(this.currentScale(nativeSize)),
      scale: this.currentScale(nativeSize),
      animations: loaded.clips.map((c) => c.name || '(unnamed)'),
      skinned,
      warnings,
    };
    this.report = report;

    let glossy = 0;
    for (const saved of this.gloss.values()) {
      if (saved.specular > SPECULAR_CAP || saved.metalness > METALNESS_CAP) glossy++;
    }
    if (glossy > 0) {
      warnings.push(
        glossy + ' material(s) glossier than the art direction allows — flattened by "tame gloss"',
      );
    }

    // The material mode is a bench setting, not a per-model one: switching assets while
    // reviewing them under the aircraft preset should keep you under the aircraft preset.
    this.applyTaming();
    this.applyMaterialMode(this.materialMode);
    this.applyWireframe();
    return report;
  }

  /**
   * Play one of the asset's clips, or `null` to return it to its bind pose.
   *
   * Nothing plays on load. A clip is free to drive the root transform, which moves the
   * model out of the framing the fit just measured — fine when you asked for it, mystifying
   * when you did not. So playback is a decision, and the fit is measured on the bind pose.
   */
  playClip(name: string | null): void {
    if (this.playing) {
      this.playing.stop();
      this.playing = null;
    }
    if (!this.mixer || !this.model) return;
    if (name === null) {
      // stopAllAction leaves the last evaluated pose behind; the bind pose is what "none"
      // should mean, so restore it explicitly.
      this.mixer.stopAllAction();
      this.mixer.setTime(0);
      return;
    }
    const clip = this.clips.find((c) => (c.name || '(unnamed)') === name);
    if (!clip) return;
    this.playing = this.mixer.clipAction(clip);
    this.playing.reset().play();
  }

  /** Remove and dispose whatever is on the stage. Safe to call when empty. */
  clear(): void {
    if (this.model) {
      this.offset.remove(this.model);
      disposeTree(this.model);
      this.model = null;
    }
    for (const material of this.gouacheMaterials) material.dispose();
    this.gouacheMaterials.length = 0;
    for (const material of this.toonMaterials) material.dispose();
    this.toonMaterials.length = 0;
    this.originalMaterials.clear();
    this.gloss.clear();
    this.mixer = null;
    this.playing = null;
    this.clips = [];
    this.parts = [];
    this.report = null;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  setMaterialMode(mode: MaterialMode): void {
    this.materialMode = mode;
    this.applyMaterialMode(mode);
    this.applyWireframe();
  }

  get material(): MaterialMode {
    return this.materialMode;
  }

  /**
   * Force toon shading regardless of the selected mode, or release the force.
   *
   * `steps` is passed in rather than owned here so the aircraft bands at the same
   * N·L as the grass it is parked next to — one caller sets both.
   */
  setToonOverride(on: boolean, steps = TOON_DEFAULT_STEPS): void {
    this.toonOverride = on;
    this.toonSteps = steps;
    this.applyMaterialMode(this.materialMode);
    this.applyWireframe();
  }

  get toonForced(): boolean {
    return this.toonOverride;
  }

  private applyMaterialMode(mode: MaterialMode): void {
    if (!this.model) return;

    for (const material of this.gouacheMaterials) material.dispose();
    this.gouacheMaterials.length = 0;
    for (const material of this.toonMaterials) material.dispose();
    this.toonMaterials.length = 0;

    // The override wins over everything, including 'original': it exists so one
    // switch elsewhere can put the whole scene on the same ramp.
    const effective: MaterialMode = this.toonOverride ? 'toon' : mode;

    for (const [mesh, original] of this.originalMaterials) {
      if (effective === 'original') {
        mesh.material = original;
        continue;
      }
      if (effective === 'toon') {
        // Per mesh, like the gouache modes below and for the same reason: the
        // asset's own base colours and maps are carried across, so a two-tone
        // hull stays two-tone. Only the light response is replaced.
        const toon = asArray(original).map((material) => {
          const made = makeToonMaterial(material, this.toonSteps);
          this.toonMaterials.push(made);
          return made;
        });
        mesh.material = Array.isArray(original) ? toon : toon[0]!;
        continue;
      }
      // One gouache material per mesh rather than one for the whole model: the asset's own
      // base colours are kept, so a two-tone hull stays two-tone through the ramp. Only the
      // LIGHTING model is being replaced here, not the paint job.
      const first = asArray(original)[0];
      const tint = first && 'color' in first ? (first as THREE.MeshStandardMaterial).color.getHex() : undefined;
      const gouache = createGouacheMaterial(
        tint === undefined ? { surface: effective } : { surface: effective, color: tint },
      );
      this.gouacheMaterials.push(gouache);
      mesh.material = gouache;
    }
  }

  /**
   * Show or hide one top-level part, then re-fit.
   *
   * The re-fit is the point. Hiding a display base that was inflating the bounding box has
   * to change the reported size, or the scale reading stays wrong in exactly the case you
   * turned the part off to fix.
   */
  setPartVisible(part: ModelPart, visible: boolean): void {
    part.object.visible = visible;
    this.refit();
  }

  /**
   * Flatten the specular highlight on the asset's own materials.
   *
   * Exporters hand out a white specular and a high shininess by default, and this project's
   * renderer contract (00 §5) is NoToneMapping — nothing rolls off above 1.0. So a stock
   * FBX under a 2.0-intensity sun puts a highlight several times over white on screen, the
   * bloom pass finds it exactly as designed, and the model disappears inside a white ball.
   *
   * That is not a bug in any of the three parts, and it is not what you loaded the asset to
   * look at. Default on, reversible, and reported — because the underlying fact (this asset
   * is glossier than the art direction allows) is worth knowing, not hiding. The gouache
   * modes never see any of this: they replace the lighting outright.
   */
  setTameGloss(on: boolean): void {
    this.tamed = on;
    this.applyTaming();
  }

  get glossTamed(): boolean {
    return this.tamed;
  }

  private rememberGloss(material: THREE.Material): void {
    if (this.gloss.has(material)) return;
    const phong = material as THREE.MeshPhongMaterial;
    const standard = material as THREE.MeshStandardMaterial;
    this.gloss.set(material, {
      specular: phong.specular ? Math.max(phong.specular.r, phong.specular.g, phong.specular.b) : 0,
      shininess: phong.shininess ?? 0,
      metalness: standard.metalness ?? 0,
      roughness: standard.roughness ?? 1,
    });
  }

  private applyTaming(): void {
    for (const [material, saved] of this.gloss) {
      const phong = material as THREE.MeshPhongMaterial;
      const standard = material as THREE.MeshStandardMaterial;
      if (phong.specular) {
        phong.specular.setScalar(this.tamed ? Math.min(saved.specular, SPECULAR_CAP) : saved.specular);
        phong.shininess = this.tamed ? Math.min(saved.shininess, SHININESS_CAP) : saved.shininess;
      }
      if (standard.isMeshStandardMaterial) {
        standard.metalness = this.tamed ? Math.min(saved.metalness, METALNESS_CAP) : saved.metalness;
        standard.roughness = this.tamed ? Math.max(saved.roughness, ROUGHNESS_FLOOR) : saved.roughness;
      }
      material.needsUpdate = true;
    }
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyWireframe();
  }

  private applyWireframe(): void {
    if (!this.model) return;
    this.model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of asArray(mesh.material)) {
        if ('wireframe' in material) (material as THREE.MeshStandardMaterial).wireframe = this.wireframe;
      }
    });
  }

  setShadows(on: boolean): void {
    this.castShadow = on;
    this.model?.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = on;
      mesh.receiveShadow = on;
    });
  }

  setAutoFit(on: boolean): void {
    this.autoFit = on;
    this.refit();
  }

  setTargetSize(metres: number): void {
    this.targetSize = metres;
    this.refit();
  }

  setScaleMultiplier(k: number): void {
    this.scaleMultiplier = k;
    this.refit();
  }

  setAltitude(metres: number): void {
    this.altitude = metres;
    this.root.position.y = metres;
  }

  get currentAltitude(): number {
    return this.altitude;
  }

  setYaw(degrees: number): void {
    this.yaw = degrees;
    this.pivot.rotation.y = THREE.MathUtils.degToRad(degrees + this.turntable);
  }

  get currentYaw(): number {
    return this.yaw;
  }

  update(dt: number): void {
    this.mixer?.update(dt);
    if (this.spin !== 0) {
      this.turntable = (this.turntable + this.spin * dt) % 360;
      this.pivot.rotation.y = THREE.MathUtils.degToRad(this.yaw + this.turntable);
    }
  }

  private refit(): void {
    if (!this.model || !this.report) return;
    // Re-measured, not reused: hiding a part changes what the authored size IS, and a report
    // that keeps quoting the old one is wrong in exactly the case you hid the part to fix.
    const nativeSize = new THREE.Vector3();
    this.applyFit(nativeSize);
    if (nativeSize.lengthSq() === 0) return;
    this.report.nativeSize.copy(nativeSize);
    this.report.scale = this.currentScale(nativeSize);
    this.report.worldSize.copy(nativeSize).multiplyScalar(this.report.scale);
  }

  private currentScale(nativeSize: THREE.Vector3): number {
    const longest = Math.max(nativeSize.x, nativeSize.y, nativeSize.z);
    const fit = this.autoFit && longest > 0 ? this.targetSize / longest : 1;
    return fit * this.scaleMultiplier;
  }

  /**
   * Measure at unit scale, then scale and recentre.
   *
   * `Box3.setFromObject` reports WORLD-space bounds, so the measurement has to be taken with
   * the stage's own transforms neutralised — otherwise altitude and yaw leak into the
   * asset's "authored size" and the fit chases its own tail. Everything is restored before
   * returning. Matrices are refreshed from `root` rather than from the model, because the
   * scale that was just written lives on an ancestor and a stale ancestor matrix is exactly
   * how you measure a 12 m asset as 475 m.
   *
   * The model is centred on X/Z but its BASE is put at y=0, not its centre: at altitude 0 a
   * boat should float rather than sink half of itself through the water, and a building
   * should stand on the ground. Altitude then lifts from a meaningful zero.
   */
  private applyFit(nativeSizeOut: THREE.Vector3): void {
    const model = this.model;
    if (!model) return;

    const savedPosition = this.root.position.clone();
    const savedYaw = this.pivot.rotation.y;
    this.root.position.set(0, 0, 0);
    this.pivot.rotation.y = 0;
    this.holder.scale.setScalar(1);
    this.offset.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);

    const box = visibleBox(model);
    if (box.isEmpty()) {
      // Everything is switched off. Leave the transform alone rather than dividing by zero.
      this.root.position.copy(savedPosition);
      this.pivot.rotation.y = savedYaw;
      this.root.updateMatrixWorld(true);
      return;
    }
    box.getSize(nativeSizeOut);
    const centre = box.getCenter(new THREE.Vector3());

    this.holder.scale.setScalar(this.currentScale(nativeSizeOut));
    this.offset.position.set(-centre.x, -box.min.y, -centre.z);

    this.root.position.copy(savedPosition);
    this.pivot.rotation.y = savedYaw;
    this.root.updateMatrixWorld(true);
  }

  private revokeLater(url: string): void {
    this.objectUrls.push(url);
  }

  dispose(): void {
    this.clear();
    this.draco.dispose();
    this.root.removeFromParent();
  }
}

/**
 * Bounds over VISIBLE geometry only.
 *
 * `Box3.setFromObject` ignores visibility, which is wrong for a bench whose whole point is
 * that you turn parts off. Assets routinely ship a display base or a turntable pedestal
 * bolted into the same file as the subject — this asset does — and fitting to that measures
 * the furniture instead of the aircraft.
 */
export function visibleBox(root: THREE.Object3D, target = new THREE.Box3()): THREE.Box3 {
  target.makeEmpty();
  const walk = (node: THREE.Object3D): void => {
    if (!node.visible) return;
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      mesh.updateWorldMatrix(false, false);
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (geometry.boundingBox) {
        target.union(geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      }
    }
    for (const child of node.children) walk(child);
  };
  root.updateWorldMatrix(true, false);
  walk(root);
  return target;
}

/** Triangles in a subtree, visible or not. Reported per part so the heavy ones are obvious. */
function triangleCount(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    total += index ? index.count / 3 : position ? position.count / 3 : 0;
  });
  return Math.round(total);
}

function asArray(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function texturesOf(material: THREE.Material): THREE.Texture[] {
  const found: THREE.Texture[] = [];
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value && (value as THREE.Texture).isTexture) found.push(value as THREE.Texture);
  }
  return found;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of asArray(mesh.material)) {
      for (const texture of texturesOf(material)) texture.dispose();
      material.dispose();
    }
  });
}

/** Formats a report for the on-screen panel. Numbers first — that is the deliverable. */
export function formatModelReport(report: ModelReport | null): string {
  if (!report) return 'no model loaded\n\ndrop a .glb / .gltf / .fbx / .obj onto the window,\nor pick one from the Model folder list.';

  const m3 = (v: THREE.Vector3): string =>
    v.x.toFixed(2) + ' x ' + v.y.toFixed(2) + ' x ' + v.z.toFixed(2);

  const lines = [
    report.name + '   (' + report.source + ')',
    '',
    'meshes      ' + report.meshes + '   materials ' + report.materials + '   textures ' + report.textures,
    'triangles   ' + report.triangles.toLocaleString() + '   verts ' + report.vertices.toLocaleString(),
    'authored    ' + m3(report.nativeSize) + '  (file units)',
    'in world    ' + m3(report.worldSize) + '  m   at ' + report.scale.toFixed(4) + 'x',
  ];
  if (report.animations.length > 0) {
    lines.push('clips       ' + report.animations.length + ' (none playing — pick one in the panel)');
  }
  for (const warning of report.warnings) lines.push('! ' + warning);
  return lines.join('\n');
}
