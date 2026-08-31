import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';

/**
 * THE TOWN — a street of imported buildings on the levelled shelf.
 *
 * Fourteen Sketchfab downloads in three formats (8 FBX, 4 OBJ, 2 Collada), by
 * eleven different authors, none of whom agreed with any other on units, on which
 * way is up, on which way is front, or on how a material should find its texture.
 * Everything in this file is about making that pile behave like one street.
 *
 * ── Scale ──────────────────────────────────────────────────────────────────────
 *
 * "All to scale" cannot be read off the files. `nivelles 3.fbx` is authored in
 * centimetres, `model.dae` in metres, `milwaukeeroaddepot.obj` in something else
 * again, and nothing in any of them says which. An importer that trusted the
 * numbers would put a house next to a lamp post four times its height.
 *
 * So scale is not imported, it is DECLARED: every entry states how tall the real
 * building is in metres, and the loader fits the asset's measured bounding box to
 * it. A Belgian terraced house is 11 m to the ridge, a clock tower is 16, a street
 * lamp is 4.5 — those are the numbers being trusted, and they are the numbers to
 * edit if something looks wrong. The asset's own units never enter into it, which
 * is exactly what makes fourteen unrelated exports agree.
 *
 * ── Texture ────────────────────────────────────────────────────────────────────
 *
 * These are "source" downloads: the model as the author had it, with texture paths
 * pointing at folders on the author's machine (`map_Kd texture\hanover2_diffuse.png`
 * and worse). None of those resolve here, and the `.mtl` files that would carry
 * them are not shipped alongside in a usable state.
 *
 * Rather than hand-map fourteen material sets, there is one rule: each entry names
 * ONE diffuse image, and it goes on every material the asset has. Colour maps are
 * kept; normal, specular, roughness, metalness and AO are all dropped. That is not
 * laziness about the other maps — 00 §3's surfaces are matte and 04 §2 runs one
 * shared ramp, so a photographic gloss map on a building is a thing this project
 * would have to spend effort undoing later.
 */

export type TownModelFormat = 'fbx' | 'obj' | 'dae';

export interface TownEntry {
  /** Label, for the report and for the object's name in the graph. */
  name: string;
  /** Model URL, resolved by the caller from `src/models/town/`. */
  url: string;
  format: TownModelFormat;
  /** One diffuse image for the whole asset. See the header. */
  textureUrl?: string;
  /**
   * Real-world height in metres, ridge to ground. THE scale reference — see the
   * header. Everything else about the asset's size follows from this.
   */
  height: number;
  /**
   * Which of the asset's own axes points at the sky.
   *
   * Three is Y-up; a lot of DCC tools are Z-up, and an OBJ carries no header
   * saying which — so a Z-up export arrives lying on its back, and fitting it "to
   * height" then measures its depth and inflates the whole building. Declared
   * rather than sniffed: the giveaways (a crowded base plane, an aspect that looks
   * building-shaped) are heuristics, and a heuristic that silently lays one house
   * on its side is worse than a field you can read.
   */
  upAxis?: 'y' | 'z';
  /** Degrees to turn it so its front faces the street. */
  yaw?: number;
  /** Extra metres of gap after this building, for a corner or a square. */
  gapAfter?: number;
}

/**
 * A 1.8 m human figure, built rather than imported.
 *
 * This is a MEASURING TOOL, and that is why it is procedural: an imported person
 * would arrive in some other unit and need calibrating against the very thing it
 * exists to calibrate. Nine primitives at hard-coded human proportions cannot be
 * wrong about how tall they are.
 *
 * Stand one beside a building and the building's own doors and window sills tell
 * you immediately whether its declared height is right — a door should come to
 * roughly the figure's own height, a storey to about three-quarters again.
 */
function makeScaleFigure(): THREE.Group {
  const figure = new THREE.Group();
  figure.name = 'scale-figure';
  const skin = new THREE.MeshPhongMaterial({ color: 0xd94f30, specular: 0x000000, shininess: 0, flatShading: true });

  const add = (geometry: THREE.BufferGeometry, x: number, y: number, z = 0): void => {
    const mesh = new THREE.Mesh(geometry, skin);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    figure.add(mesh);
  };

  // Metres, from the ground up: legs 0.85, torso to 1.55, head centred at 1.68.
  add(new THREE.CapsuleGeometry(0.075, 0.6, 3, 6), -0.1, 0.44);
  add(new THREE.CapsuleGeometry(0.075, 0.6, 3, 6), 0.1, 0.44);
  add(new THREE.CapsuleGeometry(0.16, 0.5, 3, 8), 0, 1.15);
  add(new THREE.CapsuleGeometry(0.055, 0.5, 3, 6), -0.24, 1.13);
  add(new THREE.CapsuleGeometry(0.055, 0.5, 3, 6), 0.24, 1.13);
  add(new THREE.SphereGeometry(0.115, 10, 8), 0, 1.68);
  return figure;
}

