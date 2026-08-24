import * as THREE from 'three';
import { globalUniforms } from '../render/shading/ShadingUniforms';
import { OCEAN } from '../art/budgets';
import { GLINT_SHAPE } from '../art/seaRamp';
import type { OceanTestScene } from './OceanTestScene';

/**
 * STEP 2 ACCEPTANCE GATE.
 *
 * The numeric half of the step. The visual half — holding the shelf against the cove
 * reference and the glint field against the ambient-sparkle references — is a judgement call
 * made on screenshots, and deliberately not faked into a number here. What IS measurable:
 *
 *   1. SHELF SMOOTHNESS — the depth transition is a CONTINUOUS painted gradient. Gated on
 *                      zero plateau-then-jump events plus a bounded max per-pixel step.
 *                      Replaces the old band-count / band-edge-width checks, which were
 *                      gating for the opposite effect. On the reference, image-3.jpg's
 *                      water column runs mean 1.2/255 per row and max 2.8.
 *   2. ISO WANDER    — an iso-colour contour's path across many parallel scanlines has real
 *                      peak-to-peak variation. A perfect contour reads as a level-set
 *                      diagram, which 02 §2.2 calls out as its own failure mode. Smooth is
 *                      not the same as mechanical, and only this check separates them.
 *   3. GLINT COVER   — inside the envelope measured across every frame showing discrete
 *                      marks: 1.5% on mid-altitude open sea to 16.1% on image-4.jpg's near,
 *                      lively water. Density is per sea state, not one global target.
 *   4. GLINT SHAPE   — mean run length along the swell axis vs across it. 6.9:1 for light
 *                      marks and 8.5:1 for dark, mixed 4:1, so the combined figure is gated
 *                      on a window rather than a point.
 *   5. ALTITUDE      — glints fade out by 1500 m instead of aliasing into sparkle.
 *   6. STABILITY     — fraction of pixels that change over one 60 Hz step; a boiling noise
 *                      field shows up here even when a still frame looks fine.
 */

/** Two samples this close count as the same colour when hunting for flat runs. */
const PLATEAU_TOLERANCE = 2;
/**
 * PLATEAU-THEN-JUMP, the primary discriminator. A flat run of at least this many pixels
 * followed immediately by a step of at least MIN_BAND_CLIFF is a band edge, and any count
 * above zero fails the gate.
 *
 * Chosen over "longest plateau" and "max step" used alone, both of which the SOURCE MATERIAL
 * fails on a long transect: peninsula-coastline-aerial-clouds runs a 58 px flat stretch
 * (17% of its transect) out in open water where the depth stops changing, and steps 27/255
 * at its waterline. Neither is banding. Only the conjunction — flat, then a cliff — is.
 *
 * Verified both directions. Across seven transects in five reference frames (cove columns,
 * shore-perpendiculars, a shelf halo and flat open sea) this reads 0 every time. Quantising
 * the same cove column into 4, 5 and 8 bands reads 3, 4 and 7.
 */
const MIN_BAND_PLATEAU = 8;
const MIN_BAND_CLIFF = 8;
/**
 * Largest tolerated single-pixel jump once the waterline is excluded. Reference columns that
 * are pure water measure 2.8, 4.7 and 8.8; 10 covers that spread. Transects that cross a
 * shoreline measure 27-48, which is why the shore is skipped rather than tolerated.
 */
const MAX_STEP_DELTA = 10;
/** The transition must actually traverse some colour, or a flat sea would pass trivially. */
const MIN_SPAN_DELTA = 40;
const MIN_EDGE_WANDER_PX = 2;
const GLINT_DELTA = 12;

export type RGB = [number, number, number];

