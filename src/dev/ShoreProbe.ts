import * as THREE from 'three';
import { globalUniforms } from '../render/shading/ShadingUniforms';
import type { OceanTestScene } from './OceanTestScene';

/**
 * STEP 4 ACCEPTANCE GATE.
 *
 * Split the same way Step 3's is, and for the same reason. The atlas is data, so it is checked
 * as data; the foam is pixels, so it is checked in pixels.
 *
 * ATLAS (measured on the baked arrays):
 *   1. SIGN        — the signed distance is negative exactly where the land mask says land.
 *                    This is the whole contract of an SDF and it is exactly checkable.
 *   2. DEPTH MATCH — the G channel equals the bathymetry's depth everywhere. 02b §9 makes
 *                    "single source of truth, no drift between the two docs" a checklist item.
 *   3. EXPOSURE    — the A channel actually separates headland from cove rather than coming
 *                    back flat, which is the failure mode of a badly chosen proxy.
 *   4. MEMORY      — 02b §7.2's 16 MB ceiling.
 *
 * FOAM (measured in pixels):
 *   5. PRESENT     — foam covers a real fraction of the near-shore water. A system that draws
 *                    nothing passes every quantisation check ever written.
 *   6. QUANTISED   — foam tones are drawn from a small set of flat values, not a gradient.
 *                    02b §2.2 and §9: never ship a raw smoothstep foam edge.
 *   7. CLAMPED     — no foam beyond the atlas's shore range; it hugs the coast.
 *   8. ALTITUDE    — 02b §2.4: the animated layer is gone by ~600 m and what remains is stable
 *                    frame to frame rather than crawling.
 */

const MIN_FOAM_COVERAGE = 0.08;
/**
 * Fraction of swash-zone pixels whose foam state must differ across most of a run-up cycle.
 *
 * Replaces an upper bound on coverage. Coverage came back at 100% and an upper bound was the
 * obvious response, but it is the wrong question: a solid band is fine at a framing where the
 * stripes are sub-pixel, and a ceiling would fail correct output for being viewed from the
 * wrong place. What 02b §2.1 actually asks for is that the swash SURGES AND RETREATS, and
 * that is a question about two moments in time, not about one frame's coverage.
 */
const MIN_SWASH_CHANGE = 0.1;
/**
 * Share of foam pixels that must fall inside the three most common tones.
 *
 * A COUNT of distinct tones cannot do this job, and two attempts proved it. Counting every
 * bucket reports 14 for a three-tone system because antialiasing blends foam with water along
 * every edge; filtering rare buckets out then reports 3 for a CONTINUOUS ramp too, because a
 * smooth gradient over a thin band spreads its colours so thinly that every bucket looks rare.
 * The negative control passed under both.
 *
 * Concentration separates them cleanly. Flat bands put nearly every pixel in a few spikes;
 * a gradient spreads them out however the buckets are drawn.
 */
const MIN_TONE_CONCENTRATION = 0.75;
const MIN_EXPOSURE_SPREAD = 0.35;
const MAX_ATLAS_BYTES = 16 * 1024 * 1024;
/** Pixels this close count as the same flat tone. Tight, so a ramp cannot hide inside one. */
const TONE_TOLERANCE = 4;

export interface ShoreReport {
  signMismatches: number;
  signOk: boolean;

  depthMismatches: number;
  depthOk: boolean;

  exposureMin: number;
  exposureMax: number;
  exposureSpread: number;
  exposureOk: boolean;

  atlasBytes: number;
  memoryOk: boolean;

  foamCoveragePct: number;
  foamPresent: boolean;

  foamTones: number;
  foamToneColors: string[];
  toneConcentration: number;
  foamQuantised: boolean;

  foamBeyondRangePx: number;
  foamClamped: boolean;

  swashSamples: number;
  swashChangePct: number;
  swashAnimates: boolean;

  foamAtAltitudePct: number;
  altitudeChangePct: number;
  altitudeOk: boolean;

  pass: boolean;
}

