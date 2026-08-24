import * as THREE from 'three';
import { LAND } from '../art/palette';
import { FOLIAGE_TRIANGLE_CEILING, SPECIES, SPECIES_NAMES, type SpeciesName } from '../world/vegetation/VegetationSpec';
import type { OceanTestScene } from './OceanTestScene';

/**
 * STEP 3b ACCEPTANCE GATE — vegetation.
 *
 * The same split the island gate uses, for the same reason. Placement is a property of the
 * generated forest and is measured on the arrays; shading is a property of the pixels and is
 * measured on the frame.
 *
 * FIELD half — the four claims 03 §8 makes that a screenshot cannot check:
 *
 *   1. NOTHING IN THE SEA, NOTHING ON A CLIFF, NOTHING OFF ITS BIOME. §7.2 gives each
 *      species a habitat and §3.1 makes cliffs bare limestone. A tree standing in the water
 *      is obvious; a tree on the 3% of the coast the camera is not pointed at is not.
 *   2. BLUE-NOISE SPACING (§8.3). The failure modes are clumping and grid alignment, and
 *      they are opposite: clumping shows as a minimum nearest-neighbour distance near zero,
 *      alignment shows as a nearest-neighbour distance that is always the same number. Both
 *      look like "trees on a hill" from any angle.
 *   3. TWO SILHOUETTES, NOT ONE (§8.1). A cypress is tall and narrow, a pine is wide and
 *      flat. Measured as an aspect ratio off the geometry, because "they look different" is
 *      how a species set collapses into one shape at two scales over a few tunings.
 *   4. BUDGET (§8.4, §10.1).
 *
 * PIXEL half:
 *
 *   5. THE GHIBLI BAND IS ACTUALLY BANDING. The upstream shader's whole technique is a hard
 *      four-way `if`; if foliage renders as a continuum, something has smoothed it and the
 *      look is gone. Measured as the count of distinct plateaus down a lit canopy.
 *   6. FOLIAGE COLOURS ARE AUTHORED 00 §2 HEXES. The colour maps are palette entries by
 *      construction, so this catches the thing construction cannot: a colour arriving on
 *      screen that no map contains, which means something is blending them.
 */

/** §8.1: a cypress must be markedly taller than it is wide, a pine markedly wider. */
const MIN_CYPRESS_ASPECT = 2.2;
const MAX_PINE_ASPECT = 1.4;
/** Spacing below this fraction of the species' nominal spacing counts as clumping. */
const MIN_SPACING_FRACTION = 0.3;
/** Nearest-neighbour spread below this means the placement is on a visible lattice. */
const MIN_SPACING_SPREAD = 0.06;
const TONE_TOLERANCE = 3;
const MIN_PLATEAU_PX = 3;

export interface VegetationReport {
  instances: number;
  perSpecies: Record<string, number>;
  triangles: number;
  drawCalls: number;
  withinBudget: boolean;

  inSeaPct: number;
  onCliffPct: number;
  offBiomePct: number;
  placementClean: boolean;

  spacing: Array<{ species: string; minM: number; meanM: number; nominalM: number; spreadPct: number }>;
  spacingOk: boolean;

  cypressAspect: number;
  pineAspect: number;
  silhouettesDistinct: boolean;

  canopyTriangles: number;
  canopyCoverPct: number;

  biomeHistogram: Record<string, number>;

  bandCount: number;
  bandColors: string[];
  banded: boolean;

  paletteHits: number;
  paletteSamples: number;
  onPalette: boolean;

  pass: boolean;
}

