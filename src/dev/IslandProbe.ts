import * as THREE from 'three';
import { LAND } from '../art/palette';
import type { OceanTestScene } from './OceanTestScene';
import type { IslandField } from '../world/island/IslandField';

/**
 * STEP 3 ACCEPTANCE GATE.
 *
 * Two halves, and they check genuinely different things.
 *
 * The FIELD half runs on the baked arrays, not on pixels — silhouette anisotropy, flank
 * asymmetry and shore agreement are properties of the generated island, and measuring them
 * off a screenshot would only add a camera's worth of noise to a number that is already
 * exact. These are the three claims `03 — Procedural Islands.md` §0 makes about why karst
 * islands look the way they do, so they are the three things worth failing over.
 *
 *   1. ANISOTROPY  — the footprint is elongated on one axis (§0.1, §2.1). A radial blob is
 *                    the specific failure the skeleton-first construction exists to avoid,
 *                    and it is invisible in a three-quarter view.
 *   2. ASYMMETRY   — the seaward flank is steeper than the sheltered one (§0.2, §3.5). The
 *                    doc calls this "the single most important cliff rule".
 *   3. SHORE MATCH — the bathymetry's land mask and the terrain mesh agree everywhere. They
 *                    are supposed to be one array; this proves they still are.
 *
 * The PIXEL half checks that the shared shading contract survived contact with terrain:
 *
 *   4. STEPPED RAMP — the lit surface still resolves to discrete tones (00 §3 rule 1). A
 *                     terrain shader that quietly smooths the ramp would look fine and be
 *                     wrong.
 *   5. PALETTE      — rendered terrain colours are drawn from 00 §2's authored hexes.
 *   6. BUDGET       — 03 §10.1's 1.2 M triangles and 40 draw calls.
 */

/** 03 §0.1: real Dalmatian islands are long and thin, not radial. */
const MIN_ANISOTROPY = 2.0;
/** 03 §3.5: the exposed flank must be meaningfully steeper, not incidentally so. */
const MIN_FLANK_RATIO = 1.25;
const MAX_TRIANGLES = 1_200_000;
const MAX_DRAW_CALLS = 40;
/** Tones this close count as the same plateau when looking for the ramp's steps. */
const TONE_TOLERANCE = 3;
const MIN_PLATEAU_PX = 4;

export interface IslandReport {
  anisotropy: number;
  spanLongM: number;
  spanShortM: number;
  elongated: boolean;

  exposedSlope: number;
  shelteredSlope: number;
  flankRatio: number;
  asymmetric: boolean;

  shoreMismatches: number;
  shoreAgrees: boolean;

  toneCount: number;
  toneColors: string[];
  stepped: boolean;

  paletteHits: number;
  paletteSamples: number;
  onPalette: boolean;

  triangles: number;
  drawCalls: number;
  withinBudget: boolean;

  pass: boolean;
}

