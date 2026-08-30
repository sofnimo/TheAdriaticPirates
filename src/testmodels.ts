import * as THREE from 'three';
import { Engine } from './app/Engine';
import { DebugUI } from './app/DebugUI';
import { FreeCamera } from './app/FreeCamera';
import {
  ModelTestScene,
  MODEL_VIEW_NAMES,
  ENVIRONMENT_NAMES,
  type ModelViewName,
  type EnvironmentName,
} from './dev/ModelTestScene';
import {
  MATERIAL_MODES,
  formatModelReport,
  type MaterialMode,
  type ModelLoadOptions,
} from './dev/ModelStage';
import { PostChain } from './render/post/PostChain';
import { POST } from './art/post';
import { TIME_OF_DAY_NAMES, type TimeOfDayName } from './art/timeOfDay';
import { globalUniforms } from './render/shading/ShadingUniforms';

/**
 * THE MODEL BENCH — `/testmodels`.
 *
 * A second entry point, not a `?scene=` on the first one. The world scene's job is to run
 * the step gates, and every one of those is a measurement against a fixed camera; this one
 * exists to be poked at, with an orbit camera, drag-and-drop and no gates at all. Sharing
 * an entry would mean either the gates run while you are dragging models around, or they
 * get conditionalised until they no longer run at all.
 *
 * Getting a model in, in order of how quickly you want it:
 *   1. Drop the file (or the whole export folder) anywhere on the window.
 *   2. Put .glb / .gltf files in `src/models/` — they appear in the "file" dropdown, and
 *      adding one shows up on the next reload.
 *   3. `?model=<name>` loads one of those on boot, so a framing is linkable.
 *
 * Query params: `?model=`, `?view=`, `?material=`, `?env=`, `?post=0`.
 */

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
if (!canvas) throw new Error('#viewport canvas not found');

const ui = document.querySelector<HTMLDivElement>('#ui');
if (!ui) throw new Error('#ui container not found');

const query = new URLSearchParams(window.location.search);

/**
 * Models living in `src/models/` are bundled as URLs rather than fetched from `public/`,
 * so an unresolvable one is a build error instead of a 404 at the moment you wanted to
 * look at it. Non-eager: a folder of assets should not all download on boot.
 */
