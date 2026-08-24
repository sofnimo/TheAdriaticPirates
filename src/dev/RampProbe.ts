import * as THREE from 'three';
import { SURFACES, type SurfaceName } from '../art/surfaces';
import { globalUniforms } from '../render/shading/ShadingUniforms';
import { RampTestScene, SPHERE_RADIUS } from './RampTestScene';

/**
 * STEP 1 ACCEPTANCE GATE.
 *
 * Reads back the rendered frame and measures the things the art bible actually asserts,
 * rather than trusting a screenshot to look about right:
 *
 *   1. BAND COUNT   — a scanline across each sphere resolves to exactly `rampSteps` flat
 *                     plateaus. If Lambert is leaking through, this comes back as dozens.
 *   2. BAND VALUES  — every plateau matches the colour the chunk's own maths predicts,
 *                     i.e. mix(base*0.82, shadowTint, 0.85) really is driving the shadow
 *                     band, not a darkened base.
 *   3. HARD EDGES   — plateau-to-plateau transitions are <= 2 px (00 §3 rules 1 and 3).
 *   4. CAST SHADOW  — the sphere's shadow on the ground has a hard edge and lands on the
 *                     ground's own shadow band.
 *   5. HORIZON      — ground at the horizon converges on the sky's HUE, proving the haze is
 *                     calling the live sky function and not a stale duplicate. Hue, not
 *                     colour: see HORIZON_MATCH_TOLERANCE.
 *
 * Reported as numbers, not adjectives: hue shift in degrees and the best-fit "is this just
 * a multiply?" residual are printed for every surface so the hue-shift rule can be
 * inspected rather than asserted.
 */

const PLATEAU_TOLERANCE = 3; // per-channel byte tolerance within one flat band
const MIN_PLATEAU_SAMPLES = 8; // 2% of RAMP_SAMPLE_COUNT
const MAX_TRANSITION_PX = 2;
const BAND_MATCH_TOLERANCE = 4;
/** Sample out to 95% of the radius. The rim term only engages past ~98% for every preset
 *  (rimPower >= 3), and the top band can be a thin crescent on the spheres furthest from
 *  the sun, so stopping short of this under-reports the band count. */
const RAMP_SAMPLE_FRACTION = 0.95;
/** Fixed sample count across the sphere, so thresholds are resolution-independent. */
const RAMP_SAMPLE_COUNT = 400;
/**
 * How close the ground's colour has to sit to the sky's at the horizon.
 *
 * Widened in Step 3, from 8 to 40, because the original number encoded a model the reference
 * frames contradict. Distant land does NOT converge fully on the sky: measured against the sky
 * immediately above each landmass, it holds a lightness 0.06-0.41 BELOW it
 * (plane-over-archipelago-wide, peninsula-coastline-aerial-clouds), which is what keeps a
 * silhouette readable at range. 0.06 of HSL lightness is already ~15/255, so a tolerance of 8
 * was demanding something no reference frame does.
 *
 * What this check is actually for is catching haze that lerps toward GREY instead of toward
 * the live sky — a hue failure. So the hue test below is the real assertion and this is a
 * loose sanity bound on how far apart the two may drift.
 */
const HORIZON_MATCH_TOLERANCE = 40;
/**
 * Degrees of hue the hazed ground may differ from the sky it is fading into.
 *
 * Only asserted when BOTH samples carry enough saturation for hue to mean anything. At the
 * horizon the haze has pulled both to within a few units of neutral, and the hue of a
 * near-grey is numerically unstable — #d1d7d5 and #ccd9de differ by 37 deg of nominal hue
 * while being visually the same off-white. Asserting on that would fail a correct
 * implementation for arithmetic reasons.
 */
const HORIZON_HUE_TOLERANCE = 12;
/** Below this chroma (max channel minus min, 0-255) hue is not a meaningful measurement. */
const HUE_MEANINGFUL_CHROMA = 18;

export type RGB = [number, number, number];

export interface Plateau {
  color: RGB;
  start: number;
  end: number;
  width: number;
}

export interface SphereResult {
  name: SurfaceName;
  label: string;
  expectedSteps: number;
  measuredBands: number;
  bandsMatch: boolean;
  maxTransitionPx: number;
  edgesHard: boolean;
  plateaus: Plateau[];
  predicted: RGB[];
  worstBandDelta: number;
  bandValuesMatch: boolean;
  /** Reported, not asserted — see note above. */
  litHueDeg: number;
  shadowHueDeg: number;
  hueShiftDeg: number;
  multiplyResidual: number;
  pass: boolean;
}