export class IslandProbe {
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly test: OceanTestScene,
  ) {}

  run(): IslandReport {
    const field = this.test.archipelago.field;

    // The hero's texels only. Anisotropy and flank asymmetry are claims about a LANDFORM;
    // run over the whole tile they would describe the lane layout instead.
    const { anisotropy, spanLongM, spanShortM } = measureAnisotropy(field);
    const flank = measureFlanks(field);
    const shoreMismatches = compareShore(field, this.test.depthField);

    const tone = this.probeTones();
    const palette = this.probePalette();

    const triangles = this.test.archipelago.triangles;
    // Engine sets renderer.info.autoReset = false so it can split world and dev-overlay
    // counters per frame, which means info.render.calls ACCUMULATES across every render the
    // probe has just done. Reading it directly reported 59 draw calls for a scene that draws
    // seven. Reset, render one frame, read that.
    this.renderer.info.reset();
    this.renderer.render(this.test.scene, this.test.camera);
    const drawCalls = this.renderer.info.render.calls;

    const elongated = anisotropy >= MIN_ANISOTROPY;
    const asymmetric = flank.ratio >= MIN_FLANK_RATIO;
    const shoreAgrees = shoreMismatches === 0;
    const withinBudget = triangles <= MAX_TRIANGLES && drawCalls <= MAX_DRAW_CALLS;

    return {
      anisotropy: round2(anisotropy),
      spanLongM: Math.round(spanLongM),
      spanShortM: Math.round(spanShortM),
      elongated,
      exposedSlope: round2(flank.exposed),
      shelteredSlope: round2(flank.sheltered),
      flankRatio: round2(flank.ratio),
      asymmetric,
      shoreMismatches,
      shoreAgrees,
      toneCount: tone.count,
      toneColors: tone.colors,
      stepped: tone.stepped,
      paletteHits: palette.hits,
      paletteSamples: palette.samples,
      onPalette: palette.hits >= palette.samples * 0.8,
      triangles,
      drawCalls,
      withinBudget,
      pass:
        elongated && asymmetric && shoreAgrees && tone.stepped &&
        palette.hits >= palette.samples * 0.8 && withinBudget,
    };
  }

  /**
   * Does the lit terrain still resolve to discrete tones?
   *
   * Sampled across a cliff face on the `profile` view, where one material runs continuously
   * through the full terminator. A smooth Lambert falloff gives a continuum; the gouache
   * ramp should give a handful of plateaus with hard edges between them.
   */
  private probeTones(): { count: number; colors: string[]; stepped: boolean } {
    this.test.setView('profile');
    const frame = this.read();
    const x = Math.round(frame.width * 0.5);
    const samples: RGB[] = [];
    for (let y = Math.round(frame.height * 0.45); y < Math.round(frame.height * 0.78); y++) {
      samples.push(readPixel(frame, x, y));
    }
    const plateaus: RGB[] = [];
    let runStart = 0;
    for (let i = 1; i <= samples.length; i++) {
      const broken = i === samples.length || maxChannelDelta(samples[i]!, samples[runStart]!) > TONE_TOLERANCE;
      if (!broken) continue;
      if (i - runStart >= MIN_PLATEAU_PX) plateaus.push(samples[runStart]!);
      runStart = i;
    }
    return {
      count: plateaus.length,
      colors: plateaus.slice(0, 8).map(rgbHex),
      // At least three distinguishable plateaus: strata beds plus the ramp's own steps.
      stepped: plateaus.length >= 3,
    };
  }

  /**
   * Are the rendered terrain colours drawn from 00 §2's authored land hexes?
   *
   * Sampled on the near-vertical `island` view with haze off, so what is measured is the
   * material's own output rather than the atmosphere's. The tolerance is loose because the
   * gouache ramp legitimately darkens toward a shadow tint and the strata blend between two
   * authored hexes; what this catches is a terrain shader inventing colours that are in no
   * palette entry at all.
   */
  private probePalette(): { hits: number; samples: number } {
    const anchors = [
      LAND.sand, LAND.limestoneLit, LAND.limestoneStrata, LAND.limestoneShadowDeep,
      LAND.scrubOlivePale, LAND.pastureDry, LAND.forestDense, LAND.forestSparse, LAND.scrubOlive,
    ].map((s) => hexToRgb(s.hex));

    this.test.setView('island');
    const frame = this.read();
    let hits = 0;
    let samples = 0;
    const y0 = Math.round(frame.height * 0.42);
    const y1 = Math.round(frame.height * 0.72);
    for (let y = y0; y < y1; y += 7) {
      for (let x = Math.round(frame.width * 0.1); x < Math.round(frame.width * 0.7); x += 7) {
        const p = readPixel(frame, x, y);
        // Skip sea and sky: this is a question about the land material.
        if (p[2] > p[1] + 18) continue;
        samples++;
        let best = Infinity;
        for (const a of anchors) best = Math.min(best, hueDistance(p, a));
        if (best <= 26) hits++;
      }
    }
    return { hits, samples: Math.max(samples, 1) };
  }

  private read(): Framebuffer {
    this.renderer.render(this.test.scene, this.test.camera);
    const gl = this.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width, height };
  }

  static format(r: IslandReport): string {
    const l: string[] = [];
    l.push('ISLAND GATE — ' + (r.pass ? 'PASS' : 'FAIL'));
    l.push('');
    l.push('footprint (measured on the baked field, not on pixels):');
    l.push(
      '  ' + (r.elongated ? 'ok  ' : 'FAIL') +
        ' anisotropy ' + r.anisotropy + ':1 (min ' + MIN_ANISOTROPY + ')' +
        '  ' + r.spanLongM + ' m along the spine x ' + r.spanShortM + ' m across',
    );
    l.push(
      '  ' + (r.asymmetric ? 'ok  ' : 'FAIL') +
        ' flank asymmetry ' + r.flankRatio + ':1 (min ' + MIN_FLANK_RATIO + ')' +
        '  seaward slope ' + r.exposedSlope + ' vs sheltered ' + r.shelteredSlope,
    );
    l.push(
      '  ' + (r.shoreAgrees ? 'ok  ' : 'FAIL') +
        ' shore agreement: ' + r.shoreMismatches + ' texels where the terrain mask and the' +
        ' bathymetry disagree (must be 0)',
    );
    l.push('');
    l.push('shading contract:');
    l.push(
      '  ' + (r.stepped ? 'ok  ' : 'FAIL') +
        ' ' + r.toneCount + ' discrete tones across the cliff terminator (min 3)',
    );
    l.push('        ' + r.toneColors.join(' '));
    l.push(
      '  ' + (r.onPalette ? 'ok  ' : 'FAIL') +
        ' ' + r.paletteHits + '/' + r.paletteSamples + ' land samples within 26 of an' +
        ' authored 00 §2 hex',
    );
    l.push('');
    l.push(
      'budget: ' + r.triangles.toLocaleString() + ' island tris, ' + r.drawCalls +
        ' draw calls (03 §10.1 allows ' + MAX_TRIANGLES.toLocaleString() + ' / ' +
        MAX_DRAW_CALLS + ') — ' + (r.withinBudget ? 'ok' : 'OVER'),
    );
    return l.join('\n');
  }
}

