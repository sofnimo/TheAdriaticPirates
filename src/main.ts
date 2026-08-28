import * as THREE from 'three';
import { Engine } from './app/Engine';
import { DebugUI } from './app/DebugUI';
import { RENDERER_CONTRACT } from './app/RendererConfig';
import { PaletteSwatchGate } from './dev/PaletteSwatchGate';
import { RampTestScene } from './dev/RampTestScene';
import { RampProbe } from './dev/RampProbe';
import { ISLAND_COVER } from './art/islandCover';
import { TEST_ISLAND_SEED } from './world/island/IslandSpec';
import { OceanTestScene, type OceanViewName } from './dev/OceanTestScene';
import { OceanProbe } from './dev/OceanProbe';
import { IslandProbe } from './dev/IslandProbe';
import { ShoreProbe } from './dev/ShoreProbe';
import { ShadowProbe } from './dev/ShadowProbe';
import { FreeCamera } from './app/FreeCamera';
import { SEA_STATE_OPTIONS, type SeaStateName } from './art/seaStates';
import { TIME_OF_DAY_NAMES, type TimeOfDayName } from './art/timeOfDay';
import { globalUniforms } from './render/shading/ShadingUniforms';
import { PostChain } from './render/post/PostChain';
import { PostProbe } from './dev/PostProbe';
import { POST, POST_SABOTAGE } from './art/post';

/**
 * Dev entry point. Scenes are selected with "?scene=":
 *   ocean   (default) — Step 2: flat ocean, banded depth, placeholder bathymetry
 *   ramp              — Step 1: the six surface presets + aerial perspective
 *   palette           — Step 0: the palette swatch gate
 *
 * Every earlier step's gate is kept and stays runnable — they are regression checks, not
 * scaffolding to be deleted once the next step lands.
 *
 * "?tonemap=aces" sabotages the renderer contract in any scene. PERMANENT: a gate that only
 * ever prints PASS proves nothing, so this is the standing negative control for the whole
 * colour pipeline. "?bands=N" is the same idea one layer down — it puts the old depth
 * quantiser back so the sea smoothness gate can be watched failing, and "?foam=smooth"
 * bypasses the foam quantiser for the same reason. "?still=1" renders one
 * frame and stops the loop (headless capture); "?view=" picks the camera; "?report=0" hides
 * the measurement panel.
 *
 * The post chain (04 §7.1) has the same family of standing controls, one per failure the
 * doc's §8.3 checklist names:
 *   ?post=0            — chain off entirely, the un-graded frame
 *   ?bloom=low         — threshold 0.35: bloom bleeding into every midtone (04 §4.1)
 *   ?grain=heavy       — grain past 04 §8.2's ceiling, reading as an effect
 *   ?grain=animated    — 04 §7.3's time-seeded snippet, which rule 8's "static" forbids
 *   ?vignette=heavy    — a vignette that visibly frames the shot (04 §8.3)
 */

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
if (!canvas) throw new Error('#viewport canvas not found');

const ui = document.querySelector<HTMLDivElement>('#ui');
if (!ui) throw new Error('#ui container not found');

const query = new URLSearchParams(window.location.search);
const sceneParam = query.get('scene');
const sceneName = sceneParam === 'palette' || sceneParam === 'ramp' ? sceneParam : 'ocean';
const bootSabotaged = query.get('tonemap') === 'aces';
/** `?still=1` renders one frame, runs the gate, and stops the loop — deterministic
 *  capture for headless verification, where a live RAF loop never yields a screenshot. */
const stillMode = query.get('still') === '1';

const engine = new Engine({ canvas, preserveDrawingBuffer: true });
const debug = new DebugUI(document.body, 'Adriatic — Step 2');

const SABOTAGE = 'ACESFilmic (sabotage)';
const CONTRACT = 'NoToneMapping (contract)';
if (bootSabotaged) engine.renderer.toneMapping = THREE.ACESFilmicToneMapping;

// --- shared controls (both scenes) ------------------------------------------
const pipeline = {
  toneMapping: (bootSabotaged ? SABOTAGE : CONTRACT) as typeof CONTRACT | typeof SABOTAGE,
  scene: sceneName,
};

const pipelineFolder = debug.gui.addFolder('Pipeline');
pipelineFolder
  .add(pipeline, 'toneMapping', [CONTRACT, SABOTAGE])
  .name('tone mapping')
  .onChange((v: string) => {
    engine.renderer.toneMapping = v === SABOTAGE ? THREE.ACESFilmicToneMapping : RENDERER_CONTRACT.toneMapping;
    runGate();
  });
pipelineFolder
  .add(pipeline, 'scene', ['ocean', 'ramp', 'palette'])
  .name('scene')
  .onChange((v: string) => {
    window.location.search = '?scene=' + v + (pipeline.toneMapping === SABOTAGE ? '&tonemap=aces' : '');
  });

let runGate: () => void = () => {};
/** Set by the ramp scene so still-mode capture can pin the view after probing. */
let stillSetView: (() => void) | null = null;
/** Which camera the captured frame is actually showing — diagnostic for headless runs. */
let capturedCamera: string | null = null;