const MODEL_MODULES = import.meta.glob('./models/*.{glb,gltf,fbx,obj}', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const MODEL_FILES = Object.keys(MODEL_MODULES)
  .map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Per-asset sidecars: `Foo.fbx` is configured by `Foo.parts.json` sitting beside it.
 *
 * Eager, because these are a few hundred bytes each and the hide list has to be in hand
 * BEFORE the model is fitted — fetching it afterwards means the asset visibly resizes a
 * moment after it lands.
 *
 * A sidecar rather than a hardcoded table because the fact it records — "this asset ships a
 * diorama and only these parts are the subject" — belongs to the asset, not to the bench.
 * The next model will bundle a different showroom.
 */
interface PartsSidecar {
  hide?: string[];
  note?: string;
}

const SIDECARS = import.meta.glob('./models/*.parts.json', { eager: true, import: 'default' }) as Record<
  string,
  PartsSidecar
>;

/** `./models/Porcorosso.fbx` -> the contents of `./models/Porcorosso.parts.json`, if any. */
function sidecarFor(modelPath: string): ModelLoadOptions {
  const sidecar = SIDECARS[modelPath.replace(/\.[^./]+$/, '.parts.json')];
  return sidecar?.hide ? { hide: sidecar.hide } : {};
}

const engine = new Engine({ canvas });
const debug = new DebugUI(document.body, 'Adriatic — model bench');
const scene = new ModelTestScene(canvas);

engine.setScene(scene.scene, scene.camera);
engine.setDevOverlay(scene.devOverlay);
// The grid, the axes and the scale rod are measuring tools, not world content: they are
// only useful if they are visible, including where they pass behind the model. Without
// this they are rejected by the depth the post chain's final blit leaves on the canvas.
engine.setDevOverlayOnTop(true);

const post = new PostChain({
  renderer: engine.renderer,
  scene: scene.scene,
  camera: scene.camera,
  onSceneStats: (calls, triangles) => engine.tapSceneStats(calls, triangles),
});
post.enabled = query.get('post') !== '0';
engine.setPostChain(post);

// The bench's free camera is the same one the world scene flies, on the same key. Orbit is
// the right default for looking AT a model; flying is the right way to find out whether it
// reads from somewhere you did not choose in advance.
const freeCam = new FreeCamera(scene.camera, canvas, { speed: 60 });

// --- panels -----------------------------------------------------------------------------
const reportEl = document.createElement('pre');
reportEl.className = 'gate-report';
ui.appendChild(reportEl);

const camHud = document.createElement('div');
camHud.className = 'freecam-hud';
camHud.style.display = 'none';
ui.appendChild(camHud);

const dropHint = document.createElement('div');
dropHint.className = 'drop-hint';
dropHint.textContent = 'drop a .glb / .gltf / .fbx / .obj — or a whole export folder';
ui.appendChild(dropHint);

const toast = document.createElement('div');
toast.className = 'bench-toast';
toast.style.display = 'none';
ui.appendChild(toast);

function say(message: string, isError = false): void {
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.style.display = '';
  if (!isError) window.setTimeout(() => (toast.style.display = 'none'), 2600);
}

function paintReport(): void {
  const stage = scene.stage;
  const lines = [
    'view: ' + params.view + '   material: ' + stage.material,
    '',
    formatModelReport(stage.report),
  ];
  reportEl.textContent = lines.join('\n');
}

// --- loading ----------------------------------------------------------------------------
let loading = false;

async function loadFromFolder(path: string): Promise<void> {
  const loader = MODEL_MODULES[path];
  if (!loader) return;
  await guard(async () => {
    const url = await loader();
    const report = await scene.stage.loadUrl(url, path.slice(path.lastIndexOf('/') + 1), sidecarFor(path));
    say('loaded ' + report.name);
  });
}

async function loadFromFiles(files: readonly File[]): Promise<void> {
  await guard(async () => {
    // A dropped file gets the sidecar of the same name if this repo happens to carry one,
    // so dragging in a fresh copy of a known asset behaves like picking it from the list.
    const root = files.find((f) => /\.(glb|gltf|fbx|obj)$/i.test(f.name));
    const report = await scene.stage.loadFiles(files, root ? sidecarFor('./models/' + root.name) : {});
    say('loaded ' + report.name);
  });
}

/**
 * One place that owns "a load is in flight".
 *
 * Loads are async and the stage holds exactly one model, so two overlapping loads race to
 * install into the same slot and the loser leaks its geometry. Refusing the second is both
 * simpler and more honest than queueing it.
 */
async function guard(work: () => Promise<void>): Promise<void> {
  if (loading) {
    say('a model is still loading', true);
    return;
  }
  loading = true;
  dropHint.classList.add('is-busy');
  try {
    await work();
    // Every framing is derived from the model's measured size, so the view has to be
    // recomputed after the load, not before it.
    scene.reframe();
    syncStageControllers();
    syncClipController();
    syncPartsFolder();
  } catch (error) {
    console.error(error);
    say('load failed: ' + (error instanceof Error ? error.message : String(error)), true);
  } finally {
    loading = false;
    dropHint.classList.remove('is-busy');
    paintReport();
  }
}

// --- drag and drop ----------------------------------------------------------------------
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropHint.classList.add('is-over');
});
window.addEventListener('dragleave', () => dropHint.classList.remove('is-over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropHint.classList.remove('is-over');
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length > 0) void loadFromFiles(files);
});

const picker = document.createElement('input');
picker.type = 'file';
picker.multiple = true;
picker.accept = '.glb,.gltf,.fbx,.obj,.bin,.png,.jpg,.jpeg,.webp';
picker.style.display = 'none';
document.body.appendChild(picker);
picker.addEventListener('change', () => {
  const files = Array.from(picker.files ?? []);
  if (files.length > 0) void loadFromFiles(files);
  picker.value = '';
});