export interface ShelfResult {
  /** Length of the stretch of scanline over which the depth colour actually moves. */
  transitionPx: number;
  shallowEnd: RGB;
  deepEnd: RGB;
  /** Total colour travelled across the transition, max channel. */
  spanDelta: number;
  /** Largest single-pixel jump. A band edge shows up here as 20-60. */
  maxStepDelta: number;
  meanStepDelta: number;
  /** Longest run of near-identical pixels, and the same as a fraction of transitionPx. */
  longestPlateauPx: number;
  longestPlateauFraction: number;
  /** Plateau-then-jump events. The primary criterion: anything above zero is a band edge. */
  bandEdges: number;
  bandEdgeDetail: string[];
  /** Pixels of shoreline skipped before measuring — the placeholder beach, not the ramp. */
  shorelineSkipPx: number;
  smooth: boolean;
  wanderPeakToPeakPx: number;
  wanderStdDevPx: number;
  wanders: boolean;
  pass: boolean;
}

export interface GlintResult {
  coveragePct: number;
  inTargetRange: boolean;
  runAlongSwellPx: number;
  runAcrossSwellPx: number;
  elongationRatio: number;
  elongated: boolean;
  modalSeaColor: RGB;
  pass: boolean;
}

export interface AltitudeResult {
  /** Coverage on the near-water skim view — the framing image-4.jpg's figure came from. */
  coverageNearPct: number;
  coverageAt1500mPct: number;
  fadesWithAltitude: boolean;
  changedPixelsPct: number;
  stable: boolean;
  pass: boolean;
}

export interface OceanReport {
  shelf: ShelfResult;
  glints: GlintResult;
  altitude: AltitudeResult;
  triangles: number;
  drawCalls: number;
  withinTriangleBudget: boolean;
  withinDrawCallBudget: boolean;
  pass: boolean;
}

interface Framebuffer {
  data: Uint8Array;
  width: number;
  height: number;
}