// ------------------------------------------------------------------ field measurements

/**
 * Principal-axis analysis of the land mask.
 *
 * The ratio of the two principal standard deviations is the elongation. This is the number
 * that separates a Dalmatian ridge-island from a Perlin blob, and it cannot be faked by a
 * flattering camera angle because it never looks at a camera.
 */
function measureAnisotropy(field: IslandField): { anisotropy: number; spanLongM: number; spanShortM: number } {
  let n = 0;
  let mx = 0;
  let mz = 0;
  for (let iz = 0; iz < field.resolution; iz++) {
    for (let ix = 0; ix < field.resolution; ix++) {
      const i = iz * field.resolution + ix;
      if (field.land[i] !== 1 || field.owner[i] !== 0) continue;
      mx += ix; mz += iz; n++;
    }
  }
  if (n < 8) return { anisotropy: 0, spanLongM: 0, spanShortM: 0 };
  mx /= n; mz /= n;

  let sxx = 0; let szz = 0; let sxz = 0;
  for (let iz = 0; iz < field.resolution; iz++) {
    for (let ix = 0; ix < field.resolution; ix++) {
      const i = iz * field.resolution + ix;
      if (field.land[i] !== 1 || field.owner[i] !== 0) continue;
      const dx = ix - mx; const dz = iz - mz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
  }
  sxx /= n; szz /= n; sxz /= n;
  const tr = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(tr / 2 - disc, 1e-6);
  const long = 4 * Math.sqrt(l1) * field.metresPerSample;
  const short = 4 * Math.sqrt(l2) * field.metresPerSample;
  return { anisotropy: Math.sqrt(l1 / l2), spanLongM: long, spanShortM: short };
}

/**
 * Steepness of the seaward flank versus the sheltered one — 03 §3.5.
 *
 * Measured in the COASTAL BAND — samples between 2 m and 50 m of elevation — because that is
 * where §3.5's asymmetry lives: the seaward margin is cliffed, the sheltered margin runs out
 * gently to the shore.
 *
 * Two earlier metrics both failed here, and both were wrong for instructive reasons. The mean
 * slope over the whole flank cannot work: both flanks drop the same total height over roughly
 * the same width, so their means are near-identical whatever the cross-section. The
 * 90th-percentile slope over the whole flank is worse than useless — it reports the SHELTERED
 * flank as steeper, because the cultivation terraces of §5.3 are cut into that flank and every
 * terrace riser is a near-vertical step. Restricting to the coastal band sidesteps both: it is
 * below the terraced zone and it is exactly the ground the rule is about.
 */
function measureFlanks(field: IslandField): { exposed: number; sheltered: number; ratio: number } {
  const n = field.resolution;
  const step = field.metresPerSample;
  const exposedSlopes: number[] = [];
  const shelteredSlopes: number[] = [];

  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const i = iz * n + ix;
      if (field.land[i] !== 1 || field.owner[i] !== 0) continue;
      const h = field.height[i]!;
      if (h < 2 || h > 50) continue;
      const dhx = (field.height[i + 1]! - field.height[i - 1]!) / (2 * step);
      const dhz = (field.height[i + n]! - field.height[i - n]!) / (2 * step);
      const slope = Math.hypot(dhx, dhz);
      const e = field.exposure[i]!;
      if (e > 0.25) exposedSlopes.push(slope);
      else if (e < -0.25) shelteredSlopes.push(slope);
    }
  }
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const exposed = mean(exposedSlopes);
  const sheltered = Math.max(mean(shelteredSlopes), 1e-6);
  return { exposed, sheltered, ratio: exposed / sheltered };
}

