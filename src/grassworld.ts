import * as THREE from 'three';
import { Engine } from './app/Engine';
import { DebugUI } from './app/DebugUI';
import { FreeCamera } from './app/FreeCamera';
import {
  GrassWorldScene,
  GRASS_VIEW_NAMES,
  TOWN_BUILDINGS,
  TOWN_LAMPS,
  type GrassViewName,
} from './dev/GrassWorldScene';
import { MATERIAL_MODES, formatModelReport, type MaterialMode } from './dev/ModelStage';
import { sidecarFor } from './dev/modelSidecar';
import { TOON_DEFAULT_STEPS, TOON_MAX_STEPS, TOON_MIN_STEPS } from './dev/toonShading';
import { BIRD_DEFAULT_FLAP_RATE } from './dev/grass/Birds';
import { formatTownReport } from './dev/grass/Town';
import { GRASS_PRESETS } from './vendor/grassField/presets';
import { DEFAULT_SEA_STATE, SEA_STATE_NAMES, type SeaStateName } from './art/seaStates';

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
 * The town's fourteen assets, globbed as URLs rather than listed.
 *
 * Three formats and two texture extensions, so the glob is by extension and the
 * lookup is by stem — `TOWN_BUILDINGS` names `nivelles1` and this finds whichever
 * of `nivelles1.fbx` / `.obj` / `.dae` is actually on disk. A manifest that also
 * had to carry file extensions would be one more thing to keep in sync with a
 * folder that is gitignored and re-populated by hand.
 */
const TOWN_FILES = import.meta.glob('./models/town/*.{fbx,obj,dae,png,jpeg,jpg}', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const MODEL_EXT = ['fbx', 'obj', 'dae'];
const TEXTURE_EXT = ['png', 'jpeg', 'jpg'];

/** Resolve `nivelles1` + 'model' to the loader for `./models/town/nivelles1.fbx`. */
function townFile(name: string, kind: 'model' | 'texture'): (() => Promise<string>) | undefined {
  for (const ext of kind === 'model' ? MODEL_EXT : TEXTURE_EXT) {
    const loader = TOWN_FILES['./models/town/' + name + '.' + ext];
    if (loader) return loader;
  }
  return undefined;
}

/** Same deal for the birds — `bird.fbx`, five rigged gulls in one 330 kB file. */
const BIRD_URL = import.meta.glob('./models/bird.fbx', {
  query: '?url',
  import: 'default',
})['./models/bird.fbx'] as (() => Promise<string>) | undefined;

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
    'maquis      ' + s.maquis + ' evergreen scrub stands',
    'shrubs      ' + s.shrubs + ' generated, ' + (s.shrubs * 320).toLocaleString() + ' independent leaves',
    'scattered   ' + s.blades.toLocaleString() + ' blades   ' + s.flowers.toLocaleString() + ' flowers   ' + s.patches + ' patches',
    'sea level   ' + scene.waterLevel.toFixed(2) + ' m   depth ramp x' + scene.depthExaggeration,
    '',
    formatTownReport(scene.town?.reports ?? []),
    '',
    formatModelReport(scene.stage?.report ?? null),
  ].join('\n');
}

// --- controls ---------------------------------------------------------------------------
const isView = (v: string | null): v is GrassViewName =>
  v !== null && (GRASS_VIEW_NAMES as readonly string[]).includes(v);

/** `?sea=` if it names a real sea state, otherwise the project's default. */
const readSeaState = (v: string | null): SeaStateName =>
  v !== null && (SEA_STATE_NAMES as readonly string[]).includes(v)
    ? (v as SeaStateName)
    : DEFAULT_SEA_STATE;