export class OceanProbe {
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly test: OceanTestScene,
  ) {}

  run(): OceanReport {
    const originalView = this.test.viewName;
    const originalTime = this.test.waveTime;

    // Haze off for measurement, exactly as in Step 1: at these ranges it lifts colours by a
    // few units, which is correct on screen but would force every comparison to allow slop.
    const hazeStrength = globalUniforms.uHazeStrength.value;
    globalUniforms.uHazeStrength.value = 0;

    // Glints off while measuring the shelf. They are painted marks laid ON TOP of the depth
    // ramp and are measured separately below; leaving them on would put 40-unit cliffs at
    // every mark edge straight into the max-step figure the smoothness gate reads.
    // Order matters: setView() calls Ocean.update(), which recomputes uGlintFade from
    // camera altitude. Setting the uniform first would simply be overwritten.
    this.test.setView('shelf');
    const glintFade = this.test.ocean.uniforms.uGlintFade!.value as number;
    this.test.ocean.uniforms.uGlintFade!.value = 0;
    const shelf = this.probeShelf(this.renderAndRead());
    this.test.ocean.uniforms.uGlintFade!.value = glintFade;

    // Glints are measured on the SKIM view, not the top-down one: coverage is a pixel
    // fraction, so it only compares like-for-like against image-4.jpg at image-4's framing.
    this.test.setView('skim');
    const glintFrame = this.renderAndRead();
    const glints = this.probeGlints(glintFrame);

    const altitude = this.probeAltitude();

    globalUniforms.uHazeStrength.value = hazeStrength;

    // Leave the framebuffer showing the view the caller had.
    this.test.setView(originalView);
    this.test.setWaveTime(originalTime);
    this.renderer.render(this.test.scene, this.test.camera);

    const triangles = this.test.ocean.triangles;
    const drawCalls = this.test.ocean.rings.meshes.length;

    return {
      shelf,
      glints,
      altitude,
      triangles,
      drawCalls,
      withinTriangleBudget: this.test.ocean.withinTriangleBudget,
      withinDrawCallBudget: drawCalls <= OCEAN.maxDrawCalls,
      pass:
        shelf.pass && glints.pass && altitude.pass &&
        this.test.ocean.withinTriangleBudget && drawCalls <= OCEAN.maxDrawCalls,
    };
  }

  private renderAndRead(): Framebuffer {
    this.renderer.render(this.test.scene, this.test.camera);
    const gl = this.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width, height };
  }

  // ---------------------------------------------------------------- shelf

  private probeShelf(frame: Framebuffer): ShelfResult {
    // A vertical screen scanline crosses the shelf: deep at the bottom of frame, shallow at
    // the top, since the cove view looks shoreward.
    const x = Math.round(frame.width * 0.5);
    const yTop = Math.round(frame.height * 0.18);
    const yBottom = Math.round(frame.height * 0.95);

    const raw: RGB[] = [];
    for (let y = yTop; y <= yBottom; y++) raw.push(readPixel(frame, x, y));

    // Drop the landward placeholder and the waterline below it — see skipShoreline().
    const shoreSkip = skipShoreline(raw);
    const samples = raw.slice(shoreSkip);

    // Measure only the ACTIVE SPAN — the stretch where depth is actually changing. Open sea
    // past the shelf is legitimately a flat colour field (the reference does the same thing:
    // plane-skimming holds #025581 to within 1/255 over 180 px), and including it would
    // report a huge plateau for water that is behaving correctly. The span is bracketed at
    // the 5th and 95th percentile of cumulative colour change.
    const span = activeSpan(samples);
    const active = samples.slice(span.start, span.end + 1);

    const steps: number[] = [];
    for (let i = 1; i < active.length; i++) steps.push(maxChannelDelta(active[i]!, active[i - 1]!));
    const maxStep = steps.length ? Math.max(...steps) : 0;
    const meanStep = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;

    const longestPlateau = longestFlatRun(active, PLATEAU_TOLERANCE);
    const plateauFraction = active.length > 1 ? longestPlateau / active.length : 1;
    // Widest colour separation anywhere on the transect, not first-versus-last: a scanline
    // that runs deep -> shallow -> deep (crossing a shoal, say) travels a long way while
    // ending where it started, and endpoint subtraction would score that as a flat sea.
    const spanDelta = colorSpread(active);
    const bandEdges = findBandEdges(active);

    // Iso-contour wander: track where one FIXED COLOUR sits across many parallel scanlines.
    // With no band edges left there is no boundary to follow, so the continuous analogue is
    // a level set of the ramp. A contour driven purely by the bathymetry would be a smooth
    // curve; the noise on the depth signal should make it wobble at shape scale too.
    const isoColor = active[Math.floor(active.length / 2)]!;
    const contourRows: number[] = [];
    for (let sx = Math.round(frame.width * 0.25); sx < Math.round(frame.width * 0.75); sx += 3) {
      const row = findIsoRow(frame, sx, yTop, yBottom, isoColor);
      if (row !== null) contourRows.push(row);
    }

    const detrended = detrend(contourRows);
    const peakToPeak = detrended.length > 0 ? Math.max(...detrended) - Math.min(...detrended) : 0;
    const stdDev = standardDeviation(detrended);

    // Longest-plateau is reported but NOT gated: the reference material itself runs 5-17%
    // depending on how much flat open water a transect crosses. Banding is caught by the
    // plateau-then-jump count instead, which reads 0 on every reference transect.
    const smooth =
      bandEdges.count === 0 && maxStep <= MAX_STEP_DELTA && spanDelta >= MIN_SPAN_DELTA;
    const wanders = peakToPeak >= MIN_EDGE_WANDER_PX;

    return {
      transitionPx: active.length,
      shallowEnd: active[0] ?? [0, 0, 0],
      deepEnd: active[active.length - 1] ?? [0, 0, 0],
      spanDelta,
      maxStepDelta: maxStep,
      meanStepDelta: round1(meanStep),
      longestPlateauPx: longestPlateau,
      longestPlateauFraction: round1(plateauFraction * 100) / 100,
      bandEdges: bandEdges.count,
      bandEdgeDetail: bandEdges.detail,
      shorelineSkipPx: shoreSkip,
      smooth,
      wanderPeakToPeakPx: round1(peakToPeak),
      wanderStdDevPx: round1(stdDev),
      wanders,
      pass: smooth && wanders,
    };
  }

  // ---------------------------------------------------------------- glints

  private probeGlints(frame: Framebuffer): GlintResult {
    // Near-to-mid water only. A low pass spans 25 m to over a kilometre in one frame, so a
    // centre crop would average a dense near field against empty distance and report a
    // number that matches nothing. image-4's figure came from one 479x571 px region; this is
    // the equivalent band of this frame.
    const region = nearWaterRegion(frame);
    const modal = modalColor(frame, region);
    const mask = buildGlintMask(frame, region, modal);

    const total = region.w * region.h;
    let count = 0;
    for (let i = 0; i < mask.length; i++) count += mask[i]!;
    const coveragePct = (count / total) * 100;

    // Screen-space swell axis, from two world points along the swell direction.
    const axis = this.swellScreenAxis(frame);
    const perp = { x: -axis.y, y: axis.x };

    const runAlong = meanRunLength(mask, region.w, region.h, axis);
    const runAcross = meanRunLength(mask, region.w, region.h, perp);
    const ratio = runAcross > 0 ? runAlong / runAcross : 0;

    // Coverage is gated on the measured envelope across every frame that shows discrete
    // marks — 1.5% on mid-altitude open sea up to 16.1% on image-4's near, lively water —
    // not on budgets.ts's 3-6% (which restates 00 §2 from before that frame was measured).
    // Density is a per-sea-state property now, so a single absolute target would be wrong.
    const inTargetRange =
      coveragePct >= GLINT_SHAPE.coverageRange[0] * 100 &&
      coveragePct <= GLINT_SHAPE.coverageRange[1] * 100;
    // Marks must read as dashes. The window is the combined-population aspect: image-4's
    // light marks run 6.9:1 median and its dark marks 8.5:1, mixed roughly 4:1.
    const elongated = ratio >= GLINT_SHAPE.aspectRange[0] && ratio <= GLINT_SHAPE.aspectRange[1];

    return {
      coveragePct: round1(coveragePct),
      inTargetRange,
      runAlongSwellPx: round1(runAlong),
      runAcrossSwellPx: round1(runAcross),
      elongationRatio: round1(ratio),
      elongated,
      modalSeaColor: modal,
      pass: inTargetRange && elongated,
    };
  }

  private swellScreenAxis(frame: Framebuffer): { x: number; y: number } {
    const swell = this.test.ocean.uniforms.uSwellDir!.value as THREE.Vector2;
    const camera = this.test.camera;
    const centre = new THREE.Vector3(camera.position.x, 0, camera.position.z);
    const a = projectPoint(centre, camera, frame.width, frame.height);
    const b = projectPoint(
      new THREE.Vector3(centre.x + swell.x * 40, 0, centre.z + swell.y * 40),
      camera,
      frame.width,
      frame.height,
    );
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-3 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  }

  // ---------------------------------------------------------------- altitude / stability

  private probeAltitude(): AltitudeResult {
    // Near water, framed like image-4.jpg, against 1500 m. The reference frames put discrete
    // marks on near water only: image-4 16.1%, mid-altitude open sea 1.6%, and the two
    // high-altitude frames show none at all. So the fade being checked runs from a low pass
    // to altitude, not from 200 m to 1500 m — by 200 m the field is already mostly gone.
    this.test.setView('skim');
    const lowFrame = this.renderAndRead();
    const lowRegion = nearWaterRegion(lowFrame);
    const lowModal = modalColor(lowFrame, lowRegion);
    const lowCoverage = coverageOf(buildGlintMask(lowFrame, lowRegion, lowModal), lowRegion);

    this.test.setView('high');
    const highFrame = this.renderAndRead();
    const highRegion = centreRegion(highFrame);
    const highModal = modalColor(highFrame, highRegion);
    const highCoverage = coverageOf(buildGlintMask(highFrame, highRegion, highModal), highRegion);

    // Stability: advance the wave clock and see how much of the frame moves. Measured on the
    // SKIM view, where the glint field is fully active — that is where a boiling noise field
    // would show, and a higher view would pass simply because the marks had faded out.
    this.test.setView('skim');
    const t0 = this.test.waveTime;
    const stableFrameA = this.renderAndRead();
    this.test.setWaveTime(t0 + 1 / 60);
    const stableFrameB = this.renderAndRead();
    this.test.setWaveTime(t0);
    const changed = changedFraction(stableFrameA, stableFrameB, nearWaterRegion(stableFrameA));

    const fades = highCoverage < lowCoverage * 0.35;
    const stable = changed < 8;

    return {
      coverageNearPct: round1(lowCoverage),
      coverageAt1500mPct: round1(highCoverage),
      fadesWithAltitude: fades,
      changedPixelsPct: round1(changed),
      stable,
      pass: fades && stable,
    };
  }

  // ---------------------------------------------------------------- reporting

  static format(r: OceanReport): string {
    const lines: string[] = [];
    lines.push('OCEAN GATE — ' + (r.pass ? 'PASS' : 'FAIL'));
    lines.push('');
    lines.push('shelf smoothness (vertical scanline across the depth transition):');
    lines.push(
      '  ' + (r.shelf.pass ? 'ok  ' : 'FAIL') +
        ' band edges (plateau>=' + MIN_BAND_PLATEAU + 'px then step>=' + MIN_BAND_CLIFF + ') = ' +
        r.shelf.bandEdges + ' (must be 0)' +
        '   max step ' + r.shelf.maxStepDelta + '/255 (limit ' + MAX_STEP_DELTA + ')' +
        '   mean step ' + r.shelf.meanStepDelta,
    );
    for (const d of r.shelf.bandEdgeDetail) lines.push('        BAND EDGE: ' + d);
    lines.push(
      '        transition ' + r.shelf.transitionPx + 'px' +
        ' (after skipping ' + r.shelf.shorelineSkipPx + 'px of placeholder shore)' +
        '   longest plateau ' + r.shelf.longestPlateauPx + 'px = ' +
        Math.round(r.shelf.longestPlateauFraction * 100) + '% (reported, not gated)',
    );
    lines.push(
      '        span ' + rgbHex(r.shelf.shallowEnd) + ' -> ' + rgbHex(r.shelf.deepEnd) +
        ' = ' + r.shelf.spanDelta + '/255 (min ' + MIN_SPAN_DELTA + ')' +
        '   iso-contour wander ' + r.shelf.wanderPeakToPeakPx + 'px p2p (sd ' + r.shelf.wanderStdDevPx + 'px)',
    );
    lines.push('        reference, same metric: image-3 x=500 max 2.8 plateau 5%; peninsula max 27 plateau 17%; band edges 0 on both');
    lines.push('');
    lines.push('glint field (low pass over open water, framed like image-4.jpg):');
    lines.push(
      '  ' + (r.glints.pass ? 'ok  ' : 'FAIL') +
        ' coverage ' + r.glints.coveragePct + '% (frames: 1.5% mid-altitude to 16.1% image-4)' +
        '  run along swell ' + r.glints.runAlongSwellPx + 'px' +
        '  across ' + r.glints.runAcrossSwellPx + 'px' +
        '  ratio ' + r.glints.elongationRatio + ':1',
    );
    lines.push('        modal sea colour ' + rgbHex(r.glints.modalSeaColor));
    lines.push('');
    lines.push('altitude + stability:');
    lines.push(
      '  ' + (r.altitude.pass ? 'ok  ' : 'FAIL') +
        ' coverage near ' + r.altitude.coverageNearPct + '%' +
        ' -> 1500m ' + r.altitude.coverageAt1500mPct + '%' +
        '  pixels changed over one 60Hz step: ' + r.altitude.changedPixelsPct + '%',
    );
    lines.push('');
    lines.push(
      'budget: ' + r.triangles.toLocaleString() + ' tris in ' + r.drawCalls + ' draw calls' +
        ' (02 §6.1 allows ' + OCEAN.maxTriangles.toLocaleString() + ' / ' + OCEAN.maxDrawCalls + ') — ' +
        (r.withinTriangleBudget && r.withinDrawCallBudget ? 'ok' : 'OVER'),
    );
    return lines.join('\n');
  }
}

