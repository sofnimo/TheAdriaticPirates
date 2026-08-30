import * as THREE from 'three';
import { Engine } from './app/Engine';
import { DebugUI } from './app/DebugUI';
import { FreeCamera } from './app/FreeCamera';
import { GrassWorldScene, GRASS_VIEW_NAMES, type GrassViewName } from './dev/GrassWorldScene';
import { MATERIAL_MODES, formatModelReport, type MaterialMode } from './dev/ModelStage';
import { TOON_DEFAULT_STEPS, TOON_MAX_STEPS, TOON_MIN_STEPS } from './dev/toonShading';
import { GRASS_PRESETS } from './vendor/grassField/presets';
import { SEA_STATE_NAMES, type SeaStateName } from './art/seaStates';

/**
 * The aircraft comes from `src/models/`, the same folder the model bench globs,
 * so there is exactly one copy of a 9.5 MB binary in the tree rather than a second
 * one under `public/`.
 */
const PLANE_URL = import.meta.glob('./models/Porcorosso.fbx', {
  query: '?url',
  import: 'default',
})['./models/Porcorosso.fbx'] as (() => Promise<string>) | undefined;

/**
 * THE GRASS WORLD — `/grassworld`.
 *
 * The stylized-grass scene from `stylized-components` (Christian Ortiz, MIT),
 * ported out of React-Three-Fiber into this project's plain three.js runtime:
 * eight tiles of it, a four-tile strip of this project's own sea alongside, and
 * the Savoia sitting on the water.
 *
 * Its own entry point rather than a mode on `/testmodels`, for the same reason
 * the bench is not a mode on `/`: this scene runs a completely different lighting
 * model from the rest of the project (Lambert + ambient, versus the gouache chunk
 * that discards three's lighting outright), and folding the two into one page
 * would mean every control on it needing to know which world it was talking to.
 *
 * Query params: `?view=`, `?preset=`, `?sea=`, `?post=0` (post is off by default —
 * see the note where the chain would have gone).
 */

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
if (!canvas) throw new Error('#viewport canvas not found');

const ui = document.querySelector<HTMLDivElement>('#ui');
if (!ui) throw new Error('#ui container not found');

const query = new URLSearchParams(window.location.search);

const engine = new Engine({ canvas });
const debug = new DebugUI(document.body, 'Adriatic — grass world');
const scene = new GrassWorldScene(canvas);

// PCFSoft rather than the project's contract PCFShadowMap: blades and flower stems
// are thinner than a shadow-map texel, so a hard filter renders their shadows as
// stair-stepped streaks. The wider kernel dissolves the texel edges — and a soft
// shadow is the look this scene was authored with. It is a deliberate departure
// from 04 §8.1, confined to this page.
engine.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
scene.attachRenderer(engine.renderer);

engine.setScene(scene.scene, scene.camera);
engine.setDevOverlay(scene.devOverlay);
engine.setDevOverlayOnTop(true);

// NO POST CHAIN. 04 §7.1's grade is built around the sea-and-sky palette and a
// NoToneMapping pipeline; this scene is a borrowed one with its own colour
// balance, and running our bloom over its white clouds crushes them. The renderer
// contract (NoToneMapping, sRGB out) still applies — only the grade is skipped.

const freeCam = new FreeCamera(scene.camera, canvas, { speed: 12, maxAltitude: 400 });

// --- panels -----------------------------------------------------------------------------
const reportEl = document.createElement('pre');
reportEl.className = 'gate-report';
ui.appendChild(reportEl);

const camHud = document.createElement('div');
camHud.className = 'freecam-hud';
camHud.style.display = 'none';
ui.appendChild(camHud);

const toast = document.createElement('div');
toast.className = 'bench-toast';
toast.textContent = 'loading grass-scene.glb …';
ui.appendChild(toast);

function say(message: string, isError = false): void {
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.style.display = '';
  if (!isError) window.setTimeout(() => (toast.style.display = 'none'), 2600);
}

function paintReport(): void {
  if (!scene.field) return;
  const s = scene.field.stats;
  const size = s.bounds.getSize(new THREE.Vector3());
  const water = scene.waterBounds.getSize(new THREE.Vector3());
  reportEl.textContent = [
    'view: ' + params.view + '   season: ' + params.preset +
      '   shading: ' + (params.toon ? 'toon x' + params.toonSteps : 'lit'),
    '',
    'land        ' + size.x.toFixed(1) + ' x ' + size.z.toFixed(1) + ' m  (8 tiles of ' + s.tileSize.x.toFixed(1) + ' m)',
    'water       ' + water.x.toFixed(1) + ' x ' + water.z.toFixed(1) + ' m  (4 tiles)',
    'generated   ' + s.trees + ' trees from ' + s.treePrototypes + ' shapes, ' + s.rocks + ' rocks from ' + s.rockPrototypes,
    'scattered   ' + s.blades.toLocaleString() + ' blades   ' + s.flowers.toLocaleString() + ' flowers   ' + s.patches + ' patches',
    'sea level   ' + scene.waterLevel.toFixed(2) + ' m   depth ramp x' + scene.depthExaggeration,
    '',
    formatModelReport(scene.stage?.report ?? null),
  ].join('\n');
}