if (sceneName === 'palette') {
  // ---------------------------------------------------------------- palette gate
  const gate = new PaletteSwatchGate(engine.renderer, ui);
  engine.setScene(gate.scene, gate.camera);
  engine.setDevOverlay(null);

  const params = {
    columns: 6,
    showCssHalf: true,
    reverify: () => runGate(),
    copyReport: () => {
      void navigator.clipboard?.writeText(gate.formatReport());
      console.log(gate.formatReport());
    },
  };

  const folder = debug.gui.addFolder('Palette gate');
  folder.add(params, 'columns', 2, 10, 1).onChange((v: number) => {
    gate.setColumns(v);
    runGate();
  });
  folder.add(params, 'showCssHalf').name('CSS ground-truth half').onChange((v: boolean) => gate.setOverlayVisible(v));
  folder.add(params, 'reverify').name('re-verify');
  folder.add(params, 'copyReport').name('copy report');
  folder.open();

  runGate = () => {
    const report = gate.verify();
    if (report.pass) {
      console.log('%cPALETTE GATE PASS', 'background:#14707c;color:#ebedea;padding:2px 6px;border-radius:3px');
    } else {
      console.warn('PALETTE GATE FAIL\n' + gate.formatReport());
    }
  };

  engine.onResize(() => runGate());
} else if (sceneName === 'ramp') {
  // ---------------------------------------------------------------- ramp gate
  const test = new RampTestScene();
  const probe = new RampProbe(engine.renderer, test);

  engine.setScene(test.scene, test.camera);
  engine.setDevOverlay(test.devOverlay);

  const banner = document.createElement('div');
  banner.className = 'gate-summary';
  ui.appendChild(banner);

  // Full measurement dump, on screen. The numbers are the deliverable here, not the
  // pretty picture — a band count is checkable, "looks about right" is not.
  const reportEl = document.createElement('pre');
  reportEl.className = 'gate-report';
  if (query.get('report') === '0') reportEl.style.display = 'none';
  ui.appendChild(reportEl);

  const params = {
    view: (query.get('view') === 'haze' ? 'haze' : 'ramp') as 'ramp' | 'haze',
    timeOfDay: 'lateMorning' as TimeOfDayName,
    helpers: false,
    hemiGradient: 0,
    hazeDensity: globalUniforms.uHazeDensity.value,
    hazeStrength: globalUniforms.uHazeStrength.value,
    showReport: query.get('report') !== '0',
    verify: () => runGate(),
    copyReport: () => {
      const text = lastReport ? RampProbe.format(lastReport) : 'not run';
      void navigator.clipboard?.writeText(text);
      console.log(text);
    },
  };

  const folder = debug.gui.addFolder('Ramp gate (Step 1)');
  folder.add(params, 'view', ['ramp', 'haze']).name('view').onChange((v: 'ramp' | 'haze') => test.setView(v));
  folder
    .add(params, 'timeOfDay', TIME_OF_DAY_NAMES as unknown as string[])
    .name('time of day')
    .onChange((v: TimeOfDayName) => {
      test.sun.apply(v);
      runGate();
    });
  folder.add(params, 'helpers').name('shadow frustum helper').onChange((v: boolean) => test.setHelpersVisible(v));
  folder
    .add(params, 'hemiGradient', 0, 1, 0.01)
    .name('hemi gradient (off=flat)')
    .onChange((v: number) => {
      globalUniforms.uHemiGradient.value = v;
    });
  folder
    .add(params, 'hazeDensity', 0.00005, 0.0006, 0.00001)
    .name('haze density')
    .onChange((v: number) => {
      globalUniforms.uHazeDensity.value = v;
    });
  folder
    .add(params, 'hazeStrength', 0, 1, 0.01)
    .name('haze strength')
    .onChange((v: number) => {
      globalUniforms.uHazeStrength.value = v;
    });
  folder
    .add(params, 'showReport')
    .name('report panel')
    .onChange((v: boolean) => {
      reportEl.style.display = v ? '' : 'none';
    });
  folder.add(params, 'verify').name('re-verify');
  folder.add(params, 'copyReport').name('copy report');
  folder.open();

  let lastReport: ReturnType<RampProbe['run']> | null = null;

  runGate = () => {
    lastReport = probe.run();
    const text = RampProbe.format(lastReport);
    if (lastReport.pass) {
      console.log('%cRAMP GATE PASS', 'background:#14707c;color:#ebedea;padding:2px 6px;border-radius:3px');
      console.log(text);
    } else {
      console.warn(text);
    }
    test.setView(params.view);
    const p = test.camera.position;
    capturedCamera = params.view + ' (' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ',' + p.z.toFixed(0) + ')';
    paintBanner(banner, lastReport);
    reportEl.textContent = 'view: ' + capturedCamera + '\n\n' + text;
  };

  engine.onResize((w, h) => {
    test.resize(w / h);
    runGate();
  });

  engine.onFrame(() => test.update());

  // Still mode renders exactly one frame, but a late window resize can re-run the gate
  // afterwards; re-assert the view and repaint so the captured frame is always the one
  // that was asked for.
  stillSetView = () => {
    test.setView(params.view);
    test.update();
  };
} else {
  // ---------------------------------------------------------------- ocean gate
  const test = new OceanTestScene();
  const probe = new OceanProbe(engine.renderer, test);
  const islandProbe = new IslandProbe(engine.renderer, test);
  const shoreProbe = new ShoreProbe(engine.renderer, test);
  const shadowProbe = new ShadowProbe(engine.renderer, test);

  // 03 §8's free camera. Constructed here rather than inside the scene because it is a debug
  // input device, not world content, and the scene must stay renderable headlessly.
  const freeCam = new FreeCamera(test.camera, canvas, { speed: 120 });

  // Standing negative control for the foam quantiser — 02b §9 makes "never ship a raw
  // smoothstep foam edge" a checklist item, so it gets a toggle that can be watched failing.
  const shoreDebug = Number(query.get('debug') ?? 0);
  if (Number.isFinite(shoreDebug) && shoreDebug > 0) {
    test.shoreUniforms.uShoreDebug!.value = shoreDebug;
  }

  if (query.get('foam') === 'smooth') {
    test.shoreUniforms.uFoamSmoothSabotage!.value = 1;
    console.warn('SABOTAGE: foam quantiser bypassed, raw smoothstep edges (?foam=smooth)');
  }

  // Standing negative control for the smoothness gate — see the file header.
  const bandSabotage = Number(query.get('bands') ?? 0);
  if (Number.isFinite(bandSabotage) && bandSabotage > 0) {
    test.ocean.uniforms.uBandSabotage!.value = bandSabotage;
    console.warn('SABOTAGE: sea depth quantised to ' + bandSabotage + ' bands (?bands=)');
  }

  engine.setScene(test.scene, test.camera);
  engine.setDevOverlay(test.devOverlay);

  // --- the post chain (Step 6, 04 §7.1) --------------------------------------------------
  // World only. The palette and ramp gates keep rendering straight to the canvas: they
  // measure material output byte-for-byte, and a grain pass on top would put a few counts
  // of noise on every comparison they make.
  const post = new PostChain({
    renderer: engine.renderer,
    scene: test.scene,
    camera: test.camera,
    onSceneStats: (calls, triangles) => engine.tapSceneStats(calls, triangles),
  });
  post.enabled = query.get('post') !== '0';
  engine.setPostChain(post);
  const postProbe = new PostProbe(engine.renderer, post);

  // Standing negative controls — one per failure 04 §8.3's checklist names. See the header.
  if (query.get('bloom') === 'low') {
    post.setBloom(POST_SABOTAGE.bloomThreshold, POST.bloom.strength, POST.bloom.radius);
    console.warn('SABOTAGE: bloom threshold ' + POST_SABOTAGE.bloomThreshold + ' — midtones bloom (?bloom=low)');
  }
  const grainParam = query.get('grain');
  if (grainParam === 'heavy') {
    post.setGrainStrength(POST_SABOTAGE.grainStrength);
    console.warn('SABOTAGE: grain ' + POST_SABOTAGE.grainStrength + ', past 04 §8.2 ceiling (?grain=heavy)');
  } else if (grainParam === 'animated') {
    post.setGrainAnimateSeed(1);
    console.warn('SABOTAGE: grain crawls — 04 §7.3 snippet behaviour, rule 8 forbids it (?grain=animated)');
  }
  if (query.get('vignette') === 'heavy') {
    post.setVignetteCorner(POST_SABOTAGE.vignetteCorner);
    console.warn('SABOTAGE: vignette ' + POST_SABOTAGE.vignetteCorner + ' — visibly frames the shot (?vignette=heavy)');
  }

  const banner = document.createElement('div');
  banner.className = 'gate-summary';
  ui.appendChild(banner);

  const reportEl = document.createElement('pre');
  reportEl.className = 'gate-report';
  if (query.get('report') === '0') reportEl.style.display = 'none';
  ui.appendChild(reportEl);

  const viewParam = query.get('view');
  const VIEW_NAMES: OceanViewName[] = [
    'cove', 'shelf', 'skim', 'island', 'profile', 'canopy', 'shore',
    'topdown', 'low', 'high', 'cockpit', 'free',
  ];
  const isView = (v: string | null): v is OceanViewName =>
    v !== null && (VIEW_NAMES as string[]).includes(v);

  const u = test.ocean.uniforms;
  const params = {
    view: (isView(viewParam) ? viewParam : 'cove') as OceanViewName,
    seaState: test.ocean.seaStateName as SeaStateName,
    waveHeading: test.ocean.waveHeadingDeg,
    shelterMin: u.uShelterMin!.value as number,
    shelterReach: test.shelter.fullFetch,
    timeOfDay: 'lateMorning' as TimeOfDayName,
    sunElevation: test.sun.elevationDeg,
    sunAzimuth: test.sun.azimuthDeg,
    // Read back as degrees from the authored cosine, so the slider opens on the real value
    // rather than on a hardcoded guess that could drift away from 01 §1.2.
    sunDiscDeg: THREE.MathUtils.radToDeg(Math.acos(globalUniforms.uSunSize.value)),
    edgeNoiseAmount: u.uEdgeNoiseAmount!.value as number,
    edgeNoiseScale: u.uEdgeNoiseScale!.value as number,
    glintCoverage: u.uGlintCoverage!.value as number,
    glintStretch: u.uGlintStretch!.value as number,
    glintScale: u.uGlintScale!.value as number,
    hazeStrength: globalUniforms.uHazeStrength.value,
    showReport: query.get('report') !== '0',
    verify: () => runGate(),
    copyReport: () => {
      const text = lastReport ? OceanProbe.format(lastReport) : 'not run';
      void navigator.clipboard?.writeText(text);
      console.log(text);
    },
  };

  const folder = debug.gui.addFolder('Ocean gate (Step 2)');
  folder
    .add(params, 'view', VIEW_NAMES as unknown as string[])
    .name('view')
    .onChange((v: OceanViewName) => setView(v));
  folder
    .add(params, 'seaState', SEA_STATE_OPTIONS)
    .name('sea state')
    .onChange((v: SeaStateName) => {
      // Through the scene, so the hull's copy of the wave stack moves with the shader's.
      test.setSeaState(v);
      params.glintCoverage = u.uGlintCoverage!.value as number;
      // A sea state carries its own bearing, so the heading slider has just been moved for you.
      params.waveHeading = test.ocean.waveHeadingDeg;
      headingCtl.updateDisplay();
      runGate();
    });
  // The whole stack turns together, keeping the spread the sea state authored between its four
  // components — aim them independently and it stops being a swell and becomes four unrelated
  // waves crossing. The glint field's stretch axis turns with it, or the marks would lie across
  // the crests instead of down them.
  const headingCtl = folder
    .add(params, 'waveHeading', 0, 360, 1)
    .name('swell heading (deg from N)')
    .onChange((v: number) => test.setWaveHeading(v));

  // --- shelter ----------------------------------------------------------------------------
  // The lee of an island. Turning the heading above re-casts these wind shadows, so the calm
  // water is always on the far side from wherever the swell is now coming from.
  const shelterFolder = folder.addFolder('shelter (island lee)');
  shelterFolder
    .add(params, 'shelterMin', 0, 0.5, 0.01)
    .name('waves left in the lee')
    // Live: a plain uniform on the shader side, and one number on the hull's side that has to
    // match it or the aircraft rides a different sea from the one being drawn.
    .onChange((v: number) => {
      u.uShelterMin!.value = v;
      test.waveSurface.shelterMin = v;
    });
  shelterFolder
    .add(params, 'shelterReach', 200, 3000, 50)
    .name('reach to full sea (m)')
    // Structural: re-marches the whole field, so it waits for the drag to finish.
    .onFinishChange((v: number) => test.setShelterReach(v));
  folder
    .add(params, 'timeOfDay', TIME_OF_DAY_NAMES as unknown as string[])
    .name('time of day')
    .onChange((v: TimeOfDayName) => {
      test.sun.apply(v);
      // A preset carries its own bearing, so the two sliders below have just been moved for
      // you. Without this they would keep showing the old angles while the sun sat somewhere
      // else, which makes the panel lie about the thing it exists to report.
      params.sunElevation = test.sun.elevationDeg;
      params.sunAzimuth = test.sun.azimuthDeg;
      elevationCtl.updateDisplay();
      azimuthCtl.updateDisplay();
      runGate();
    });

  // --- the sun ---------------------------------------------------------------------------
  // WHERE THE SUN IS DRAWN AND WHERE THE SHADOWS FALL ARE THE SAME NUMBER.
  //
  // These two sliders write `uSunDirection`, and everything that cares reads it: the sky
  // dome's disc (`skyWithSun`), the shading terminator on every surface, and the cascade fit.
  // So the disc in the sky is not a marker standing in for the light — it is the light, and
  // dragging elevation down watches the shadows lengthen away from it.
  //
  // The disc is authored at a true 1 degree, which is correct and almost impossible to find
  // in a 50 degree field of view. The size slider is there to make it findable while working;
  // it is a viewing aid, not a change to 01 §1.2, which is why it starts at the authored value.
  const sunFolder = folder.addFolder('sun');
  const applyAngles = (): void => test.sun.setAngles(params.sunElevation, params.sunAzimuth);
  const elevationCtl = sunFolder
    .add(params, 'sunElevation', 0, 90, 0.5)
    .name('elevation (deg)')
    .onChange(applyAngles);
  const azimuthCtl = sunFolder
    .add(params, 'sunAzimuth', 0, 360, 1)
    .name('azimuth (deg from N)')
    .onChange(applyAngles);
  sunFolder
    .add(params, 'sunDiscDeg', 0.25, 12, 0.25)
    .name('disc size (deg)')
    // The uniform is the COSINE of the half-angle, which runs 0.99985 to 1.0 over the useful
    // range and is unusable as a slider. Degrees in, cosine out.
    .onChange((v: number) => {
      globalUniforms.uSunSize.value = Math.cos(THREE.MathUtils.degToRad(v));
    });

  const shelf = folder.addFolder('shelf band');
  shelf
    .add(params, 'edgeNoiseAmount', 0, 0.15, 0.005)
    .name('edge wander amount')
    .onChange((v: number) => {
      u.uEdgeNoiseAmount!.value = v;
    });
  shelf
    .add(params, 'edgeNoiseScale', 8, 200, 1)
    .name('edge wander scale (m)')
    .onChange((v: number) => {
      u.uEdgeNoiseScale!.value = v;
    });

  const glints = folder.addFolder('glints');
  glints
    .add(params, 'glintCoverage', 0, 0.12, 0.002)
    .name('coverage')
    .onChange((v: number) => {
      u.uGlintCoverage!.value = v;
    });
  glints
    .add(params, 'glintStretch', 0.02, 0.5, 0.01)
    .name('along-swell squash')
    .onChange((v: number) => {
      u.uGlintStretch!.value = v;
    });
  glints
    .add(params, 'glintScale', 0.01, 0.2, 0.005)
    .name('cell scale')
    .onChange((v: number) => {
      u.uGlintScale!.value = v;
    });

  folder
    .add(params, 'hazeStrength', 0, 1, 0.01)
    .name('haze strength')
    .onChange((v: number) => {
      globalUniforms.uHazeStrength.value = v;
    });
  folder
    .add(params, 'showReport')
    .name('report panel')
    .onChange((v: boolean) => {
      reportEl.style.display = v ? '' : 'none';
    });
  folder.add(params, 'verify').name('re-verify');
  folder.add(params, 'copyReport').name('copy report');
  folder.open();

  // --- post chain (Step 6, 04 §7) ---------------------------------------------------------
  const postParams = {
    enabled: post.enabled,
    bloom: true,
    grain: true,
    vignette: true,
    bloomThreshold: POST.bloom.threshold,
    bloomStrength: POST.bloom.strength,
    grainStrength: post.values.grainStrength,
    chromaWobble: POST.grain.chromaWobble,
    vignetteCorner: post.values.vignetteCorner,
    animateGrain: grainParam === 'animated',
  };
  const postFolder = debug.gui.addFolder('Post chain (04 §7)');
  postFolder.add(postParams, 'enabled').name('post chain').onChange((v: boolean) => {
    post.enabled = v;
  });
  postFolder.add(postParams, 'bloom').name('bloom').onChange((v: boolean) => post.setBloomEnabled(v));
  postFolder.add(postParams, 'grain').name('grain + chroma').onChange((v: boolean) => post.setGrainEnabled(v));
  postFolder.add(postParams, 'vignette').name('vignette').onChange((v: boolean) => post.setVignetteEnabled(v));
  postFolder
    .add(postParams, 'bloomThreshold', 0.2, 1.0, 0.01)
    .name('bloom threshold (0.90-0.94)')
    .onChange((v: number) => post.setBloom(v, postParams.bloomStrength, POST.bloom.radius));
  postFolder
    .add(postParams, 'bloomStrength', 0, 1.5, 0.01)
    .name('bloom strength (0.4-0.6)')
    .onChange((v: number) => post.setBloom(postParams.bloomThreshold, v, POST.bloom.radius));
  postFolder
    .add(postParams, 'grainStrength', 0, 0.15, 0.001)
    .name('grain (0.02-0.035)')
    .onChange((v: number) => post.setGrainStrength(v));
  postFolder
    .add(postParams, 'chromaWobble', 0, 0.08, 0.001)
    .name('chroma wobble (0.01-0.02)')
    .onChange((v: number) => post.setChromaWobble(v));
  postFolder
    .add(postParams, 'vignetteCorner', 0, 0.35, 0.005)
    .name('vignette corner (0.06-0.08)')
    .onChange((v: number) => post.setVignetteCorner(v));
  postFolder
    .add(postParams, 'animateGrain')
    .name('animate grain (sabotage)')
    .onChange((v: boolean) => post.setGrainAnimateSeed(v ? 1 : 0));

  // --- land cover ---------------------------------------------------------------------
  // Four folders for `05 — Distant Terrain Layering.md`'s four tiers, in the order they
  // stack: A0 ground, A1 dried grass (a colour sublayer INSIDE A0, never its own geometry),
  // B raised long grass, C oak canopy. Two kinds of control, and which is which is a
  // property of what the value feeds rather than a preference:
  //
  //   LIVE        colours, blend widths, thresholds, offsets. Bound on `onChange`, so they
  //               move under the cursor — they are uniform writes and cost nothing.
  //   STRUCTURAL  coverage, patch scale, hull size. Bound on `onFinishChange`, because each
  //               re-bakes the cover masks and re-scatters the canopy, and doing that once
  //               per mouse-move event makes the slider unusable.
  //
  // The fields marked STRUCTURAL in `art/islandCover.ts` are exactly the ones wired to
  // `rebuild` here; that comment and this binding have to agree.
  const cover = ISLAND_COVER;
  const tiers = { base: true, longGrass: true, canopy: true, hulls: 0 };

  const syncLive = (): void => test.archipelago.refreshCover(false);
  const rebuild = (): void => {
    test.archipelago.refreshCover(true);
    tiers.hulls = test.archipelago.hulls;
    hullsCtl.updateDisplay();
  };

  // ---- the island generator ---------------------------------------------------------------
  // The seed is the whole archipelago: every spine, width, cut, doline and beach is a pure
  // function of it. Changing it reloads rather than rebuilding in place — the field, the
  // cover masks, the shore atlas, the bathymetry and every mesh bake from it, and rebuilding
  // that graph live is a much larger job than looking at a different island is worth.
  const genFolder = debug.gui.addFolder('Island generator');
  const genParams = {
    seed: Number(query.get('island') ?? TEST_ISLAND_SEED),
    reroll: () => {
      const next = Math.floor(Math.random() * 100000);
      query.set('island', String(next));
      window.location.search = query.toString();
    },
    apply: () => {
      query.set('island', String(genParams.seed));
      window.location.search = query.toString();
    },
  };
  genFolder.add(genParams, 'seed', 0, 100000, 1).name('seed');
  genFolder.add(genParams, 'apply').name('load this seed');
  genFolder.add(genParams, 'reroll').name('random island');

  // ---- tier A0: the ground ---------------------------------------------------------------
  const baseFolder = debug.gui.addFolder('Tier A0 — ground');
  baseFolder.add(tiers, 'base').name('visible').onChange((v: boolean) => {
    for (const i of test.archipelago.islands) i.terrainMesh.visible = v;
  });
  baseFolder.addColor(cover, 'grass').name('short grass').onChange(syncLive);
  baseFolder.addColor(cover, 'sand').name('sand').onChange(syncLive);
  baseFolder.addColor(cover, 'cliff').name('limestone').onChange(syncLive);
  baseFolder.addColor(cover, 'cliffStrata').name('limestone strata').onChange(syncLive);

  const sandFolder = baseFolder.addFolder('shoreline');
  sandFolder.add(cover, 'sandWidth', 0, 30, 0.5).name('edge trim (m)').onChange(syncLive);
  sandFolder.add(cover, 'shoreSandWidth', 0, 40, 0.5).name('bare shore (m)').onChange(syncLive).onFinishChange(rebuild);
  sandFolder.add(cover, 'sandSeaward', 0, 400, 5).name('reach seaward (m)').onChange(syncLive);
  sandFolder.add(cover, 'sandSoftness', 0.25, 40, 0.25).name('blend width (m)').onChange(syncLive);
  sandFolder.add(cover, 'sandEdgeWobble', 0, 30, 0.5).name('edge wander (m)').onChange(syncLive);
  sandFolder.add(cover, 'sandEdgeScale', 10, 400, 5).name('wander scale (m)').onChange(syncLive);

  // Structural as well as live: the cover masks keep themselves off the cliffs using these,
  // so moving them moves where long grass and oaks are allowed to stand.
  const cliffFolder = baseFolder.addFolder('cliff');
  cliffFolder.add(cover, 'cliffSlopeStart', 0, 1, 0.01).name('slope start').onChange(syncLive).onFinishChange(rebuild);
  cliffFolder.add(cover, 'cliffSoftness', 0.01, 0.6, 0.01).name('blend width').onChange(syncLive);
  cliffFolder.add(cover, 'coastRockNear', 0, 60, 1).name('coast rock, full (m)').onChange(syncLive);
  cliffFolder.add(cover, 'coastRockFar', 5, 200, 1).name('coast rock, gone by (m)').onChange(syncLive);
  cliffFolder.add(cover, 'strataMetres', 1, 30, 0.5).name('bed thickness (m)').onChange(syncLive);
  cliffFolder.add(cover, 'strataStrength', 0, 1, 0.01).name('bed contrast').onChange(syncLive);

  // ---- tier A1: dried grass ---------------------------------------------------------------
  // No visibility toggle, and that is not an omission: A1 is composited inside A0's grass
  // branch (§3), so "hiding" it means setting its coverage to zero.
  const dryFolder = debug.gui.addFolder('Tier A1 — dried grass');
  dryFolder.addColor(cover, 'grassDry').name('colour').onChange(syncLive);
  dryFolder.add(cover, 'drySoftness', 0.01, 0.5, 0.01).name('blend width').onChange(syncLive);
  dryFolder.add(cover, 'dryCoverage', 0, 0.6, 0.01).name('coverage (0.04-0.12)').onFinishChange(rebuild);
  dryFolder.add(cover, 'dryScale', 10, 400, 2).name('patch scale (m)').onFinishChange(rebuild);
  dryFolder.add(cover, 'dryDetailScale', 5, 150, 1).name('detail scale (m)').onFinishChange(rebuild);
  dryFolder.add(cover, 'dryDetailAmount', 0, 1, 0.01).name('detail amount').onFinishChange(rebuild);

  // ---- tier B: raised long grass ----------------------------------------------------------
  const longFolder = debug.gui.addFolder('Tier B — long grass');
  longFolder.add(tiers, 'longGrass').name('visible')
    .onChange((v: boolean) => test.archipelago.setTierVisibility(v, tiers.canopy));
  longFolder.addColor(cover, 'longGrass').name('colour').onChange(syncLive);
  longFolder.add(cover, 'longGrassOffset', 0, 4, 0.05).name('lift off ground (m)').onChange(syncLive);
  longFolder.add(cover, 'longGrassThreshold', 0, 1, 0.01).name('alpha cut').onChange(syncLive);
  longFolder.add(cover, 'longGrassBreakupScale', 3, 80, 1).name('edge breakup (m)').onChange(syncLive);
  longFolder.add(cover, 'longGrassSandMargin', 0, 60, 0.5).name('clearance off sand (m)').onChange(syncLive);
  longFolder.add(cover, 'longGrassCoverage', 0, 1, 0.01).name('coverage').onFinishChange(rebuild);
  longFolder.add(cover, 'longGrassScale', 15, 400, 5).name('patch scale (m)').onFinishChange(rebuild);

  // ---- tier C: oak canopy -----------------------------------------------------------------
  const canopyFolder = debug.gui.addFolder('Tier C — oak canopy');
  canopyFolder.add(tiers, 'canopy').name('visible')
    .onChange((v: boolean) => test.archipelago.setTierVisibility(tiers.longGrass, v));
  canopyFolder.addColor(cover, 'canopyDark').name('shadow stop').onChange(syncLive);
  canopyFolder.addColor(cover, 'canopyMid').name('mid stop').onChange(syncLive);
  canopyFolder.addColor(cover, 'canopyLight').name('lit stop').onChange(syncLive);
  canopyFolder.add(cover, 'normalSpread', 0, 1, 0.01).name('normal spread (0.35-0.75)').onChange(syncLive);
  canopyFolder.add(cover, 'splitMid', -1, 1, 0.01).name('mid threshold (0.15)').onChange(syncLive);
  canopyFolder.add(cover, 'splitLit', -1, 1, 0.01).name('lit threshold (0.45)').onChange(syncLive);
  canopyFolder.add(cover, 'dabDensity', 0, 0.4, 0.005).name('lit dab coverage (0.08)').onChange(syncLive);
  canopyFolder.add(cover, 'dabScale', 4, 120, 1).name('dab scale (m)').onChange(syncLive);
  canopyFolder.add(cover, 'forestThreshold', 0, 1, 0.01).name('treeline threshold').onChange(syncLive).onFinishChange(rebuild);
  canopyFolder.add(cover, 'forestSandMargin', 0, 120, 1).name('clearance off sand (m)').onChange(syncLive);
  canopyFolder.add(cover, 'forestCoverage', 0, 1, 0.01).name('coverage').onFinishChange(rebuild);
  canopyFolder.add(cover, 'forestScale', 60, 1200, 10).name('grove scale (m)').onFinishChange(rebuild);
  canopyFolder.add(cover, 'canopyCellSize', 16, 200, 2).name('scatter cell (m)').onFinishChange(rebuild);
  canopyFolder.add(cover, 'hullsPerCell', 1, 6, 1).name('hulls per cell').onFinishChange(rebuild);
  canopyFolder.add(cover, 'hullRadius', 3, 60, 0.5).name('crown radius (m)').onFinishChange(rebuild);
  canopyFolder.add(cover, 'hullHeight', 2, 40, 0.5).name('crown height (m)').onFinishChange(rebuild);
  canopyFolder.add(cover, 'hullJitter', 0, 1, 0.01).name('size variation').onFinishChange(rebuild);
  canopyFolder.add(cover, 'canopyMaxHulls', 1000, 120000, 1000).name('hull cap').onFinishChange(rebuild);
  tiers.hulls = test.archipelago.hulls;
  const hullsCtl = canopyFolder.add(tiers, 'hulls').name('hulls placed').disable();

  // ---- shared suitability ------------------------------------------------------------------
  // One veto, three tiers (§7.1). It lives in its own folder because moving it moves every
  // patch outline on the island at once, which is exactly what it is for.
  const suitFolder = debug.gui.addFolder('Cover suitability');
  suitFolder.add(cover, 'coverMaxSlope', 0.1, 1, 0.01).name('max slope').onFinishChange(rebuild);
  suitFolder.add(cover, 'moistureScale', 200, 3000, 25).name('moisture scale (m)').onFinishChange(rebuild);
  suitFolder.add(cover, 'moistureBias', 0, 1, 0.01).name('moisture bias').onFinishChange(rebuild);

  // --- free camera -----------------------------------------------------------------------
  const camHud = document.createElement('div');
  camHud.className = 'freecam-hud';
  camHud.style.display = 'none';
  ui.appendChild(camHud);

  // --- the pilot's seat ------------------------------------------------------------------
  // Airspeed, the throttle lever against what the engines are actually giving, and how much
  // hull is still in the water. That last number is the takeoff run: it sits at 1 through
  // the displacement phase, falls as the hull climbs onto the step, and hits zero at unstick.
  const pilotHud = document.createElement('div');
  pilotHud.className = 'freecam-hud';
  pilotHud.style.display = 'none';
  ui.appendChild(pilotHud);

  const paintPilotHud = (): void => {
    const s = test.seaplane.state;
    const bar = (v: number): string => {
      const n = Math.round(Math.max(0, Math.min(1, v)) * 12);
      return '[' + '#'.repeat(n) + '.'.repeat(12 - n) + ']';
    };
    const phase = s.airborne
      ? (s.stalled ? 'STALL' : 'airborne')
      : s.wetted > 0.75 ? 'displacement'
      : s.wetted > 0.08 ? 'on the step'
      : 'unsticking';
    pilotHud.textContent =
      'throttle ' + bar(test.seaplane.input.controls.throttle) +
      '   engines ' + bar(test.seaplane.physics.engine) +
      '\nairspeed ' + s.airspeed.toFixed(1) + ' m/s   ' + (s.airspeed * 1.944).toFixed(0) + ' kt' +
      '   altitude ' + s.altitude.toFixed(1) + ' m   climb ' + s.climbRate.toFixed(1) + ' m/s' +
      '\nhull in water ' + bar(s.wetted) + '  ' + phase +
      '   AoA ' + ((s.angleOfAttack * 180) / Math.PI).toFixed(1) + '\u00b0' +
      '\n W/S throttle  \u00b7  arrows pitch and roll  \u00b7  A/D rudder  \u00b7  R re-moor';
  };

  const paintCamHud = (): void => {
    camHud.textContent =
      freeCam.status() +
      '\n WASD / arrows fly  ·  Q E or space C up-down  ·  shift boost  ·  alt crawl' +
      '\n drag or click to look  ·  wheel sets speed  ·  esc releases the mouse';
  };

  /**
   * The single place the view changes.
   *
   * Enabling the free camera has to happen through here rather than through a bare toggle,
   * because the two are one setting: the preset views and the free camera are both "where
   * the camera is", and letting them be set independently is how you end up with a free
   * camera that a gate re-run silently teleports.
   */
  function setView(v: OceanViewName): void {
    params.view = v;
    if (v === 'free') {
      // Seed from wherever the last preset left the camera. Jumping to a fixed spawn throws
      // away the framing you were looking at when you decided you wanted to fly.
      freeCam.enable();
      camHud.style.display = '';
      paintCamHud();
    } else {
      freeCam.disable();
      camHud.style.display = 'none';
    }
    // The free camera and the pilot share WASD, so only one of them may be listening.
    pilotHud.style.display = v === 'cockpit' ? '' : 'none';
    test.setView(v);
  }

  freeCam.onMove(paintCamHud);

  const camFolder = debug.gui.addFolder('Free camera');
  const camParams = {
    fly: params.view === 'free',
    speed: freeCam.currentSpeed,
  };
  camFolder
    .add(camParams, 'fly')
    .name('fly (F)')
    .onChange((v: boolean) => {
      setView(v ? 'free' : 'island');
      params.view = v ? 'free' : 'island';
      folder.controllers.find((c) => c.property === 'view')?.updateDisplay();
    });
  camFolder.add(camParams, 'speed', 2, 800, 1).name('speed (m/s)').onChange((v: number) => freeCam.setSpeed(v));
  camFolder.open();

  // F toggles the free camera from anywhere, so you can leave a preset view without
  // hunting for the panel. Ignored while typing into one of the panel's number fields.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    camParams.fly = params.view !== 'free';
    setView(camParams.fly ? 'free' : 'island');
    camFolder.controllers.find((c) => c.property === 'fly')?.updateDisplay();
    folder.controllers.find((c) => c.property === 'view')?.updateDisplay();
  });

  let lastReport: ReturnType<OceanProbe['run']> | null = null;

  runGate = () => {
    // The probes drive the camera to their own framings. Under the free camera that would
    // dump the pilot wherever the last transect was measured, so the pose is taken before
    // and put back after — the gate is a measurement, not a teleport.
    const pose = params.view === 'free' ? freeCam.capturePose() : null;
    lastReport = probe.run();
    // Step 3's gate runs alongside Step 2's, not instead of it. Earlier steps stay live as
    // regression checks — the island now supplies the bathymetry, so it is entirely possible
    // to break the shelf transition from inside the island generator.
    const islandReport = islandProbe.run();
    const shoreReport = shoreProbe.run();
    // Step 5's gate. Runs before the post gate for the same reason the others do: it restores
    // the cascade state it toggles, so what is left on screen is the world as configured.
    const shadowReport = shadowProbe.run();
    // Step 6's gate runs on its own calibration card, not on the world view — see PostProbe's
    // header. It restores every pass toggle it touches, so it is safe to run alongside the
    // others; it is last only so the world frame is what remains on screen afterwards.
    const postReport = postProbe.run();
    const text =
      OceanProbe.format(lastReport) + '\n\n' +
      IslandProbe.format(islandReport) + '\n\n' +
      ShoreProbe.format(shoreReport) + '\n\n' +
      ShadowProbe.format(shadowReport) + '\n\n' +
      PostProbe.format(postReport);
    // Exposed so the headless capture harness can read the gates without scraping console.
    (window as unknown as { __gateText?: string }).__gateText = text;
    if (lastReport.pass && islandReport.pass && shoreReport.pass && shadowReport.pass && postReport.pass) {
      console.log('%cWORLD GATES PASS', 'background:#14707c;color:#ebedea;padding:2px 6px;border-radius:3px');
      console.log(text);
    } else {
      console.warn(text);
    }
    if (pose) {
      freeCam.restorePose(pose);
      test.setView('free');
      paintCamHud();
    } else {
      test.setView(params.view);
    }
    const p = test.camera.position;
    capturedCamera = params.view + ' (' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ',' + p.z.toFixed(0) + ')';
    paintOceanBanner(banner, lastReport);
    reportEl.textContent = 'view: ' + capturedCamera + '\n\n' + text;
  };

  engine.onResize((w, h) => {
    test.resize(w / h);
    runGate();
  });

  engine.onFrame((ctx) => {
    freeCam.update(ctx.dt);
    test.update(ctx.dt);
    if (params.view === 'cockpit') paintPilotHud();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && params.view === 'cockpit') test.seaplane.reset();
  });

  stillSetView = () => {
    test.setView(params.view);
    test.update(0);
  };

  // `?view=free` starts in the air. Applied after the gate wiring so the first runGate has
  // a pose to capture rather than enabling the camera mid-measurement.
  if (params.view === 'free') setView('free');
  if (params.view === 'cockpit') setView('cockpit');
}