// --- controls ---------------------------------------------------------------------------
const isView = (v: string | null): v is ModelViewName =>
  v !== null && (MODEL_VIEW_NAMES as readonly string[]).includes(v);
const isMaterial = (v: string | null): v is MaterialMode =>
  v !== null && (MATERIAL_MODES as readonly string[]).includes(v);
const isEnvironment = (v: string | null): v is EnvironmentName =>
  v !== null && (ENVIRONMENT_NAMES as readonly string[]).includes(v);

const params = {
  file: MODEL_FILES[0]?.path ?? '',
  browse: () => picker.click(),
  clip: 'none',
  clear: () => {
    scene.stage.clear();
    paintReport();
    say('stage cleared');
  },
  view: (isView(query.get('view')) ? query.get('view') : 'threequarter') as ModelViewName,
  material: (isMaterial(query.get('material')) ? query.get('material') : 'original') as MaterialMode,
  timeOfDay: 'lateMorning' as TimeOfDayName,
  environment: (isEnvironment(query.get('env')) ? query.get('env') : 'sea') as EnvironmentName,
  autoFit: true,
  targetSize: 12,
  scale: 1,
  altitude: 0,
  yaw: 0,
  spin: 0,
  wireframe: false,
  shadows: true,
  tameGloss: true,
  fill: true,
  exposure: 0.35,
  grid: true,
  rod: true,
  bounds: false,
  post: post.enabled,
  fly: false,
};

const modelFolder = debug.gui.addFolder('Model');
if (MODEL_FILES.length > 0) {
  const options: Record<string, string> = {};
  for (const file of MODEL_FILES) options[file.name] = file.path;
  modelFolder
    .add(params, 'file', options)
    .name('src/models/')
    .onChange((v: string) => void loadFromFolder(v));
} else {
  // An empty dropdown reads as a broken control; a disabled row that says why does not.
  modelFolder.add({ hint: 'src/models/ is empty' }, 'hint').name('src/models/').disable();
}
modelFolder.add(params, 'browse').name('browse files...');
modelFolder.add(params, 'clear').name('clear stage');
modelFolder
  .add(params, 'material', MATERIAL_MODES as unknown as string[])
  .name('shading')
  .onChange((v: MaterialMode) => {
    scene.stage.setMaterialMode(v);
    paintReport();
  });
modelFolder.add(params, 'wireframe').onChange((v: boolean) => scene.stage.setWireframe(v));
modelFolder.add(params, 'shadows').onChange((v: boolean) => scene.stage.setShadows(v));
modelFolder
  .add(params, 'tameGloss')
  .name('tame gloss (original only)')
  .onChange((v: boolean) => scene.stage.setTameGloss(v));
modelFolder
  .add(params, 'fill')
  .name('PBR fill (original only)')
  .onChange((v: boolean) => scene.setFillVisible(v));
modelFolder
  .add(params, 'exposure', 0.05, 1.5, 0.01)
  .name('exposure (original only)')
  .onChange((v: number) => scene.setOriginalExposure(v));
// Rebuilt per model: the option list IS the asset's clip list, so it cannot be authored up
// front. Hidden entirely for the (common) asset that ships none.
let clipCtrl = modelFolder
  .add(params, 'clip', ['none'])
  .name('animation')
  .onChange((v: string) => scene.stage.playClip(v === 'none' ? null : v));
clipCtrl.hide();
modelFolder.open();

const partsFolder = debug.gui.addFolder('Parts');
partsFolder.hide();

const fitFolder = debug.gui.addFolder('Placement');
const autoFitCtrl = fitFolder
  .add(params, 'autoFit')
  .name('auto-fit longest axis')
  .onChange((v: boolean) => {
    scene.stage.setAutoFit(v);
    afterTransform();
  });
const targetCtrl = fitFolder
  .add(params, 'targetSize', 0.5, 120, 0.5)
  .name('fit to (m)')
  .onChange((v: number) => {
    scene.stage.setTargetSize(v);
    afterTransform();
  });