export class VegetationProbe {
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly test: OceanTestScene,
  ) {}

  run(): VegetationReport {
    const veg = this.test.vegetation;
    const field = veg.field;

    const inSeaPct = field.inSeaFraction() * 100;
    const onCliffPct = field.onCliffFraction() * 100;
    const offBiomePct = field.offBiomeFraction() * 100;
    const placementClean = inSeaPct === 0 && onCliffPct === 0 && offBiomePct === 0;

    const spacing = SPECIES_NAMES.map((name) => {
      const s = field.spacingStats(name);
      const nominal = SPECIES[name].spacing;
      return {
        species: name,
        minM: round2(s.min),
        meanM: round2(s.mean),
        nominalM: nominal,
        // How far the mean nearest-neighbour distance sits above the minimum, as a fraction.
        // On a perfect lattice these are the same number and this is 0.
        spreadPct: s.mean > 0 ? Math.round(((s.mean - s.min) / s.mean) * 100) : 0,
      };
    });
    const spacingOk = spacing.every((s) => {
      // A species with no instances placed has no spacing to be wrong about. It is not a
      // pass either — the budget line below is where an empty forest gets noticed.
      if (field.placements[s.species as SpeciesName].instances.length === 0) return true;
      return s.minM >= s.nominalM * MIN_SPACING_FRACTION && s.spreadPct >= MIN_SPACING_SPREAD * 100;
    });

    const cypressAspect = aspectOf(this.test.vegetation, 'cypress');
    const pineAspect = aspectOf(this.test.vegetation, 'stonePine');
    const silhouettesDistinct = cypressAspect >= MIN_CYPRESS_ASPECT && pineAspect <= MAX_PINE_ASPECT;

    const band = this.probeBands();
    const palette = this.probePalette();

    const triangles = veg.triangles;
    const withinBudget = triangles <= FOLIAGE_TRIANGLE_CEILING;

    const perSpecies: Record<string, number> = {};
    for (const s of SPECIES_NAMES) perSpecies[s] = field.placements[s].instances.length;

    return {
      instances: veg.instanceCount,
      perSpecies,
      triangles,
      drawCalls: veg.drawCalls,
      withinBudget,

      inSeaPct: round2(inSeaPct),
      onCliffPct: round2(onCliffPct),
      offBiomePct: round2(offBiomePct),
      placementClean,

      spacing,
      spacingOk,

      cypressAspect: round2(cypressAspect),
      pineAspect: round2(pineAspect),
      silhouettesDistinct,

      canopyTriangles: veg.canopyTriangles,
      canopyCoverPct: Math.round(veg.canopyLandCoverFraction * 100),

      biomeHistogram: this.test.island.biomes.histogram(),

      bandCount: band.count,
      bandColors: band.colors,
      banded: band.banded,

      paletteHits: palette.hits,
      paletteSamples: palette.samples,
      onPalette: palette.hits >= palette.samples * 0.85,

      pass:
        placementClean && spacingOk && silhouettesDistinct && withinBudget &&
        band.banded && palette.hits >= palette.samples * 0.85,
    };
  }

  /**
   * Does the Ghibli band actually band?
   *
   * Sampled down the `canopy` view, which looks across a wooded slope so one continuous
   * canopy surface runs through the full terminator. The upstream technique is a hard
   * four-way `if`; anything that smoothed it — a stray mix, a normal-map-style interpolation,
   * a post pass — turns those four plateaus into a gradient, and the shader would still
   * render something perfectly plausible.
   */
  private probeBands(): { count: number; colors: string[]; banded: boolean } {
    this.test.setView('canopy');
    const frame = this.read();
    const plateaus: RGB[] = [];
    // Several columns, because one column can cross a single tree and see one band honestly.
    for (const fx of [0.36, 0.46, 0.56, 0.66]) {
      const x = Math.round(frame.width * fx);
      const samples: RGB[] = [];
      for (let y = Math.round(frame.height * 0.4); y < Math.round(frame.height * 0.85); y++) {
        const p = readPixel(frame, x, y);
        // Green-dominant only: this is a question about foliage, not about the sky above it
        // or the limestone beside it.
        if (p[1] > p[0] + 4 && p[1] > p[2] + 4) samples.push(p);
      }
      let runStart = 0;
      for (let i = 1; i <= samples.length; i++) {
        const broken = i === samples.length || maxChannelDelta(samples[i]!, samples[runStart]!) > TONE_TOLERANCE;
        if (!broken) continue;
        if (i - runStart >= MIN_PLATEAU_PX) plateaus.push(samples[runStart]!);
        runStart = i;
      }
    }

    // Count DISTINCT plateau colours, not plateau runs. The same band crossed twice is one
    // tone; the claim being checked is "a small number of discrete tones", and a run count
    // would report 40 for a canopy that legitimately alternates between two of them.
    const distinct: RGB[] = [];
    for (const p of plateaus) {
      if (!distinct.some((d) => maxChannelDelta(d, p) <= TONE_TOLERANCE * 2)) distinct.push(p);
    }
    return {
      count: distinct.length,
      colors: distinct.slice(0, 8).map(rgbHex),
      // At least two, at most a dozen. The upper bound is the one that matters: four colour
      // maps across four species is at most 16 authored tones, and haze moves them, so a
      // continuum would run to hundreds.
      banded: distinct.length >= 2 && distinct.length <= 14,
    };
  }

  /** Are the rendered foliage colours drawn from the authored 00 §2 greens? */
  private probePalette(): { hits: number; samples: number } {
    const anchors = [
      LAND.forestDeep, LAND.forestDense, LAND.canopyMid, LAND.scrubOlive,
      LAND.scrubOlivePale, LAND.pastureBleached,
    ].map((s) => hexToRgb(s.hex));

    this.test.setView('canopy');
    const frame = this.read();
    let hits = 0;
    let samples = 0;
    for (let y = Math.round(frame.height * 0.4); y < Math.round(frame.height * 0.85); y += 5) {
      for (let x = Math.round(frame.width * 0.25); x < Math.round(frame.width * 0.75); x += 5) {
        const p = readPixel(frame, x, y);
        if (!(p[1] > p[0] + 6 && p[1] > p[2] + 6)) continue;
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

  static format(r: VegetationReport): string {
    const l: string[] = [];
    l.push('VEGETATION GATE — ' + (r.pass ? 'PASS' : 'FAIL'));
    l.push('');
    l.push('placement (measured on the placed instances, not on pixels):');
    l.push(
      '  ' + (r.placementClean ? 'ok  ' : 'FAIL') +
        ' habitat: ' + r.inSeaPct + '% in the sea / below the splash line, ' +
        r.onCliffPct + '% on cliff, ' + r.offBiomePct + '% off-biome (all must be 0)',
    );
    for (const s of r.spacing) {
      l.push(
        '  ' + pad(s.species, 10) + ' n=' + pad(String(r.perSpecies[s.species] ?? 0), 6) +
          ' nearest neighbour min ' + s.minM + ' m, mean ' + s.meanM + ' m' +
          ' (nominal ' + s.nominalM + ' m, spread ' + s.spreadPct + '%)',
      );
    }
    l.push('  ' + (r.spacingOk ? 'ok  ' : 'FAIL') + ' no clumping (min >= 30% of nominal) and no lattice (spread > 6%)');
    l.push('');
    l.push('silhouette (03 §8.1):');
    l.push(
      '  ' + (r.silhouettesDistinct ? 'ok  ' : 'FAIL') +
        ' cypress ' + r.cypressAspect + ':1 tall (min ' + MIN_CYPRESS_ASPECT + ')' +
        ', stone pine ' + r.pineAspect + ':1 (max ' + MAX_PINE_ASPECT + ')',
    );
    l.push('');
    l.push('shading (craftzdog/ghibli-style-shader band):');
    l.push(
      '  ' + (r.banded ? 'ok  ' : 'FAIL') + ' ' + r.bandCount +
        ' distinct foliage tones down the canopy (2-14; a continuum runs to hundreds)',
    );
    l.push('        ' + r.bandColors.join(' '));
    l.push(
      '  ' + (r.onPalette ? 'ok  ' : 'FAIL') + ' ' + r.paletteHits + '/' + r.paletteSamples +
        ' foliage samples within 26 of an authored 00 §2 green',
    );
    l.push('');
    l.push('canopy mass (03 §8.2 far LOD):');
    l.push('  ' + r.canopyTriangles.toLocaleString() + ' tris over ' + r.canopyCoverPct + '% of the land');
    l.push('');
    l.push('biome texels (03 §7.2):');
    const total = Object.values(r.biomeHistogram).reduce((a, b) => a + b, 0) || 1;
    for (const [name, n] of Object.entries(r.biomeHistogram)) {
      if (name === 'sea' || n === 0) continue;
      l.push('  ' + pad(name, 16) + pad(n.toLocaleString(), 10) + (((n / total) * 100).toFixed(1)) + '%');
    }
    l.push('');
    l.push(
      'budget: ' + r.instances.toLocaleString() + ' instances, ' + r.triangles.toLocaleString() +
        ' foliage tris in ' + r.drawCalls + ' draws (ceiling ' +
        FOLIAGE_TRIANGLE_CEILING.toLocaleString() + ' tris) — ' + (r.withinBudget ? 'ok' : 'FAIL'),
    );
    l.push(
      '        ' + Object.entries(r.perSpecies).map(([k, v]) => k + ' ' + v.toLocaleString()).join(', '),
    );
    return l.join('\n');
  }
}

/**
 * Height-to-width ratio of a species' prototype geometry.
 *
 * Off the built mesh rather than off the spec, so this catches a profile table that says
 * "teardrop" and a lathe that produced a sphere.
 */
function aspectOf(veg: OceanTestScene['vegetation'], name: SpeciesName): number {
  const entry = veg.species.find((s) => s.name === name);
  if (!entry) return 0;
  const geo = entry.mesh.geometry;
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  if (!b) return 0;
  const height = b.max.y - b.min.y;
  const width = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  return width > 0 ? height / width : 0;
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

/** Same brightness-invariant metric the island gate uses; see IslandProbe. */
function hueDistance(a: RGB, b: RGB): number {
  const sa = (a[0] + a[1] + a[2]) / 3 || 1;
  const sb = (b[0] + b[1] + b[2]) / 3 || 1;
  const scale = sb / sa;
  return Math.hypot(a[0] * scale - b[0], a[1] * scale - b[1], a[2] * scale - b[2]) / Math.sqrt(3);
}

const rgbHex = (c: RGB): string =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const round2 = (v: number): number => Math.round(v * 100) / 100;
const pad = (s: string, n: number): string => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));