export class ShoreProbe {
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly test: OceanTestScene,
  ) {}

  run(): ShoreReport {
    // Haze off for every pixel measurement, exactly as Steps 1-3 do. It matters more here
    // than anywhere: haze pulls the whole frame toward a pale neutral, and foam is identified
    // BY being pale and neutral. With it on, the first run of this gate reported 100% foam
    // coverage and 17 distinct tones — it was measuring hazed water.
    const hazeStrength = globalUniforms.uHazeStrength.value;
    globalUniforms.uHazeStrength.value = 0;

    const atlas = this.test.shoreAtlas;
    const field = this.test.archipelago.field;
    const depthField = this.test.depthField;

    // --- atlas, on the arrays -------------------------------------------------------
    let signMismatches = 0;
    let depthMismatches = 0;
    let expMin = Infinity;
    let expMax = -Infinity;
    const n = atlas.resolution;
    const m = atlas.worldSize / n;
    const bytes = this.readAtlasBytes(atlas.texture);

    for (let iz = 0; iz < n; iz += 2) {
      for (let ix = 0; ix < n; ix += 2) {
        const i = iz * n + ix;
        const x = atlas.originX + ix * m;
        const z = atlas.originZ + iz * m;

        const isLand = field.land[i] === 1;
        const signed = atlas.signedDistance[i]!;
        // The zero texel itself is ambiguous by construction, so it is not a mismatch either
        // way; everything else must agree.
        if (signed !== 0 && isLand !== signed < 0) signMismatches++;

        if (bytes) {
          const g = bytes[i * 4 + 1]! / 255;
          const expected = depthField.depthAt(x, z);
          if (Math.abs(g - expected) > 2 / 255) depthMismatches++;
          const a = bytes[i * 4 + 3]! / 255;
          if (a < expMin) expMin = a;
          if (a > expMax) expMax = a;
        }
      }
    }
    if (!Number.isFinite(expMin)) { expMin = 0; expMax = 0; }

    // --- foam, in pixels ------------------------------------------------------------
    const near = this.probeFoamNear();
    const swash = this.probeSwashMotion();
    const altitude = this.probeFoamAltitude();

    globalUniforms.uHazeStrength.value = hazeStrength;

    const signOk = signMismatches === 0;
    const depthOk = depthMismatches === 0;
    const spread = expMax - expMin;
    const exposureOk = spread >= MIN_EXPOSURE_SPREAD;
    const memoryOk = atlas.bytes <= MAX_ATLAS_BYTES;
    const foamPresent = near.coverage >= MIN_FOAM_COVERAGE;
    const foamQuantised = near.tones > 0 && near.concentration >= MIN_TONE_CONCENTRATION;
    const foamClamped = near.beyondRange === 0;
    const swashAnimates = swash.changed >= MIN_SWASH_CHANGE;
    // At altitude the run-up layer is gone, so foam occupies a much smaller share of the
    // frame; and what is left must not move between frames.
    const altitudeOk = altitude.coverage < 0.05 && altitude.changed < 1;

    return {
      signMismatches,
      signOk,
      depthMismatches,
      depthOk,
      exposureMin: round2(expMin),
      exposureMax: round2(expMax),
      exposureSpread: round2(spread),
      exposureOk,
      atlasBytes: atlas.bytes,
      memoryOk,
      foamCoveragePct: round1(near.coverage * 100),
      foamPresent,
      foamTones: near.tones,
      foamToneColors: near.toneColors,
      toneConcentration: round2(near.concentration),
      foamQuantised,
      foamBeyondRangePx: near.beyondRange,
      foamClamped,
      swashSamples: swash.samples,
      swashChangePct: round1(swash.changed * 100),
      swashAnimates,
      foamAtAltitudePct: round1(altitude.coverage * 100),
      altitudeChangePct: round1(altitude.changed),
      altitudeOk,
      pass: signOk && depthOk && exposureOk && memoryOk && foamPresent && foamQuantised &&
        foamClamped && swashAnimates && altitudeOk,
    };
  }

  /**
   * Foam coverage and tone count on the near-shore water, from the `shore` view.
   *
   * Measured by DIFFERENCING two renders of the same frame, foam on and foam off, rather than
   * by classifying colours. Foam is pale and near-neutral; so is the sea ramp's shallow end and
   * so is limestone. Two colour-threshold attempts reported 100% and 92% coverage of water that
   * was mostly terrain before this was replaced. A difference has no threshold to get wrong:
   * a pixel is foam if and only if turning foam off changes it.
   *
   * Coverage is expressed against the SWASH ZONE — water within the run-up reach — not against
   * the atlas's whole 60 m range. Measured against the full range it read 1% for a band that
   * was working correctly: the run-up only reaches ~12 m, and on a low pass the remaining 48 m
   * fills most of the frame because it is the water nearest the camera. The number was mostly
   * reporting how much open water happened to be in shot.
   */
  private probeFoamNear(): { coverage: number; tones: number; toneColors: string[]; concentration: number; beyondRange: number } {
    // MEASURED AT RANGE, where the foam is a steady band.
    //
    // Foam now has two regimes: crest-gated up close, a continuous band far off. Coverage has
    // to be measured in the second one, and the reason is not convenience. Close in, whether a
    // given stretch of shore is foaming depends on where the crests happen to be at the instant
    // the frame is taken — and the shore view frames about 60 m of water against a 55-170 m
    // swell, so a single frame can legitimately contain no crest at all. That is what this
    // check was doing: it reported 0% coverage on a system whose foam a CPU model of the same
    // gates put at 40% of the windward nearshore, and which was plainly visible on screen. The
    // measurement was narrower than the thing it measured.
    //
    // Backed off, the band is steady and always there, so presence becomes a fact about the
    // island rather than about the shutter. Motion is checked separately, up close, where it
    // is the thing that matters.
    this.test.setView('shore');
    const camera = this.test.camera;
    const home = camera.position.clone();
    const target = this.test.shoreTarget.clone();
    camera.position.copy(target).addScaledVector(
      new THREE.Vector3().subVectors(home, target).normalize(), 750,
    );
    camera.position.y = 260;
    camera.lookAt(target);
    camera.updateMatrixWorld(true);

    const withFoam = this.read();
    this.setFoam(false);
    const without = this.read();
    this.setFoam(true);
    // The camera stays where it was rendered from until the pixels have been read back AND
    // mapped to world positions below — the raycast that does that mapping uses this camera,
    // so restoring it here would ray-trace the far frame through the near camera.

    const region = {
      x0: Math.round(withFoam.width * 0.05),
      x1: Math.round(withFoam.width * 0.72),
      y0: Math.round(withFoam.height * 0.35),
      y1: Math.round(withFoam.height * 0.95),
    };

    const atlas = this.test.shoreAtlas;
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();

    let inRange = 0;
    let foam = 0;
    let beyondRange = 0;
    const toneBuckets: Array<{ color: RGB; count: number }> = [];

    for (let y = region.y0; y <= region.y1; y += 2) {
      for (let x = region.x0; x <= region.x1; x += 2) {
        // Which world point is this pixel looking at, and is it inside the shore band?
        const ndc = new THREE.Vector2((x / withFoam.width) * 2 - 1, -((y / withFoam.height) * 2 - 1));
        ray.setFromCamera(ndc, camera);
        const onWater = ray.ray.intersectPlane(plane, hit) !== null;
        const d = onWater ? atlas.distanceAt(hit.x, hit.z) : Number.POSITIVE_INFINITY;
        const reach = this.test.shoreUniforms.uFoamReach!.value as number;
        const withinBand = onWater && d >= 0 && d <= reach;
        const withinAtlas = onWater && d >= 0 && d <= atlas.maxShoreDistance;
        void withinAtlas;

        const p = readPixel(withFoam, x, y);
        const q = readPixel(without, x, y);
        const changed = maxChannelDelta(p, q) > 3;

        // The ray hits the water plane wherever it is aimed, including through the island, so
        // a pixel showing a cliff face can still land inside the swash zone. Those pixels can
        // never foam and counting them as un-foamed water deflates the figure — measured, from
        // ~19% to 7%. Colour is used ONLY to exclude land here, never to identify foam: with
        // haze off the sea is strongly blue-dominant at every depth and the terrain is not.
        const looksLikeSea = q[2] > q[0] + 12 && q[2] >= q[1];
        if (withinBand && !looksLikeSea && !changed) continue;

        if (withinBand) inRange++;
        if (!changed) continue;

        if (withinBand) {
          foam++;
            const bucket = toneBuckets.find((t) => maxChannelDelta(t.color, p) <= TONE_TOLERANCE);
          if (bucket) bucket.count++;
          else toneBuckets.push({ color: p, count: 1 });
        } else if (d > atlas.maxShoreDistance + 4) {
          // Foam drawn on water that is out of range at all — a UV or clamp fault.
          beyondRange++;
        }
      }
    }

    toneBuckets.sort((a, b) => b.count - a.count);
    const top3 = toneBuckets.slice(0, 3).reduce((sum, t) => sum + t.count, 0);
    const concentration = foam > 0 ? top3 / foam : 0;

    // Now that the pixels have been mapped back to world positions, the camera can go home.
    camera.position.copy(home);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);

    return {
      coverage: inRange > 0 ? foam / inRange : 0,
      tones: toneBuckets.length,
      toneColors: toneBuckets.slice(0, 6).map((t) => rgbHex(t.color)),
      concentration,
      beyondRange,
    };
  }

  /**
   * Does the swash actually surge and retreat?
   *
   * Two renders roughly two-thirds of a run-up cycle apart, differenced over the swash zone.
   * A static gradient dressed up as an animation scores zero here however convincing one
   * frame of it looks.
   */
  private probeSwashMotion(): { samples: number; changed: number } {
    this.test.setView('shore');
    const t0 = this.test.waveTime;
    const a = this.read();
    // HALF A WAVE PERIOD, computed from the swell itself.
    //
    // This used to step one run-up cycle, which is the right clock for a swash band and the
    // wrong one for foam that rides the crests. A run-up cycle is about a second; the dominant
    // swell has a period of eight to ten, so stepping a second moved the crests a tenth of a
    // wavelength and the check reported 3% motion on foam that travels with the sea. Deriving
    // the step from the wave the foam is actually sitting on keeps it correct across sea
    // states, whose periods differ by a factor of two.
    const primary = this.test.ocean.dominantWavePeriod;
    this.test.setWaveTime(t0 + primary * 0.5);
    const b = this.read();
    this.test.setWaveTime(t0);

    const region = {
      x0: Math.round(a.width * 0.05),
      x1: Math.round(a.width * 0.72),
      y0: Math.round(a.height * 0.35),
      y1: Math.round(a.height * 0.95),
    };
    const camera = this.test.camera;
    const atlas = this.test.shoreAtlas;
    const reach = this.test.shoreUniforms.uFoamReach!.value as number;
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();

    let samples = 0;
    let changed = 0;
    for (let y = region.y0; y <= region.y1; y += 2) {
      for (let x = region.x0; x <= region.x1; x += 2) {
        const ndc = new THREE.Vector2((x / a.width) * 2 - 1, -((y / a.height) * 2 - 1));
        ray.setFromCamera(ndc, camera);
        if (!ray.ray.intersectPlane(plane, hit)) continue;
        const d = atlas.distanceAt(hit.x, hit.z);
        if (d < 0 || d > reach) continue;
        const pa = readPixel(a, x, y);
        if (!(pa[2] > pa[0] + 12 || maxChannelDelta(pa, readPixel(b, x, y)) > 6)) continue;
        samples++;
        if (maxChannelDelta(pa, readPixel(b, x, y)) > 6) changed++;
      }
    }
    return { samples, changed: samples > 0 ? changed / samples : 0 };
  }

  private setFoam(on: boolean): void {
    this.test.shoreUniforms.uFoamEnable!.value = on ? 1 : 0;
  }


  /**
   * 02b §2.4: past ~600 m the animated layer is gone and only a static stroke remains.
   *
   * Both halves matter and they fail differently. Coverage falling proves the run-up layer
   * actually retired; frame-to-frame stability proves what is left is a stroke rather than a
   * metre-scale band aliasing into crawling noise, which is the reason the doc retires it.
   */
  private probeFoamAltitude(): { coverage: number; changed: number } {
    this.test.setView('island');
    const withFoam = this.read();
    this.setFoam(false);
    const without = this.read();
    this.setFoam(true);

    let total = 0;
    let foam = 0;
    for (let y = 0; y < withFoam.height; y += 2) {
      for (let x = 0; x < withFoam.width; x += 2) {
        total++;
        if (maxChannelDelta(readPixel(withFoam, x, y), readPixel(without, x, y)) > 3) foam++;
      }
    }

    // Stability: what remains at altitude must be a static stroke, not a band crawling as the
    // wave clock advances. That is the whole reason 02b §2.4 retires the animated layer.
    const t0 = this.test.waveTime;
    this.test.setWaveTime(t0 + 1 / 60);
    const later = this.read();
    this.test.setWaveTime(t0);

    let changed = 0;
    for (let y = 0; y < withFoam.height; y += 2) {
      for (let x = 0; x < withFoam.width; x += 2) {
        if (maxChannelDelta(readPixel(withFoam, x, y), readPixel(later, x, y)) > 4) changed++;
      }
    }
    return { coverage: total > 0 ? foam / total : 0, changed: total > 0 ? (changed / total) * 100 : 0 };
  }

  /** Read the atlas's own bytes back, so the gate checks what was uploaded, not what was meant. */
  private readAtlasBytes(texture: THREE.DataTexture): Uint8Array | null {
    const image = texture.image as { data?: Uint8Array } | undefined;
    return image?.data instanceof Uint8Array ? image.data : null;
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

  static format(r: ShoreReport): string {
    const l: string[] = [];
    l.push('SHORE GATE — ' + (r.pass ? 'PASS' : 'FAIL'));
    l.push('');
    l.push('shore atlas (measured on the baked arrays):');
    l.push('  ' + (r.signOk ? 'ok  ' : 'FAIL') + ' signed distance: ' + r.signMismatches +
      ' texels where the sign disagrees with the land mask (must be 0)');
    l.push('  ' + (r.depthOk ? 'ok  ' : 'FAIL') + ' depth channel: ' + r.depthMismatches +
      ' texels differ from the bathymetry (must be 0 — 02b §9 single source of truth)');
    l.push('  ' + (r.exposureOk ? 'ok  ' : 'FAIL') + ' exposure channel spans ' +
      r.exposureMin + '-' + r.exposureMax + ' (spread ' + r.exposureSpread +
      ', min ' + MIN_EXPOSURE_SPREAD + ')');
    l.push('  ' + (r.memoryOk ? 'ok  ' : 'FAIL') + ' ' + (r.atlasBytes / 1024 / 1024).toFixed(2) +
      ' MB resident (02b §7.2 allows 16 MB across all islands)');
    l.push('');
    l.push('foam (low pass over the most exposed shore):');
    l.push('  ' + (r.foamPresent ? 'ok  ' : 'FAIL') + ' coverage ' + r.foamCoveragePct +
      '% of near-shore water (min ' + MIN_FOAM_COVERAGE * 100 + '%)');
    l.push('  ' + (r.foamQuantised ? 'ok  ' : 'FAIL') + ' tone concentration ' +
      Math.round(r.toneConcentration * 100) + '% of foam pixels in the top 3 tones (min ' +
      MIN_TONE_CONCENTRATION * 100 + '%), ' + r.foamTones + ' buckets total — 02b §2.2');
    l.push('        ' + r.foamToneColors.join(' '));
    l.push('  ' + (r.foamClamped ? 'ok  ' : 'FAIL') + ' ' + r.foamBeyondRangePx +
      ' foam samples beyond the atlas shore range (must be 0)');
    l.push('  ' + (r.swashAnimates ? 'ok  ' : 'FAIL') + ' swash motion: ' + r.swashChangePct +
      '% of ' + r.swashSamples + ' swash-zone samples change across a run-up cycle (min ' +
      MIN_SWASH_CHANGE * 100 + '%)');
    l.push('');
    l.push('altitude LOD (02b §2.4):');
    l.push('  ' + (r.altitudeOk ? 'ok  ' : 'FAIL') + ' foam ' + r.foamCoveragePct + '% near -> ' +
      r.foamAtAltitudePct + '% at altitude, ' + r.altitudeChangePct +
      '% of pixels change over one 60 Hz step');
    return l.join('\n');
  }
}

type RGB = [number, number, number];
interface Framebuffer { data: Uint8Array; width: number; height: number }

/** Sea water or foam on it — anything blue-green or near-neutral-pale, excluding land. */

/**
 * Foam, as distinct from the water under it.
 *
 * Keyed on the RED channel against the blue. Every colour on the sea ramp is a strongly
 * saturated blue-green whose red channel is very low — the whole ramp runs from #a2baa7 down
 * to #001e3a and red never rises far — while both foam tones (#ebedea, #b1cbd3) are pale and
 * near-neutral, with red within a short reach of blue.
 *
 * Measured with haze disabled, or this separation does not exist: haze lifts red on everything
 * and the two populations merge. That is not a hypothetical, it is what the first run of this
 * gate did.
 */

function readPixel(frame: Framebuffer, x: number, yFromTop: number): RGB {
  const cx = Math.max(0, Math.min(frame.width - 1, x));
  const cy = Math.max(0, Math.min(frame.height - 1, yFromTop));
  const i = ((frame.height - 1 - cy) * frame.width + cx) * 4;
  return [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
}

const maxChannelDelta = (a: RGB, b: RGB): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

const rgbHex = (c: RGB): string =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