// ------------------------------------------------------------------ helpers

interface Region { x: number; y: number; w: number; h: number }

/** Lower band of the frame: the near-to-mid water on a low pass. */
function nearWaterRegion(frame: Framebuffer): Region {
  return {
    x: Math.round(frame.width * 0.14),
    y: Math.round(frame.height * 0.56),
    w: Math.round(frame.width * 0.72),
    h: Math.round(frame.height * 0.40),
  };
}

function centreRegion(frame: Framebuffer): Region {
  return {
    x: Math.round(frame.width * 0.12),
    y: Math.round(frame.height * 0.12),
    w: Math.round(frame.width * 0.5),
    h: Math.round(frame.height * 0.66),
  };
}

function readPixel(frame: Framebuffer, x: number, yFromTop: number): RGB {
  const cx = Math.max(0, Math.min(frame.width - 1, x));
  const cy = Math.max(0, Math.min(frame.height - 1, yFromTop));
  const i = ((frame.height - 1 - cy) * frame.width + cx) * 4;
  return [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
}

function projectPoint(p: THREE.Vector3, camera: THREE.Camera, w: number, h: number): { x: number; y: number } {
  const ndc = p.clone().project(camera);
  return { x: (ndc.x * 0.5 + 0.5) * w, y: (1 - (ndc.y * 0.5 + 0.5)) * h };
}

/**
 * The stretch of a scanline over which the depth colour is actually moving.
 *
 * Bracketed at the 5th and 95th percentile of cumulative colour change, so a flat
 * saturated open-sea run at either end is excluded. Without this the plateau metric would
 * penalise water that is behaving exactly like the reference: flat depth means flat colour.
 */
function activeSpan(samples: RGB[]): { start: number; end: number } {
  if (samples.length < 3) return { start: 0, end: Math.max(0, samples.length - 1) };
  const cumulative: number[] = [0];
  for (let i = 1; i < samples.length; i++) {
    cumulative.push(cumulative[i - 1]! + maxChannelDelta(samples[i]!, samples[i - 1]!));
  }
  const total = cumulative[cumulative.length - 1]!;
  if (total <= 0) return { start: 0, end: samples.length - 1 };
  const at = (frac: number) => {
    const target = total * frac;
    for (let i = 0; i < cumulative.length; i++) if (cumulative[i]! >= target) return i;
    return cumulative.length - 1;
  };
  const lo = at(0.05);
  const hi = at(0.95);
  return hi > lo + 2 ? { start: lo, end: hi } : { start: 0, end: samples.length - 1 };
}

/**
 * Longest run of samples all within `tol` of the run's FIRST sample.
 *
 * Note the definition: comparing each sample to its PREDECESSOR instead would score a slow
 * continuous gradient as one enormous plateau, since consecutive pixels of a smooth ramp
 * are also near-identical. Anchoring on the run's start is what makes this measure
 * flatness rather than slowness — the distinction the whole gate turns on.
 */
function longestFlatRun(samples: RGB[], tol: number): number {
  let longest = 0;
  let i = 0;
  while (i < samples.length) {
    let j = i + 1;
    while (j < samples.length && maxChannelDelta(samples[j]!, samples[i]!) <= tol) j++;
    longest = Math.max(longest, j - i);
    i = j;
  }
  return longest;
}

/** Widest per-channel spread across the whole transect. */
function colorSpread(samples: RGB[]): number {
  if (samples.length === 0) return 0;
  let spread = 0;
  for (let ch = 0; ch < 3; ch++) {
    let lo = 255;
    let hi = 0;
    for (const s of samples) {
      lo = Math.min(lo, s[ch]!);
      hi = Math.max(hi, s[ch]!);
    }
    spread = Math.max(spread, hi - lo);
  }
  return spread;
}

/**
 * Count plateau-then-jump events: a flat run of at least MIN_BAND_PLATEAU pixels followed
 * immediately by a step of at least MIN_BAND_CLIFF. This is what a quantiser produces and
 * what a painted gradient does not, and it is the criterion the gate actually turns on.
 *
 * Calibrated both ways before being trusted. Seven transects across five reference frames
 * read 0. The same cove column quantised to 4, 5 and 8 bands reads 3, 4 and 7.
 */
function findBandEdges(samples: RGB[]): { count: number; detail: string[] } {
  const detail: string[] = [];
  let i = 0;
  while (i < samples.length) {
    let j = i + 1;
    while (j < samples.length && maxChannelDelta(samples[j]!, samples[i]!) <= PLATEAU_TOLERANCE) j++;
    if (j - i >= MIN_BAND_PLATEAU && j < samples.length) {
      const step = maxChannelDelta(samples[j]!, samples[j - 1]!);
      if (step >= MIN_BAND_CLIFF) {
        detail.push(`${j - i}px flat then a ${step}/255 step at +${j}px`);
      }
    }
    i = j;
  }
  return { count: detail.length, detail };
}

/**
 * Skip the landward placeholder and the waterline below it.
 *
 * With no island geometry until Step 3, the shore side of the frame renders as a flat run of
 * the ramp's shallowest colour, and the waterline between it and real water is a hard edge.
 * That edge is correct — the reference frames' waterlines are hard too, stepping 19/255 in
 * the karst cove and 88/255 on the peninsula — but it belongs to the SHORE, not to the depth
 * ramp, and measuring it as part of the ramp is what put an 11/255 "max step" on a gradient
 * whose real maximum is 2.
 *
 * Deliberately narrow. It fires only when the scanline OPENS on a long flat run, which is the
 * placeholder's signature, and it never skips more than a third of the scanline. A band edge
 * in open water is preceded by another ramp colour, not by the run that starts at pixel zero,
 * so this cannot swallow the failure the gate exists to catch.
 */
function skipShoreline(samples: RGB[]): number {
  if (samples.length < 40) return 0;

  // Looser than PLATEAU_TOLERANCE on purpose: the landward region is not perfectly flat,
  // because the gouache ramp is still lighting wave normals across it and wobbles it by ~3.
  const SHORE_FLAT = 4;
  const SHORE_DESCENT = 3;

  let run = 1;
  while (run < samples.length && maxChannelDelta(samples[run]!, samples[0]!) <= SHORE_FLAT) run++;
  if (run < 20 || run >= samples.length - 1) return 0;

  // Walk to the far side of the descent rather than stopping on its first pixel, or the
  // steepest part of the waterline stays in the sample and dominates the max-step figure.
  let i = run;
  while (i + 1 < samples.length && maxChannelDelta(samples[i + 1]!, samples[i]!) > SHORE_DESCENT) i++;
  const limit = Math.floor(samples.length / 3);
  return i <= limit ? i : 0;
}

/** First row on this scanline whose colour matches `target` — a level set of the ramp. */
function findIsoRow(frame: Framebuffer, x: number, yTop: number, yBottom: number, target: RGB): number | null {
  let best: number | null = null;
  let bestDelta = PLATEAU_TOLERANCE + 2;
  for (let y = yTop; y <= yBottom; y++) {
    const d = maxChannelDelta(readPixel(frame, x, y), target);
    if (d < bestDelta) { bestDelta = d; best = y; }
  }
  return best;
}
/**
 * Remove the smooth large-scale trend so what's left is the wobble itself.
 * The boundary follows the bathymetry contour, which is legitimately curved; the question
 * is whether the noise-perturbed threshold adds wander ON TOP of that curve.
 */
function detrend(values: number[]): number[] {
  if (values.length < 5) return [];
  const window = Math.max(5, Math.round(values.length / 8) | 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -window; k <= window; k++) {
      const v = values[i + k];
      if (v !== undefined) {
        sum += v;
        n++;
      }
    }
    out.push(values[i]! - sum / Math.max(n, 1));
  }
  return out;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function modalColor(frame: Framebuffer, region: Region): RGB {
  const counts = new Map<number, number>();
  for (let y = region.y; y < region.y + region.h; y += 2) {
    for (let x = region.x; x < region.x + region.w; x += 2) {
      const [r, g, b] = readPixel(frame, x, y);
      // Quantise to 4-bit per channel so near-identical band pixels group together.
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  // Recover a representative colour by averaging pixels in the winning bucket.
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = region.y; y < region.y + region.h; y += 2) {
    for (let x = region.x; x < region.x + region.w; x += 2) {
      const [r, g, b] = readPixel(frame, x, y);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      if (key === bestKey) {
        sr += r; sg += g; sb += b; n++;
      }
    }
  }
  return n > 0 ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : [0, 0, 0];
}

/**
 * 1 where the pixel is a painted mark rather than sea.
 *
 * Classify by being LIGHTER than the dominant band, not merely different from it: the
 * gouache ramp only ever darkens a wave face toward the shadow tint, so "different" would
 * count every unlit wave slope as a glint. Only glints (and, weakly, sky fresnel — which is
 * near zero at these near-vertical view angles) push a pixel brighter.
 */
function buildGlintMask(frame: Framebuffer, region: Region, modal: RGB): Uint8Array {
  const mask = new Uint8Array(region.w * region.h);
  const modalLuma = luma(modal);
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const c = readPixel(frame, region.x + x, region.y + y);
      mask[y * region.w + x] = luma(c) - modalLuma > GLINT_DELTA ? 1 : 0;
    }
  }
  return mask;
}