const params = {
  view: (isView(query.get('view')) ? query.get('view') : 'establishing') as GrassViewName,
  preset: query.get('preset') && GRASS_PRESETS[query.get('preset')!] ? query.get('preset')! : 'default',
  // VALIDATED, not cast. This read `(query.get('sea') as SeaStateName) ?? 'breeze'`, and both
  // halves of that were broken. `breeze` is not a sea state — `SEA_STATES` has only flat,
  // wavey and choppy — so every visit without an explicit `?sea=` handed `Ocean` a name it
  // could not look up and died on `SEA_STATES[seaState].glintCoverage` before the first frame.
  // The cast is what let it through: it asserts the string is a valid name rather than
  // checking, so `?sea=anything` failed the same way.
  //
  // Now it is checked against the real list and falls back to the project's own default, so a
  // typo in the URL loads the world instead of a blank page.
  seaState: readSeaState(query.get('sea')),
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
  // `?town=0` runs the grass world as it was before the village arrived. Not just
  // hidden — the fourteen town assets are never fetched, which is most of the
  // page's load. Both worlds stay in the build; the URL picks one.
  town: query.get('town') !== '0',
  scaleFigures: true,
  birds: true,
  birdWingspan: 1.3,
  birdSpeed: 1,
  birdFlap: BIRD_DEFAULT_FLAP_RATE,
  planeAltitude: 0,
  planeYaw: 0,
  planeSpin: 0,
  propRpm: 240,
  water: true,
  skirt: true,
  skirtDepth: 4,
  depthExaggeration: 30,
  grid: false,
  shadowHelper: false,
  fly: false,
};

// THE WAY BACK. The main page lists this world in its scene dropdown, so this one carries the
// same control pointing the other way — otherwise arriving here is a one-way trip and the
// only exit is editing the URL. The three on the far side are `?scene=` branches of index.html
// while this is its own entry point (see the header), so leaving means changing PAGE, which is
// why this is a navigation rather than a mode switch.
const sceneFolder = debug.gui.addFolder('Scene');
const sceneNav = { scene: 'grass' };
sceneFolder
  .add(sceneNav, 'scene', ['grass', 'ocean', 'ramp', 'palette'])
  .name('scene')
  .onChange((v: string) => {
    if (v === 'grass') return;
    window.location.href = '/?scene=' + v;
  });

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
// The propeller's own rotation, not the turntable below it. Above roughly 500 the
// blades alias against the frame rate and read as a slow crawl backwards — which
// is what a real 1800 rpm prop does on camera, and is why the sidecar's default is
// a legible 240 rather than an accurate one.
const propCtrl = planeFolder
  .add(params, 'propRpm', 0, 1800, 10)
  .name('propeller (rpm)')
  .onChange((v: number) => {
    const authored = scene.stage.spinnerRpm;
    scene.stage.setSpinThrottle(authored > 0 ? v / authored : 0);
  });
planeFolder
  .add(params, 'planeSpin', 0, 90, 1)
  .name('turntable (deg/s)')
  .onChange((v: number) => {
    scene.stage.spin = v;
  });

const townFolder = debug.gui.addFolder('Town');
// Hidden outright under `?town=0`: the assets were never fetched, so every control
// in here would be a dead switch, and a dead switch reads as a broken one.
if (!params.town) townFolder.hide();
townFolder.add(params, 'town').name('show').onChange((v: boolean) => {
  if (scene.town) scene.town.group.visible = v;
});
townFolder
  .add(params, 'scaleFigures')
  .name('1.8 m figures')
  // The scale reference. A door should reach about the figure's own height and a
  // storey about three-quarters again; anything else means that building's
  // declared height in TOWN_BUILDINGS is wrong.
  .onChange((v: boolean) => scene.setScaleFigures(v));
townFolder.open();

const birdFolder = debug.gui.addFolder('Birds');
birdFolder
  .add(params, 'birds')
  .name('show')
  .onChange((v: boolean) => scene.birds?.setVisible(v));
birdFolder
  .add(params, 'birdWingspan', 0.4, 4, 0.05)
  .name('wingspan (m)')
  // Authored span is measured on load, so this is metres rather than a multiplier
  // — 1.1 m is a herring gull, 2.5 m is an albatross.
  .onChange((v: number) => scene.birds?.setWingspan(v));
birdFolder
  .add(params, 'birdFlap', 0, 6, 0.1)
  // The clip is one 0.67 s wingbeat, so 1 is 1.5 flaps a second and the default
  // 2.2 is about a gull's 3. Independent of "speed x", which is the circuit.
  .name('wingbeat x')
  .onChange((v: number) => scene.birds?.setFlapRate(v));