const scaleCtrl = fitFolder
  .add(params, 'scale', 0.001, 50, 0.001)
  .name('scale x')
  .onChange((v: number) => {
    scene.stage.setScaleMultiplier(v);
    afterTransform();
  });
fitFolder
  .add(params, 'altitude', 0, 1500, 1)
  .name('altitude (m)')
  .onChange((v: number) => scene.stage.setAltitude(v));
fitFolder
  .add(params, 'yaw', -180, 180, 1)
  .name('yaw (deg)')
  .onChange((v: number) => scene.stage.setYaw(v));
fitFolder
  .add(params, 'spin', 0, 90, 1)
  .name('turntable (deg/s)')
  .onChange((v: number) => {
    scene.stage.spin = v;
  });
fitFolder.open();

const viewFolder = debug.gui.addFolder('View');
const viewCtrl = viewFolder
  .add(params, 'view', MODEL_VIEW_NAMES as unknown as string[])
  .name('framing')
  .onChange((v: ModelViewName) => setView(v));
viewFolder
  .add(params, 'timeOfDay', TIME_OF_DAY_NAMES as unknown as string[])
  .name('time of day')
  .onChange((v: TimeOfDayName) => {
    scene.setTimeOfDay(v);
    // The backlit framing is defined relative to the sun, so moving the sun has to move it.
    if (params.view === 'silhouette') setView('silhouette');
  });
viewFolder
  .add(params, 'environment', ENVIRONMENT_NAMES as unknown as string[])
  .name('ground')
  .onChange((v: EnvironmentName) => scene.setEnvironment(v));
viewFolder.add(params, 'grid').name('grid + axes').onChange((v: boolean) => scene.setGridVisible(v));
viewFolder.add(params, 'rod').name('10 m scale rod').onChange((v: boolean) => scene.setRodVisible(v));
viewFolder.add(params, 'bounds').name('bounding box').onChange((v: boolean) => scene.setBoundsVisible(v));
viewFolder.open();

const postFolder = debug.gui.addFolder('Post chain (04 §7)');
const postParams = {
  enabled: post.enabled,
  bloomThreshold: POST.bloom.threshold,
  bloomStrength: POST.bloom.strength,
  grainStrength: post.values.grainStrength,
  vignetteCorner: post.values.vignetteCorner,
};
postFolder.add(postParams, 'enabled').name('post chain').onChange((v: boolean) => {
  post.enabled = v;
});
postFolder
  .add(postParams, 'bloomThreshold', 0.2, 1.0, 0.01)
  .name('bloom threshold')
  .onChange((v: number) => post.setBloom(v, postParams.bloomStrength, POST.bloom.radius));
postFolder
  .add(postParams, 'bloomStrength', 0, 1.5, 0.01)
  .name('bloom strength')
  .onChange((v: number) => post.setBloom(postParams.bloomThreshold, v, POST.bloom.radius));
postFolder
  .add(postParams, 'grainStrength', 0, 0.15, 0.001)
  .name('grain')
  .onChange((v: number) => post.setGrainStrength(v));
postFolder
  .add(postParams, 'vignetteCorner', 0, 0.35, 0.005)
  .name('vignette corner')
  .onChange((v: number) => post.setVignetteCorner(v));

const camFolder = debug.gui.addFolder('Free camera');
const flyCtrl = camFolder
  .add(params, 'fly')
  .name('fly (F)')
  .onChange((v: boolean) => setView(v ? 'free' : 'threequarter'));
camFolder.add({ speed: freeCam.currentSpeed }, 'speed', 2, 400, 1).name('speed (m/s)').onChange((v: number) => freeCam.setSpeed(v));

/**
 * The one place the view changes.
 *
 * Orbit and free-fly are two answers to the same question — where is the camera — so they
 * are one setting here rather than two. Letting them be toggled independently is how you
 * get an orbit control quietly fighting the free camera for the same mouse drag.
 */