// --- controls ---------------------------------------------------------------------------
const isView = (v: string | null): v is GrassViewName =>
  v !== null && (GRASS_VIEW_NAMES as readonly string[]).includes(v);

const params = {
  view: (isView(query.get('view')) ? query.get('view') : 'establishing') as GrassViewName,
  preset: query.get('preset') && GRASS_PRESETS[query.get('preset')!] ? query.get('preset')! : 'default',
  seaState: (query.get('sea') as SeaStateName | null) ?? 'breeze',
  material: 'original' as MaterialMode,
  toon: query.get('toon') === '1',
  toonSteps: TOON_DEFAULT_STEPS,
  wireframe: false,
  windStrength: 0.1,
  windSpeed: 1.3,
  windDir: 243,
  brightness: 0.8,
  ambientIntensity: scene.lighting.ambientIntensity,
  dirIntensity: scene.lighting.dirIntensity,
  dirX: scene.lighting.dirX,
  dirY: scene.lighting.dirY,
  dirZ: scene.lighting.dirZ,
  staticShadows: true,
  shadowStrength: 0.35,
  rebake: () => scene.bakeShadows(),
  planeAltitude: 0,
  planeYaw: 0,
  planeSpin: 0,
  water: true,
  depthExaggeration: 30,
  grid: false,
  shadowHelper: false,
  fly: false,
};

// First folder in the panel on purpose: this is the one control that changes
// every surface at once, so it belongs above the per-thing tuning below it.
const toonFolder = debug.gui.addFolder('Toon shading');
toonFolder
  .add(params, 'toon')
  .name('toon everything')
  .onChange((v: boolean) => {
    scene.setToonShading(v);
    paintReport();
  });
toonFolder
  .add(params, 'toonSteps', TOON_MIN_STEPS, TOON_MAX_STEPS, 1)
  .name('bands')
  .onChange((v: number) => {
    scene.setToonSteps(v);
    paintReport();
  });
toonFolder.open();

const fieldFolder = debug.gui.addFolder('Grass field');
fieldFolder
  .add(params, 'preset', Object.keys(GRASS_PRESETS))
  .name('season')
  .onChange((v: string) => {
    scene.field.applyPreset(v);
    // The preset writes straight into the params bag, so the panel's own copies of
    // the values it touched are now stale.
    syncFieldControllers();
    paintReport();
  });
const brightnessCtrl = fieldFolder
  .add(params, 'brightness', 0, 2, 0.01)
  .name('grass brightness')
  .onChange((v: number) => {
    scene.field.params.grBrightness = v;
  });
const windStrengthCtrl = fieldFolder
  .add(params, 'windStrength', 0, 1, 0.005)
  .name('wind strength')
  .onChange((v: number) => {
    scene.field.params.grWindStrength = v;
  });
const windSpeedCtrl = fieldFolder
  .add(params, 'windSpeed', 0, 4, 0.05)
  .name('wind speed')
  .onChange((v: number) => {
    scene.field.params.grWindSpeed = v;
  });
fieldFolder
  .add(params, 'windDir', 0, 360, 1)
  .name('wind direction')
  .onChange((v: number) => {
    scene.field.params.grWindDir = v;
  });
fieldFolder
  .add(params, 'shadowStrength', 0, 1, 0.01)
  .name('shadow strength')
  .onChange((v: number) => {
    scene.field.params.grShadowStrength = v;
  });
fieldFolder.add(params, 'wireframe').onChange((v: boolean) => scene.field.setWireframe(v));
fieldFolder.open();

const lightFolder = debug.gui.addFolder('Lighting');
lightFolder
  .add(params, 'ambientIntensity', 0, 5, 0.05)
  .name('ambient')
  .onChange((v: number) => {
    scene.lighting.ambientIntensity = v;
    scene.applyLighting();
  });
lightFolder
  .add(params, 'dirIntensity', 0, 10, 0.1)
  .name('sun')
  .onChange((v: number) => {
    scene.lighting.dirIntensity = v;
    scene.applyLighting();
  });
for (const axis of ['dirX', 'dirY', 'dirZ'] as const) {
  lightFolder
    .add(params, axis, -200, 200, 0.5)
    .name('sun ' + axis.slice(3))
    .onChange((v: number) => {
      scene.lighting[axis] = v;
      scene.applyLighting();
    });
}
lightFolder
  .add(params, 'staticShadows')
  .name('freeze shadow map')
  .onChange((v: boolean) => scene.setStaticShadows(v));