export interface ShadowResult {
  measured: boolean;
  transitionPx: number;
  edgeHard: boolean;
  litBand: RGB | null;
  shadowBand: RGB | null;
  pass: boolean;
}

export interface HorizonResult {
  measured: boolean;
  groundAtHorizon: RGB | null;
  skyAtHorizon: RGB | null;
  delta: number;
  hueDelta: number;
  hueComparable: boolean;
  pass: boolean;
}

export interface RampReport {
  spheres: SphereResult[];
  shadow: ShadowResult;
  horizon: HorizonResult;
  pass: boolean;
}

interface Framebuffer {
  data: Uint8Array;
  width: number;
  height: number;
}

export class RampProbe {
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly testScene: RampTestScene,
  ) {}

  /**
   * Renders the ramp view and the haze view in turn and measures both.
   * Restores the scene's original view before returning.
   */
  run(): RampReport {
    const originalView = this.testScene.viewName;

    // Haze is switched off for the ramp measurements, then measured on its own in the
    // horizon check. At 52 m the haze term lifts every band by ~0.01 linear, which is
    // correct behaviour but would smear an otherwise exact band-value comparison — and a
    // gate that has to allow slop is a gate that stops catching things.
    const hazeStrength = globalUniforms.uHazeStrength.value;
    globalUniforms.uHazeStrength.value = 0;

    this.testScene.setView('ramp');
    const rampFrame = this.renderAndRead();
    const spheres = this.testScene.spheres.map((s) => this.probeSphere(rampFrame, s.name, s.center));
    const shadow = this.probeShadowEdge(rampFrame);

    globalUniforms.uHazeStrength.value = hazeStrength;

    this.testScene.setView('haze');
    const hazeFrame = this.renderAndRead();
    const horizon = this.probeHorizon(hazeFrame);

    // Restore the view AND repaint it. Probing renders two views of its own; leaving the
    // last of them on screen would mean a "re-verify" click visibly jumps to the haze
    // camera, and in still mode it is the frame that gets captured.
    this.testScene.setView(originalView);
    this.testScene.update();
    this.renderer.render(this.testScene.scene, this.testScene.camera);

    const pass = spheres.every((s) => s.pass) && shadow.pass && horizon.pass;
    return { spheres, shadow, horizon, pass };
  }

  private renderAndRead(): Framebuffer {
    this.testScene.update();
    this.renderer.render(this.testScene.scene, this.testScene.camera);

    const gl = this.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width, height };
  }

  // ---------------------------------------------------------------- spheres

  private probeSphere(frame: Framebuffer, name: SurfaceName, center: THREE.Vector3): SphereResult {
    const preset = SURFACES[name];
    const camera = this.testScene.camera;

    const centerPx = project(center, camera, frame.width, frame.height);
    const edge = center.clone().add(cameraRight(camera).multiplyScalar(SPHERE_RADIUS));
    const edgePx = project(edge, camera, frame.width, frame.height);
    const radiusPx = Math.hypot(edgePx.x - centerPx.x, edgePx.y - centerPx.y);

    // Sample ALONG THE SCREEN-PROJECTED SUN AXIS, not horizontally. At the default
    // preset's azimuth the sun sits behind the spheres, so the lit band is a crescent at
    // the limb; a horizontal scanline misses it entirely and under-reports the band count.
    // The sun axis sweeps the full N.L range from terminator to brightest within the disc.
    const sunPoint = center.clone().addScaledVector(globalUniforms.uSunDirection.value, SPHERE_RADIUS);
    const sunPx = project(sunPoint, camera, frame.width, frame.height);
    let axis = { x: sunPx.x - centerPx.x, y: sunPx.y - centerPx.y };
    const axisLen = Math.hypot(axis.x, axis.y);
    // Degenerate only if the sun is exactly along the view axis; fall back to vertical.
    axis = axisLen > 1e-3 ? { x: axis.x / axisLen, y: axis.y / axisLen } : { x: 0, y: -1 };

    // Stop short of the silhouette: the rim term is a deliberate painted accent, not part
    // of the diffuse ramp being measured here.
    //
    // A FIXED sample count, not one sample per pixel. Sampling per-pixel makes every
    // threshold resolution-dependent: the top band is a thin crescent on the spheres
    // furthest from the sun, so the same scene passes at 1400x900 and fails at 1100x800
    // purely because that crescent fell under the minimum-plateau pixel count. A gate whose
    // verdict moves with the window size is not a gate.
    const halfSpan = radiusPx * RAMP_SAMPLE_FRACTION;
    const samples: RGB[] = [];
    for (let i = 0; i < RAMP_SAMPLE_COUNT; i++) {
      const t = (i / (RAMP_SAMPLE_COUNT - 1)) * 2 - 1; // -1 .. 1
      const d = t * halfSpan;
      samples.push(
        readPixel(frame, Math.round(centerPx.x + axis.x * d), Math.round(centerPx.y + axis.y * d)),
      );
    }
    // Samples -> pixels, so transition widths stay reported in real screen pixels.
    const pxPerSample = (2 * halfSpan) / (RAMP_SAMPLE_COUNT - 1);

    const { plateaus, maxTransition: maxTransitionSamples } = clusterPlateaus(samples);
    const maxTransition = Math.round(maxTransitionSamples * pxPerSample);

    // Predict every band from the chunk's own maths, in linear space, then encode to sRGB
    // exactly as colorspace_fragment does.
    const predicted = predictBands(name);
    const { worstDelta, matched } = matchPlateausToPredicted(plateaus, predicted);

    const litLinear = new THREE.Color(preset.baseColor);
    const shadowLinear = RampTestScene.predictShadowBand(name);
    const litHue = hueOf(litLinear);
    const shadowHue = hueOf(shadowLinear);

    const bandsMatch = plateaus.length === preset.rampSteps;
    const edgesHard = maxTransition <= MAX_TRANSITION_PX;

    return {
      name,
      label: preset.label,
      expectedSteps: preset.rampSteps,
      measuredBands: plateaus.length,
      bandsMatch,
      maxTransitionPx: maxTransition,
      edgesHard,
      plateaus,
      predicted,
      worstBandDelta: worstDelta,
      bandValuesMatch: matched,
      litHueDeg: litHue,
      shadowHueDeg: shadowHue,
      hueShiftDeg: angularDelta(litHue, shadowHue),
      multiplyResidual: multiplyResidual(litLinear, shadowLinear),
      pass: bandsMatch && edgesHard && matched,
    };
  }

  // ---------------------------------------------------------------- cast shadow

  private probeShadowEdge(frame: Framebuffer): ShadowResult {
    const camera = this.testScene.camera;
    const sphere = this.testScene.spheres[0];
    if (!sphere) return { measured: false, transitionPx: 0, edgeHard: false, litBand: null, shadowBand: null, pass: false };

    // Where the sphere's shadow lands on y = 0, along the sun direction.
    const sunDir = globalUniforms.uSunDirection.value;
    const t = sphere.center.y / Math.max(sunDir.y, 1e-3);
    const shadowCentre = sphere.center.clone().addScaledVector(sunDir, -t);

    const centerPx = project(shadowCentre, camera, frame.width, frame.height);
    const edge = shadowCentre.clone().add(cameraRight(camera).multiplyScalar(SPHERE_RADIUS * 2.2));
    const edgePx = project(edge, camera, frame.width, frame.height);
    const halfSpan = Math.floor(Math.abs(edgePx.x - centerPx.x));

    const samples: RGB[] = [];
    for (let dx = -halfSpan; dx <= halfSpan; dx++) {
      samples.push(readPixel(frame, Math.round(centerPx.x) + dx, Math.round(centerPx.y)));
    }

    const { plateaus, maxTransition } = clusterPlateaus(samples);
    // Expect: lit ground | shadow band | lit ground.
    const measured = plateaus.length >= 2;
    const edgeHard = maxTransition <= MAX_TRANSITION_PX;

    const sorted = [...plateaus].sort((a, b) => luma(b.color) - luma(a.color));
    const litBand = sorted[0]?.color ?? null;
    const shadowBand = sorted[sorted.length - 1]?.color ?? null;

    return {
      measured,
      transitionPx: maxTransition,
      edgeHard,
      litBand,
      shadowBand,
      pass: measured && edgeHard,
    };
  }

  // ---------------------------------------------------------------- horizon

  private probeHorizon(frame: Framebuffer): HorizonResult {
    const camera = this.testScene.camera;
    camera.updateMatrixWorld(true);

    // Screen row of the true horizon: the view direction with world y = 0.
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const horizonDir = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    const viewDir = horizonDir.clone().transformDirection(camera.matrixWorldInverse);

    const p = camera.projectionMatrix.elements;
    const clipY = (p[5] ?? 1) * viewDir.y;
    const clipW = -viewDir.z;
    if (Math.abs(clipW) < 1e-6) {
      return { measured: false, groundAtHorizon: null, skyAtHorizon: null, delta: 0, hueDelta: 0, hueComparable: false, pass: false };
    }
    const ndcY = clipY / clipW;
    const horizonY = (1 - ndcY) * 0.5 * frame.height;

    // Sample off-axis so the pillar row cannot land on the probe.
    const x = Math.round(frame.width * 0.25);
    const ground = readPixel(frame, x, Math.round(horizonY + 8));
    const sky = readPixel(frame, x, Math.round(horizonY - 8));
    const delta = maxChannelDelta(ground, sky);
    // Grey fog would diverge in hue however close the raw channel delta happened to land, so
    // hue is the assertion that actually distinguishes the two implementations — where it is
    // measurable at all. See HUE_MEANINGFUL_CHROMA.
    const chroma = Math.min(chromaOf(ground), chromaOf(sky));
    const hueComparable = chroma >= HUE_MEANINGFUL_CHROMA;
    const hueDelta = hueComparable ? hueDifference(ground, sky) : 0;

    return {
      measured: true,
      groundAtHorizon: ground,
      skyAtHorizon: sky,
      delta,
      hueDelta: Math.round(hueDelta * 10) / 10,
      hueComparable,
      pass: delta <= HORIZON_MATCH_TOLERANCE && (!hueComparable || hueDelta <= HORIZON_HUE_TOLERANCE),
    };
  }

  // ---------------------------------------------------------------- reporting

  static format(report: RampReport): string {
    const lines: string[] = [];
    lines.push('GOUACHE RAMP GATE — ' + (report.pass ? 'PASS' : 'FAIL'));
    lines.push('');
    lines.push('per-surface (scanline through sphere centre, rim margin excluded):');

    for (const s of report.spheres) {
      lines.push(
        '  ' + (s.pass ? 'ok  ' : 'FAIL') + ' ' + s.label.padEnd(24) +
          ' bands ' + s.measuredBands + '/' + s.expectedSteps +
          '  edge ' + s.maxTransitionPx + 'px' +
          '  worst band delta ' + s.worstBandDelta,
      );
      lines.push(
        '        plateaus ' + s.plateaus.map((pl) => rgbHex(pl.color)).join(' ') +
          '  predicted ' + s.predicted.map(rgbHex).join(' '),
      );
      lines.push(
        '        hue lit ' + s.litHueDeg.toFixed(0) + 'deg -> shadow ' + s.shadowHueDeg.toFixed(0) +
          'deg (shift ' + s.hueShiftDeg.toFixed(0) + 'deg), multiply-residual ' + s.multiplyResidual.toFixed(3),
      );
    }

    lines.push('');
    lines.push(
      'cast shadow: ' + (report.shadow.pass ? 'ok' : 'FAIL') +
        '  edge ' + report.shadow.transitionPx + 'px' +
        (report.shadow.litBand ? '  lit ' + rgbHex(report.shadow.litBand) : '') +
        (report.shadow.shadowBand ? '  shadow ' + rgbHex(report.shadow.shadowBand) : ''),
    );
    lines.push(
      'horizon convergence: ' + (report.horizon.pass ? 'ok' : 'FAIL') +
        '  ground ' + (report.horizon.groundAtHorizon ? rgbHex(report.horizon.groundAtHorizon) : '-') +
        '  sky ' + (report.horizon.skyAtHorizon ? rgbHex(report.horizon.skyAtHorizon) : '-') +
        '  delta ' + report.horizon.delta + ' (limit ' + HORIZON_MATCH_TOLERANCE + ')' +
        (report.horizon.hueComparable
          ? '  hue delta ' + report.horizon.hueDelta + ' deg (limit ' + HORIZON_HUE_TOLERANCE + ')'
          : '  hue not comparable (both samples near-neutral)'),
    );

    return lines.join('\n');
  }
}