engine.onFrame(() => {
  debug.beginFrame();
  debug.updateBudgetHud(engine.stats.world, engine.stats.dev, engine.stats.post);
  debug.endFrame();
});

if (stillMode) {
  runGate();
  // The probe renders both views; re-assert the requested one so the captured frame is
  // the one that was asked for, not whichever the probe happened to render last.
  stillSetView?.();
  engine.renderOnce();
  // The loop never runs in still mode, so the budget HUD would otherwise stay blank.
  debug.updateBudgetHud(engine.stats.world, engine.stats.dev, engine.stats.post);
} else {
  engine.start();
  runGate();
}

function paintBanner(el: HTMLDivElement, report: ReturnType<RampProbe['run']>): void {
  el.classList.toggle('is-fail', !report.pass);
  el.replaceChildren();

  const title = document.createElement('strong');
  title.textContent = 'Ramp gate — ' + (report.pass ? 'PASS' : 'FAIL');

  const bands = document.createElement('span');
  const okBands = report.spheres.filter((s) => s.bandsMatch && s.bandValuesMatch).length;
  bands.textContent = okBands + '/' + report.spheres.length + ' surfaces: band count + values correct';

  const edges = document.createElement('span');
  const worstEdge = report.spheres.reduce((m, s) => Math.max(m, s.maxTransitionPx), 0);
  edges.textContent = 'hardest-edge check: worst ramp transition ' + worstEdge + 'px · cast shadow ' + report.shadow.transitionPx + 'px';

  const horizon = document.createElement('span');
  horizon.className = 'gate-summary-hint';
  const cam = capturedCamera;
  horizon.textContent =
    'haze/sky convergence at horizon: delta ' + report.horizon.delta +
    (cam ? '  ·  camera ' + cam : '');

  el.append(title, bands, edges, horizon);
}