export interface TownOptions {
  /** World X the street starts at. Buildings run in +X from here. */
  startX: number;
  /** World Z of the building frontage. They stand with their fronts at this line. */
  frontZ: number;
  /** Ground height under a world point. */
  groundAt: (x: number, z: number) => number;
  /** Metres between neighbours. Terraces want this near zero. */
  spacing?: number;
  /**
   * Turn any building that is deeper than it is wide a quarter turn, so its wide
   * facade addresses the street. Default on. See `Town.place`.
   */
  faceStreet?: boolean;
  /**
   * Street lamps, spaced along the frontage in front of the buildings. More than
   * one model alternates down the row, which is what stops a long street reading
   * as a single asset stamped out N times.
   */
  lamps?: TownEntry[];
  lampSpacing?: number;
  lampOffsetZ?: number;
  /** Stand a 1.8 m figure beside every building. See `makeScaleFigure`. */
  scaleFigures?: boolean;
}

export interface TownReport {
  name: string;
  /** What the file said, before any fitting. */
  nativeSize: THREE.Vector3;
  /** What it is in the world now, metres. */
  worldSize: THREE.Vector3;
  scale: number;
  meshes: number;
  triangles: number;
  materials: number;
  textured: boolean;
  x: number;
}

export class Town {
  readonly group = new THREE.Group();
  readonly reports: TownReport[] = [];
  /** The 1.8 m figures, in their own node so one toggle shows or hides the lot. */
  readonly figures = new THREE.Group();
  /** Total frontage the street ended up occupying, metres. */
  frontage = 0;

  private readonly disposables: Array<{ dispose(): void }> = [];

  private constructor() {
    this.group.name = 'town';
  }

  static async load(scene: THREE.Scene, entries: readonly TownEntry[], options: TownOptions): Promise<Town> {
    const town = new Town();
    const spacing = options.spacing ?? 0.6;

    // Sequential, not Promise.all. Two of these are 17 MB of text (an OBJ with
    // 16.7 MB of vertices, a Collada with 17 MB of XML) and parsing them is
    // main-thread work — firing all fourteen at once stalls the tab for as long as
    // the total takes anyway, with the page frozen instead of filling in.
    let cursor = options.startX;
    for (const entry of entries) {
      let placed: { object: THREE.Object3D; report: TownReport } | null = null;
      try {
        placed = await town.place(entry, cursor, options);
      } catch (error) {
        console.error(`[Town] ${entry.name} failed to load`, error);
        continue;
      }
      town.figures.add(town.figureAt(cursor + 0.6, options));
      cursor += placed.report.worldSize.x + spacing + (entry.gapAfter ?? 0);
    }
    town.figures.name = 'scale-figures';
    town.figures.visible = options.scaleFigures ?? false;
    town.group.add(town.figures);

    town.frontage = cursor - options.startX;
    await town.lampsAlong(options, town.frontage);

    scene.add(town.group);
    return town;
  }