// ------------------------------------------------------------------ helpers

function readPixel(frame: Framebuffer, x: number, yFromTop: number): RGB {
  const cx = Math.max(0, Math.min(frame.width - 1, x));
  const cy = Math.max(0, Math.min(frame.height - 1, yFromTop));
  const glRow = frame.height - 1 - cy;
  const i = (glRow * frame.width + cx) * 4;
  return [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
}

function project(world: THREE.Vector3, camera: THREE.Camera, width: number, height: number): { x: number; y: number } {
  const ndc = world.clone().project(camera);
  return { x: (ndc.x * 0.5 + 0.5) * width, y: (1 - (ndc.y * 0.5 + 0.5)) * height };
}

function cameraRight(camera: THREE.Camera): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
}

function clusterPlateaus(samples: RGB[]): { plateaus: Plateau[]; maxTransition: number } {
  const raw: Plateau[] = [];
  let start = 0;

  for (let i = 1; i <= samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const broken = i === samples.length || !cur || !prev || maxChannelDelta(cur, prev) > PLATEAU_TOLERANCE;
    if (broken) {
      const seg = samples.slice(start, i);
      const first = seg[0];
      if (first) raw.push({ color: meanColor(seg), start, end: i - 1, width: seg.length });
      start = i;
    }
  }

  const plateaus = raw.filter((p) => p.width >= MIN_PLATEAU_SAMPLES);

  let maxTransition = 0;
  for (let i = 1; i < plateaus.length; i++) {
    const gap = (plateaus[i]!.start - plateaus[i - 1]!.end - 1);
    maxTransition = Math.max(maxTransition, gap);
  }
  return { plateaus, maxTransition };
}