Object.assign(window as unknown as Record<string, unknown>, { engine, THREE });

function paintOceanBanner(el: HTMLDivElement, report: ReturnType<OceanProbe['run']>): void {
  el.classList.toggle('is-fail', !report.pass);
  el.replaceChildren();

  const title = document.createElement('strong');
  title.textContent = 'Ocean gate — ' + (report.pass ? 'PASS' : 'FAIL');

  const shelf = document.createElement('span');
  shelf.textContent =
    'shelf: max step ' + report.shelf.maxStepDelta + '/255 · plateau ' +
    Math.round(report.shelf.longestPlateauFraction * 100) + '% · wander ' +
    report.shelf.wanderPeakToPeakPx + 'px p2p';

  const glints = document.createElement('span');
  glints.textContent =
    'glints: ' + report.glints.coveragePct + '% coverage · ' + report.glints.elongationRatio + ':1 along swell';

  const budget = document.createElement('span');
  budget.className = 'gate-summary-hint';
  budget.textContent =
    report.triangles.toLocaleString() + ' tris / ' + report.drawCalls + ' draws · ' +
    'glints ' + report.altitude.coverageNearPct + '% near -> ' + report.altitude.coverageAt1500mPct + '% at 1500m' +
    (capturedCamera ? '  ·  camera ' + capturedCamera : '');

  el.append(title, shelf, glints, budget);
}