/**
 * Do the terrain's land mask and the bathymetry's land mask agree?
 *
 * They are built from the same callback, so the answer should be an unqualified zero. This
 * exists because "should be" is how the two coastlines drift apart the moment someone caches
 * one of them, and 02b §1.2 makes their agreement a requirement rather than a nicety.
 */
function compareShore(field: IslandField, depthField: { isLand(x: number, z: number): boolean }): number {
  let mismatches = 0;
  const stride = 4;
  for (let iz = 0; iz < field.resolution; iz += stride) {
    const z = field.originZ + iz * field.metresPerSample;
    for (let ix = 0; ix < field.resolution; ix += stride) {
      const x = field.originX + ix * field.metresPerSample;
      const terrainLand = field.land[iz * field.resolution + ix] === 1;
      // Compare MASKS, not depths. Depth 0 does not uniquely mean land — the contour wander
      // can drive a shallow water texel to zero distance-from-shore, and inferring land from
      // depth reported 163 disagreements for a coastline both systems read from one callback.
      if (terrainLand !== depthField.isLand(x, z)) mismatches++;
    }
  }
  return mismatches;
}

// ------------------------------------------------------------------ pixel helpers

type RGB = [number, number, number];
interface Framebuffer { data: Uint8Array; width: number; height: number }

function readPixel(frame: Framebuffer, x: number, yFromTop: number): RGB {
  const cx = Math.max(0, Math.min(frame.width - 1, x));
  const cy = Math.max(0, Math.min(frame.height - 1, yFromTop));
  const i = ((frame.height - 1 - cy) * frame.width + cx) * 4;
  return [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
}

const maxChannelDelta = (a: RGB, b: RGB): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

const hexToRgb = (hex: number): RGB => [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];

/**
 * Distance that ignores overall brightness.
 *
 * The gouache ramp legitimately moves a surface up and down in value; what identifies an
 * authored hex is its hue and its relative channel balance. Comparing raw RGB would fail
 * every shadowed sample of a colour that is unambiguously on the palette.
 */
function hueDistance(a: RGB, b: RGB): number {
  const sa = (a[0] + a[1] + a[2]) / 3 || 1;
  const sb = (b[0] + b[1] + b[2]) / 3 || 1;
  const scale = sb / sa;
  return Math.hypot(a[0] * scale - b[0], a[1] * scale - b[1], a[2] * scale - b[2]) / Math.sqrt(3);
}

const rgbHex = (c: RGB): string =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const round2 = (v: number): number => Math.round(v * 100) / 100;