function meanColor(samples: RGB[]): RGB {
  const sum: RGB = [0, 0, 0];
  for (const s of samples) {
    sum[0] += s[0];
    sum[1] += s[1];
    sum[2] += s[2];
  }
  const n = Math.max(samples.length, 1);
  return [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)];
}

/** Every band the chunk can output, in sRGB bytes, for the default (identity-tint) preset. */
function predictBands(name: SurfaceName): RGB[] {
  const preset = SURFACES[name];
  const litLinear = new THREE.Color(preset.baseColor);
  const shadowLinear = RampTestScene.predictShadowBand(name);

  const bands: RGB[] = [];
  for (let k = 0; k < preset.rampSteps; k++) {
    const t = preset.rampSteps > 1 ? k / (preset.rampSteps - 1) : 1;
    const mixed = new THREE.Color().setRGB(
      THREE.MathUtils.lerp(shadowLinear.r, litLinear.r, t),
      THREE.MathUtils.lerp(shadowLinear.g, litLinear.g, t),
      THREE.MathUtils.lerp(shadowLinear.b, litLinear.b, t),
      THREE.LinearSRGBColorSpace,
    );
    const hex = mixed.getHex(THREE.SRGBColorSpace);
    bands.push([(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff]);
  }
  return bands;
}

/** Each measured plateau must correspond to one predicted band. */
function matchPlateausToPredicted(plateaus: Plateau[], predicted: RGB[]): { worstDelta: number; matched: boolean } {
  if (plateaus.length === 0) return { worstDelta: 255, matched: false };
  let worst = 0;
  for (const p of plateaus) {
    let best = 255;
    for (const q of predicted) best = Math.min(best, maxChannelDelta(p.color, q));
    worst = Math.max(worst, best);
  }
  return { worstDelta: worst, matched: worst <= BAND_MATCH_TOLERANCE };
}

function maxChannelDelta(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function luma(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

function rgbHex(c: RGB): string {
  return '#' + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hueOf(color: THREE.Color): number {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.h * 360;
}

function angularDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * How close the shadow tone is to being "the lit tone times a constant" — the thing
 * 00 §3 rule 2 forbids. 0 means it IS a pure multiply. Reported, never asserted: some
 * authored tints in 00 §2 (limestone especially) legitimately sit close to a multiply.
 */
function multiplyResidual(lit: THREE.Color, shadow: THREE.Color): number {
  const dot = lit.r * shadow.r + lit.g * shadow.g + lit.b * shadow.b;
  const lenSq = lit.r * lit.r + lit.g * lit.g + lit.b * lit.b;
  const k = lenSq > 1e-6 ? dot / lenSq : 0;
  return Math.sqrt(
    (shadow.r - k * lit.r) ** 2 + (shadow.g - k * lit.g) ** 2 + (shadow.b - k * lit.b) ** 2,
  );
}

/** Chroma as max channel minus min, 0-255. */
function chromaOf(c: RGB): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

/** Absolute hue difference in degrees, wrapped. */
function hueDifference(a: RGB, b: RGB): number {
  const h = (c: RGB): number => {
    const r = c[0] / 255, g = c[1] / 255, bl = c[2] / 255;
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), d = mx - mn;
    if (d < 1e-5) return 0;
    let deg: number;
    if (mx === r) deg = ((g - bl) / d) % 6;
    else if (mx === g) deg = (bl - r) / d + 2;
    else deg = (r - g) / d + 4;
    deg *= 60;
    return deg < 0 ? deg + 360 : deg;
  };
  let diff = Math.abs(h(a) - h(b));
  if (diff > 180) diff = 360 - diff;
  return diff;
}