birdFolder
  .add(params, 'birdSpeed', 0, 3, 0.05)
  .name('speed x')
  .onChange((v: number) => {
    if (scene.birds) scene.birds.speed = v;
  });
birdFolder.open();

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
viewFolder.add(params, 'skirt').name('edge walls').onChange((v: boolean) => scene.setSkirtVisible(v));
viewFolder
  .add(params, 'skirtDepth', 0.5, 20, 0.5)
  .name('edge wall depth (m)')
  // Rebuilds a few hundred triangles, so it is safe to drag, but it re-runs the
  // terrain height sampler along the perimeter — hence onFinishChange.
  .onFinishChange((v: number) => scene.setSkirtDepth(v));
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
    // `?town=0` picks the original four-tile island as well as skipping the
    // buildings — see worldLayout in GrassWorldScene.
    await scene.load(params.seaState, params.town);
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

  // The birds before the aircraft: 330 kB against 9.5 MB, so they are in the air
  // while the Savoia is still parsing.
  try {
    if (!BIRD_URL) throw new Error('src/models/bird.fbx is missing — see src/models/README.md');
    const birds = await scene.loadBirds(await BIRD_URL(), params.birdWingspan, params.birdFlap);
    birds.speed = params.birdSpeed;
    birds.setVisible(params.birds);
    say('flock of ' + birds.flock.length + ' over the meadow, one flying alone');
  } catch (error) {
    console.error(error);
    say('birds failed to load: ' + (error instanceof Error ? error.message : String(error)), true);
  }

  // The town. Fourteen third-party assets in three formats, two of them 17 MB
  // apiece, loaded one at a time so the page fills in rather than freezing for the
  // total. See Town.ts. Skipped entirely under `?town=0` — see the params block.
  if (params.town) try {
    say('loading the town …');
    // Vite's glob hands back a loader per file, not a URL, so every URL is
    // resolved up front and `loadTown` is given a plain synchronous lookup. It
    // wants to ask for a name and get a string back, not to know that the bundler
    // is involved at all.
    const townUrls = new Map<string, string>();
    for (const spec of [...TOWN_BUILDINGS, ...TOWN_LAMPS]) {
      for (const kind of ['model', 'texture'] as const) {
        const loader = townFile(spec.name, kind);
        if (loader) townUrls.set(spec.name + '|' + kind, await loader());
      }
    }
    const town = await scene.loadTown((name, kind) => townUrls.get(name + '|' + kind));
    town.group.visible = params.town;
    town.setScaleFigures(params.scaleFigures);
    paintReport();
    say(town.reports.length + ' buildings up, ' + town.frontage.toFixed(0) + ' m of frontage');
  } catch (error) {
    console.error(error);
    say('the town failed to load: ' + (error instanceof Error ? error.message : String(error)), true);
  }

  // The aircraft last: it is the smallest part of the scene and the slowest to
  // parse, and nothing else waits on it.
  try {
    if (!PLANE_URL) throw new Error('src/models/Porcorosso.fbx is missing — see src/models/README.md');
    // Straight from Porcorosso.parts.json, the same file the bench reads — this
    // page used to carry its own copy of the hide list and it went stale the first
    // time a part was added to one and not the other.
    const report = await scene.stage.loadUrl(await PLANE_URL(), 'Porcorosso.fbx', sidecarFor('Porcorosso.fbx'));
    scene.stage.setMaterialMode(params.material);
    scene.stage.setAltitude(scene.waterLevel + params.planeAltitude);
    params.propRpm = scene.stage.spinnerRpm;
    propCtrl.updateDisplay();
    scene.reframe();
    say('loaded ' + report.name);
  } catch (error) {
    console.error(error);
    say('aircraft failed to load: ' + (error instanceof Error ? error.message : String(error)), true);
  }
  paintReport();
})();

Object.assign(window as unknown as Record<string, unknown>, { engine, scene, THREE });