  /** Fit one building to its declared height and stand it on the ground. */
  private async place(
    entry: TownEntry,
    x: number,
    options: TownOptions,
  ): Promise<{ object: THREE.Object3D; report: TownReport }> {
    let raw: THREE.Object3D = await loadModel(entry.url, entry.format);
    const texture = entry.textureUrl ? await loadTexture(entry.textureUrl) : null;

    // Yaw is applied to an inner node BEFORE measuring, so the bounding box that
    // decides the frontage is the box of the building as it will actually stand.
    // Measuring first and turning afterwards is how a row of houses ends up
    // overlapping wherever one of them was rotated 90 degrees.
    // Up-axis first, then yaw, then measure. Both corrections are inside the node
    // whose box decides the frontage, so what is measured is the building as it
    // will actually stand.
    if (entry.upAxis === 'z') {
      const upright = new THREE.Group();
      upright.rotation.x = -Math.PI / 2;
      upright.add(raw);
      raw = upright;
    }

    // FACE THE STREET.
    //
    // Nothing in an FBX or an OBJ says which side of a building is the front, and
    // these fourteen do not agree: some are authored with the facade across X,
    // some across Z. Left alone, half the row shows the street its gable end.
    //
    // The rule is geometric, not per-asset: a building is WIDER ACROSS ITS FRONT
    // than it is deep — that is what a frontage is — so any model that arrives
    // deeper than it is wide is turned a quarter turn. It gets every one of these
    // right, and `yaw` is still there to override it.
    let autoYaw = 0;
    if ((options.faceStreet ?? true) && entry.yaw === undefined) {
      raw.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(raw).getSize(new THREE.Vector3());
      if (box.z > box.x) autoYaw = 90;
    }

    const turned = new THREE.Group();
    turned.rotation.y = THREE.MathUtils.degToRad(entry.yaw ?? autoYaw);
    turned.add(raw);
    turned.updateMatrixWorld(true);

    const nativeBox = new THREE.Box3().setFromObject(turned);
    const nativeSize = nativeBox.getSize(new THREE.Vector3());
    const scale = nativeSize.y > 0 ? entry.height / nativeSize.y : 1;

    let meshes = 0;
    let triangles = 0;
    const materials = new Set<THREE.Material>();
    turned.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      const position = mesh.geometry.getAttribute('position');
      triangles += (mesh.geometry.index ? mesh.geometry.index.count : (position?.count ?? 0)) / 3;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (const material of asArray(mesh.material)) {
        materials.add(material);
        dressMaterial(material, texture);
      }
    });
    for (const material of materials) this.disposables.push(material);

    // The fit node carries the scale; the stand node carries where it goes. Kept
    // apart so re-scaling one building never moves it and vice versa.
    const fit = new THREE.Group();
    fit.name = 'fit:' + entry.name;
    fit.scale.setScalar(scale);
    // Recentre on X and Z and sit the base on Y = 0, so the node's own origin is
    // the building's front-left corner on the ground rather than wherever the
    // exporter's origin happened to fall — several of these are authored miles
    // from theirs.
    const centre = nativeBox.getCenter(new THREE.Vector3());
    turned.position.set(-centre.x, -nativeBox.min.y, -centre.z);
    fit.add(turned);

    const worldSize = nativeSize.clone().multiplyScalar(scale);
    const stand = new THREE.Group();
    stand.name = entry.name;
    stand.add(fit);
    // Placed by its own left edge so `x` is where the frontage starts, and pushed
    // back from the frontage line by half its depth so the FRONT lands on it.
    stand.position.set(x + worldSize.x / 2, 0, options.frontZ - worldSize.z / 2);
    stand.position.y = options.groundAt(stand.position.x, stand.position.z);
    this.group.add(stand);

    const report: TownReport = {
      name: entry.name,
      nativeSize,
      worldSize,
      scale,
      meshes,
      triangles: Math.round(triangles),
      materials: materials.size,
      textured: texture !== null,
      x: stand.position.x,
    };
    this.reports.push(report);
    return { object: stand, report };
  }

  /**
   * Lamps down the frontage, in front of the buildings.
   *
   * The model is loaded ONCE and cloned. A lamp is the only thing here that
   * repeats, and fourteen buildings plus eight separately-parsed copies of a 17 MB
   * Collada file is the difference between a scene that loads and one that does
   * not.
   */
  private async lampsAlong(options: TownOptions, frontage: number): Promise<void> {
    const entries = options.lamps ?? [];
    if (entries.length === 0) return;

    // The list is a repeating PATTERN, so the same model can appear in it more than
    // once to weight how often it comes round. Each distinct name is still parsed
    // exactly once.
    const byName = new Map<string, THREE.Object3D>();
    const templates: THREE.Object3D[] = [];
    for (const entry of entries) {
      let template = byName.get(entry.name);
      if (!template) {
        try {
          template = (await this.place(entry, options.startX, options)).object;
        } catch (error) {
          console.error(`[Town] ${entry.name} failed to load`, error);
          continue;
        }
        byName.set(entry.name, template);
      }
      templates.push(template);
    }
    if (templates.length === 0) return;

    const spacing = options.lampSpacing ?? 14;
    const offsetZ = options.lampOffsetZ ?? 5;
    const count = Math.max(templates.length, Math.floor(frontage / spacing));

    // Each model is parsed ONCE and cloned. The Victorian lamp alone is 17 MB of
    // Collada; ten separately-parsed copies is the difference between a scene that
    // loads and one that does not.
    const placedOriginal = new Set<THREE.Object3D>();
    for (let i = 0; i < count; i++) {
      const template = templates[i % templates.length]!;
      // The parsed original is moved into the first slot that wants it; every later
      // slot gets a clone. Cloning it before it has been used once would leave the
      // original sitting unplaced at the start of the street.
      const used = !placedOriginal.has(template);
      if (used) placedOriginal.add(template);
      const lamp = used ? template : template.clone(true);
      const x = options.startX + spacing * (i + 0.5);
      lamp.position.set(x, 0, options.frontZ + offsetZ);
      lamp.position.y = options.groundAt(x, lamp.position.z);
      // Alternate the facing, the way a real street alternates sides.
      lamp.rotation.y = i % 2 === 0 ? 0 : Math.PI;
      lamp.name = template.name + ':' + i;
      if (!used) this.group.add(lamp);
    }
  }

  /** One figure, standing on the pavement at the given frontage X. */
  private figureAt(x: number, options: TownOptions): THREE.Group {
    const figure = makeScaleFigure();
    const z = options.frontZ + 1.6;
    figure.position.set(x, options.groundAt(x, z), z);
    return figure;
  }

  setScaleFigures(on: boolean): void {
    this.figures.visible = on;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.group.removeFromParent();
  }
}