function setView(v: ModelViewName): void {
  params.view = v;
  if (v === 'free') {
    scene.controls.enabled = false;
    freeCam.readPoseFromCamera();
    freeCam.enable();
    camHud.style.display = '';
    paintCamHud();
  } else {
    freeCam.disable();
    camHud.style.display = 'none';
  }
  scene.setView(v);
  params.fly = v === 'free';
  flyCtrl.updateDisplay();
  viewCtrl.updateDisplay();
  paintReport();
}

function paintCamHud(): void {
  camHud.textContent =
    freeCam.status() +
    '\n WASD / arrows fly  ·  Q E or space C up-down  ·  shift boost  ·  alt crawl' +
    '\n drag or click to look  ·  wheel sets speed  ·  esc releases the mouse';
}

freeCam.onMove(paintCamHud);

/**
 * Rebuild the parts list around the loaded asset.
 *
 * Assets bundle furniture — display bases, pedestals, backdrops — into the same file as the
 * subject, and that furniture lands in the bounding box and walks off with the auto-fit.
 * Switching a part off re-fits on what is left, so the reported size is always the size of
 * what you can actually see.
 */
function syncPartsFolder(): void {
  partsFolder.children.slice().forEach((c) => c.destroy());
  const parts = scene.stage.parts;
  if (parts.length === 0) {
    partsFolder.hide();
    return;
  }
  partsFolder.show();
  for (const part of parts) {
    const state = { on: part.object.visible };
    partsFolder
      .add(state, 'on')
      .name(part.name + '  (' + part.triangles.toLocaleString() + ')')
      .onChange((v: boolean) => {
        scene.stage.setPartVisible(part, v);
        afterTransform();
        syncStageControllers();
      });
  }
}

/** Rebuild the clip dropdown around whatever the newly loaded asset actually shipped. */
function syncClipController(): void {
  const names = scene.stage.clips.map((c) => c.name || '(unnamed)');
  params.clip = 'none';
  clipCtrl.destroy();
  clipCtrl = modelFolder
    .add(params, 'clip', ['none', ...names])
    .name('animation')
    .onChange((v: string) => scene.stage.playClip(v === 'none' ? null : v));
  if (names.length === 0) clipCtrl.hide();
}

/** Pull the panel back in line with the stage after a load or a fit change. */
function syncStageControllers(): void {
  const report = scene.stage.report;
  if (!report) return;
  params.autoFit = scene.stage.autoFit;
  params.targetSize = scene.stage.targetSize;
  params.scale = scene.stage.scaleMultiplier;
  autoFitCtrl.updateDisplay();
  targetCtrl.updateDisplay();
  scaleCtrl.updateDisplay();
}

function afterTransform(): void {
  // Framing distances are a multiple of the model's size, so a resize has to re-frame or
  // the model walks out of shot the moment you scale it.
  scene.reframe();
  paintReport();
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  setView(params.view === 'free' ? 'threequarter' : 'free');
});

engine.onResize((w, h) => scene.resize(w / h));

engine.onFrame((ctx) => {
  freeCam.update(ctx.dt);
  scene.update(ctx.dt);
  debug.beginFrame();
  debug.updateBudgetHud(engine.stats.world, engine.stats.dev, engine.stats.post);
  debug.endFrame();
});

// --- boot -------------------------------------------------------------------------------
scene.setTimeOfDay(params.timeOfDay);
scene.setEnvironment(params.environment);
scene.stage.setMaterialMode(params.material);
scene.setGridVisible(params.grid);
scene.setRodVisible(params.rod);
engine.start();
setView(params.view);
paintReport();

const requested = query.get('model');
if (requested) {
  const match = MODEL_FILES.find((f) => f.name === requested || f.path.endsWith('/' + requested));
  if (match) {
    params.file = match.path;
    void loadFromFolder(match.path);
  } else {
    say('?model=' + requested + ' is not in src/models/', true);
  }
}

Object.assign(window as unknown as Record<string, unknown>, { engine, scene, THREE, globalUniforms });