lightFolder.add(params, 'rebake').name('re-bake shadows');
lightFolder.add(params, 'shadowHelper').name('shadow frustum').onChange((v: boolean) => scene.setShadowHelperVisible(v));

const planeFolder = debug.gui.addFolder('Aircraft');
planeFolder
  .add(params, 'material', MATERIAL_MODES as unknown as string[])
  .name('shading')
  .onChange((v: MaterialMode) => {
    scene.stage.setMaterialMode(v);
    paintReport();
  });
planeFolder
  .add(params, 'planeAltitude', -2, 60, 0.1)
  .name('altitude (m)')
  .onChange((v: number) => scene.stage.setAltitude(scene.waterLevel + v));
planeFolder
  .add(params, 'planeYaw', -180, 180, 1)
  .name('yaw (deg)')
  .onChange((v: number) => scene.stage.setYaw(v));
planeFolder
  .add(params, 'planeSpin', 0, 90, 1)
  .name('turntable (deg/s)')
  .onChange((v: number) => {
    scene.stage.spin = v;
  });

const viewFolder = debug.gui.addFolder('View');
const viewCtrl = viewFolder
  .add(params, 'view', GRASS_VIEW_NAMES as unknown as string[])
  .name('framing')
  .onChange((v: GrassViewName) => setView(v));
viewFolder
  .add(params, 'seaState', SEA_STATE_NAMES as unknown as string[])
  .name('sea state')
  .onChange((v: SeaStateName) => scene.ocean.applySeaState(v));
viewFolder.add(params, 'water').name('water').onChange((v: boolean) => scene.setWaterVisible(v));
viewFolder
  .add(params, 'depthExaggeration', 1, 60, 1)
  .name('sea depth x (1 = literal)')
  // Re-bakes a 512x512 distance transform, so it hitches. At 1 the pond is
  // rendered at its true fifteen metres and goes flat and pale — which is the
  // ramp being right, not wrong. See GrassWorldScene.setDepthExaggeration.
  .onFinishChange((v: number) => {
    scene.setDepthExaggeration(v);
    paintReport();
  });
viewFolder.add(params, 'grid').name('grid').onChange((v: boolean) => scene.setGridVisible(v));
viewFolder.open();

const camFolder = debug.gui.addFolder('Free camera');
const flyCtrl = camFolder
  .add(params, 'fly')
  .name('fly (F)')
  .onChange((v: boolean) => setView(v ? 'free' : 'establishing'));
camFolder.add({ speed: freeCam.currentSpeed }, 'speed', 1, 120, 1).name('speed (m/s)').onChange((v: number) => freeCam.setSpeed(v));

/** Pull the panel's own copies back in line after a preset writes into the field. */
function syncFieldControllers(): void {
  const p = scene.field.params;
  params.brightness = p.grBrightness;
  params.windStrength = p.grWindStrength;
  params.windSpeed = p.grWindSpeed;
  brightnessCtrl.updateDisplay();
  windStrengthCtrl.updateDisplay();
  windSpeedCtrl.updateDisplay();
}

/** The one place the view changes — orbit and free-fly are one setting. */
function setView(v: GrassViewName): void {
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

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  setView(params.view === 'free' ? 'establishing' : 'free');
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
void (async () => {
  try {
    await scene.load(params.seaState);
  } catch (error) {
    console.error(error);
    say('failed to build the scene: ' + (error instanceof Error ? error.message : String(error)), true);
    return;
  }

  if (params.preset !== 'default') scene.field.applyPreset(params.preset);
  scene.setToonSteps(params.toonSteps);
  scene.setToonShading(params.toon);
  syncFieldControllers();
  scene.setStaticShadows(params.staticShadows);
  engine.start();
  setView(params.view);
  say(
    'generated ' + scene.field.stats.trees + ' trees, ' + scene.field.stats.rocks + ' rocks, ' +
    scene.field.stats.blades.toLocaleString() + ' blades',
  );

  // The aircraft last: it is the smallest part of the scene and the slowest to
  // parse, and nothing else waits on it.
  try {
    if (!PLANE_URL) throw new Error('src/models/Porcorosso.fbx is missing — see src/models/README.md');
    const report = await scene.stage.loadUrl(await PLANE_URL(), 'Porcorosso.fbx', {
      // The same four scenery parts the bench's sidecar hides. Named here rather
      // than read from the sidecar because this page loads exactly one asset and
      // does not carry the bench's model-picking machinery.
      hide: ['Plane', 'boards', 'barrels', 'COPY_cabin'],
    });
    scene.stage.setMaterialMode(params.material);
    scene.stage.setAltitude(scene.waterLevel + params.planeAltitude);
    scene.reframe();
    say('loaded ' + report.name);
  } catch (error) {
    console.error(error);
    say('aircraft failed to load: ' + (error instanceof Error ? error.message : String(error)), true);
  }
  paintReport();
})();

Object.assign(window as unknown as Record<string, unknown>, { engine, scene, THREE });