async function loadModel(url: string, format: TownModelFormat): Promise<THREE.Object3D> {
  if (format === 'fbx') return new FBXLoader().loadAsync(url);
  if (format === 'obj') return new OBJLoader().loadAsync(url);
  // ColladaLoader's types allow null even though it rejects rather than resolving
  // with one; a Collada that parses to nothing is a broken file, and saying so
  // here is better than a group that silently contributes no geometry.
  const collada = await new ColladaLoader().loadAsync(url);
  if (!collada?.scene) throw new Error(`${url}: Collada parsed to no scene`);
  return collada.scene;
}

const textureCache = new Map<string, Promise<THREE.Texture>>();

async function loadTexture(url: string): Promise<THREE.Texture> {
  let pending = textureCache.get(url);
  if (!pending) {
    pending = new THREE.TextureLoader().loadAsync(url).then((texture) => {
      // The map is albedo, so it is sRGB. Left in linear it comes out washed and
      // pale, which on a brick facade reads as fog rather than as a wrong flag.
      texture.colorSpace = THREE.SRGBColorSpace;
      // flipY is LEFT ALONE, i.e. three's default of true, and that is deliberate.
      // glTF is the format that wants it false — it defines UV origin at the top —
      // and every asset here is FBX, OBJ or Collada, all of which put V=0 at the
      // bottom like OpenGL. Forcing false on these samples the atlas mirrored:
      // window rows land on roofs, and a facade picks up the stripe of whatever
      // sits above it in the sheet.
      return texture;
    });
    textureCache.set(url, pending);
  }
  return pending;
}

/**
 * Put the asset's colour on, and take its gloss off.
 *
 * Same reasoning as `ModelStage.setTameGloss`: the renderer is `NoToneMapping`
 * (00 §5), so an exporter's default white specular under this scene's sun lands
 * several times over 1.0 and a roof turns into a white sheet. The buildings are
 * masonry — matte is also simply what they are.
 */
function dressMaterial(material: THREE.Material, texture: THREE.Texture | null): void {
  const m = material as THREE.MeshPhongMaterial & THREE.MeshStandardMaterial;

  if (texture) {
    m.map = texture;
    // An imported material often carries a dark or coloured base that was only
    // ever meant to tint a texture that is not here. With one on, white is the
    // only tint that shows the image as authored.
    m.color?.setHex(0xffffff);
  }
  if (m.specular) m.specular.setScalar(0.02);
  if (m.shininess !== undefined) m.shininess = 6;
  if (m.metalness !== undefined) m.metalness = 0;
  if (m.roughness !== undefined) m.roughness = 1;
  // Several of these ship double-sided or with alpha they do not use; both cost
  // fill rate and neither is wanted on a solid wall.
  m.side = THREE.FrontSide;
  m.needsUpdate = true;
}

function asArray(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

/** One line per building, for the on-screen report. */
export function formatTownReport(reports: readonly TownReport[]): string {
  if (reports.length === 0) return 'town        (nothing loaded)';
  const lines = reports.map((r) => {
    const size = `${r.worldSize.x.toFixed(1)} x ${r.worldSize.y.toFixed(1)} x ${r.worldSize.z.toFixed(1)}`;
    return `  ${r.name.padEnd(14)} ${size.padEnd(22)} at ${r.scale.toFixed(4)}x   ${r.triangles.toLocaleString()} tris${r.textured ? '' : '   (no texture)'}`;
  });
  const tris = reports.reduce((sum, r) => sum + r.triangles, 0);
  return [`town        ${reports.length} buildings, ${tris.toLocaleString()} triangles`, ...lines].join('\n');
}