function luma(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

function coverageOf(mask: Uint8Array, region: Region): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i]!;
  return (count / (region.w * region.h)) * 100;
}

/**
 * Mean run length measured THROUGH glint pixels: for a sample of set pixels, walk forward
 * and backward along the direction and total the contiguous run.
 *
 * Rays fired from the region border (the obvious implementation) undersample badly when the
 * marks are sparse — most rays miss everything, and the few hits dominate the average.
 */
function meanRunLength(mask: Uint8Array, w: number, h: number, dir: { x: number; y: number }): number {
  let total = 0;
  let samples = 0;
  const stride = 7; // subsample set pixels; runs are highly correlated locally

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] !== 1) continue;
      if ((x + y) % stride !== 0) continue;

      let run = 1;
      for (const sign of [1, -1]) {
        for (let k = 1; k < 200; k++) {
          const sx = Math.round(x + dir.x * k * sign);
          const sy = Math.round(y + dir.y * k * sign);
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) break;
          if (mask[sy * w + sx] !== 1) break;
          run++;
        }
      }
      total += run;
      samples++;
    }
  }
  return samples > 0 ? total / samples : 0;
}

function changedFraction(a: Framebuffer, b: Framebuffer, region: Region): number {
  let changed = 0;
  let total = 0;
  for (let y = region.y; y < region.y + region.h; y += 2) {
    for (let x = region.x; x < region.x + region.w; x += 2) {
      total++;
      if (maxChannelDelta(readPixel(a, x, y), readPixel(b, x, y)) > 8) changed++;
    }
  }
  return total > 0 ? (changed / total) * 100 : 0;
}


function maxChannelDelta(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function rgbHex(c: RGB): string {
  return '#' + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
