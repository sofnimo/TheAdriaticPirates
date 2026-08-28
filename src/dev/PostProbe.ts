import * as THREE from 'three';
import { ALL_SWATCHES, hexBytes, SKY } from '../art/palette';
import { LIGHT } from '../art/budgets';
import { POST, POST_SABOTAGE, checkPostContract, linearLuminanceOfHex } from '../art/post';
import { checkRendererContract } from '../app/RendererConfig';
import type { PostChain } from '../render/post/PostChain';

/**
 * STEP 6 ACCEPTANCE GATE — the post chain and the grading lock.
 *
 * WHY THIS PROBE BUILDS ITS OWN SCENE INSTEAD OF MEASURING THE WORLD.
 *
 * Every other gate here measures the thing it is about: the ocean gate measures the sea,
 * the island gate measures the island. A post chain is not about any of them — it is a
 * transfer function from a frame to a frame, and measuring it on the world view would
 * make every number depend on where the camera happened to be pointing. Worse, the two
 * claims that matter most cannot be posed at all on a world frame: "the palette survives
 * the chain byte-for-byte" needs a known input hex per pixel, and "only the sun disc
 * crosses the bloom threshold" needs a controlled brightest object with known neighbours.
 *
 * So the probe renders a calibration card — every authored palette hex as a flat patch,
 * plus one small patch that writes 4.0 linear where the sky dome's sun disc would — and
 * pushes THAT through the real composer. The input is known exactly, so the output can be
 * compared exactly, and there is no camera to flatter the result.
 *
 * WHAT IS MEASURED
 *
 *   1. ORDER        — the built chain read back against 04 §7.1's order, as data.
 *   2. GRADING LOCK — with bloom/grain/vignette off, every authored hex must survive the
 *                     half-float composer round-trip and OutputPass's encode EXACTLY. This
 *                     is the check that catches a double sRGB conversion, a tone-mapping
 *                     operator leaking into OutputPass, or an 8-bit intermediate buffer.
 *   3. BLOOM        — with bloom on, no palette patch may change (04 §4.1: the brightest
 *                     authored colour is below threshold), while the 4.0-linear patch must.
 *                     Both halves measured; the second is what proves the check has teeth.
 *   4. GRAIN        — static frame to frame (rule 8 says static, 04 §7.3's snippet crawls),
 *                     within 04 §8.2's amplitude ceiling, and achromatic.
 *   5. CHROMA       — moves colour without moving brightness: per-channel spread > 0 while
 *                     mean display luma is unchanged.
 *   6. VIGNETTE     — nothing at all inside 75% of the corner radius, 6-8% at the corner.
 *
 * Each is measured with the other passes OFF. That is the same discipline the ocean gate
 * uses when it disables glints to measure the depth ramp: a gate forced to allow slop for
 * a neighbouring effect is a gate that has stopped catching things.
 */

// ---------------------------------------------------------------- tolerances

/** +/-1 of 255 is float rounding; above that the grade has moved a colour. */
const GRADE_TOLERANCE = 1;
/** Bloom is allowed to shift a below-threshold patch by this much and no more. */
const BLOOM_LEAK_TOLERANCE = 1;
/** The sun patch must brighten its surroundings by at least this, or bloom is doing nothing. */
const BLOOM_MIN_EFFECT = 6;
/** Display-space luma the chroma wobble may move, in bytes. Above this it is a brightness effect. */
const CHROMA_LUMA_TOLERANCE = 1.0;
/** Vignette must not touch anything inside the falloff radius. */
const VIGNETTE_INNER_TOLERANCE = 1;

/** The calibration card's sun stand-in, in LINEAR light. The sky dome's disc writes ~1.0
 *  over the sky gradient; 4.0 puts it unambiguously past any threshold in 04 §8.2's range. */
const SUN_PATCH_LINEAR = 4.0;

/** The card's full-frame backdrop: the brightest authored colour in the palette
 *  (#ebedea, cloud lit). See the note on build() for why the card is not black. */
const BACKDROP_HEX = SKY.cloudLit.hex;

export type RGB = [number, number, number];

export interface OrderResult {
  actual: string[];
  violations: string[];
  pass: boolean;
}

export interface GradeResult {
  total: number;
  exact: number;
  withinTolerance: number;
  worstDelta: number;
  worstName: string;
  /** Renderer + authored-value contract violations found at verify time. */
  contractViolations: string[];
  pass: boolean;
}

export interface BloomResult {
  measured: boolean;
  /** Largest change bloom made to any below-threshold palette patch. Must be ~0. */
  worstPaletteDelta: number;
  worstPaletteName: string;
  /** Change bloom made beside the 4.0-linear patch. Must be clearly non-zero. */
  sunHaloDelta: number;
  /** The brightest authored hex and its linear luminance, against the threshold. */
  brightestHex: number;
  brightestName: string;
  brightestLinearLuma: number;
  threshold: number;
  headroom: number;
  /** Negative control: at POST_SABOTAGE.bloomThreshold the palette MUST bloom. */
  sabotageDelta: number;
  sabotageDetected: boolean;
  pass: boolean;
}

export interface GrainResult {
  measured: boolean;
  /** Bytes differing between two consecutive renders. Must be 0 — rule 8 says static. */
  changedPixelsBetweenFrames: number;
  isStatic: boolean;
  /** Negative control: with ?grain=animated the same comparison must find differences. */
  animatedChangedPixels: number;
  animationDetected: boolean;
  peakAmplitude: number;
  rmsAmplitude: number;
  ceilingBytes: number;
  withinCeiling: boolean;
  /** Grain is one value on all three channels, so per-pixel channel spread must be ~0. */
  maxChannelSpread: number;
  achromatic: boolean;
  pass: boolean;
}

export interface ChromaResult {
  measured: boolean;
  /** Mean display-space luma change over a flat patch. Must be ~0. */
  meanLumaDelta: number;
  /** Mean absolute per-channel change. Must be > 0, or the wobble is doing nothing. */
  meanChannelDelta: number;
  lumaNeutral: boolean;
  pass: boolean;
}

export interface VignetteResult {
  measured: boolean;
  /** Largest change inside falloffStart * cornerRadius. Must be ~0. */
  innerDelta: number;
  /** Measured corner darkening, as a fraction. */
  cornerDarkening: number;
  withinRange: boolean;
  innerClean: boolean;
  pass: boolean;
}

export interface PostReport {
  order: OrderResult;
  grade: GradeResult;
  bloom: BloomResult;
  grain: GrainResult;
  chroma: ChromaResult;
  vignette: VignetteResult;
  pass: boolean;
}

interface Framebuffer {
  data: Uint8Array;
  width: number;
  height: number;
}

interface Patch {
  name: string;
  hex: number;
  /** Normalised, y DOWN (CSS convention), matching PaletteSwatchGate. */
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------- the probe

export class PostProbe {
  /** The calibration card. Owned here; never added to the world scene. */
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);

  private readonly patches: Patch[] = [];
  private sunPatch: Patch;
  private readonly quad = new THREE.PlaneGeometry(1, 1);
  private readonly materials: THREE.Material[] = [];

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly post: PostChain,
  ) {
    this.scene.background = new THREE.Color(0x000000);
    this.sunPatch = this.build();
  }

  /**
   * Lay the card out.
   *
   * THE BACKDROP IS NOT DECORATION. It is a full-frame field of `#ebedea` — the brightest
   * colour in the whole authored palette, at 0.842 linear — and it is doing two jobs the
   * first version of this card could not do at all:
   *
   *   - It gives the vignette something to darken AT THE CORNER. On a black card the corner
   *     measurement read "100% darkening" whatever the shader did, because zero times
   *     anything is zero. A vignette is a fraction, so it can only be measured on a lit field.
   *   - It puts the bloom threshold's hardest case in every corner of the frame. 04 §4.1's
   *     claim is not "bright things are far from the sun", it is "no authored colour crosses
   *     the threshold at all", and a full frame of the brightest one is that claim's strongest
   *     form: if `#ebedea` blooms anywhere, it blooms here.
   *
   * The palette grid then sits INSIDE 75% of the corner radius, so the vignette provably
   * cannot reach it and the grading lock means "exact", not "exact except near the edges".
   */
  private build(): Patch {
    // Full-frame backdrop, behind everything. See the note above.
    const backdrop = new THREE.MeshBasicMaterial({
      color: new THREE.Color(BACKDROP_HEX),
      side: THREE.DoubleSide,
      fog: false,
    });
    this.materials.push(backdrop);
    const backdropMesh = new THREE.Mesh(this.quad, backdrop);
    backdropMesh.position.set(0.5, 0.5, -0.5);
    backdropMesh.scale.set(1, 1, 1);
    this.scene.add(backdropMesh);

    const count = ALL_SWATCHES.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    // Keep the grid within a radius the vignette cannot reach. r == 1 at the corner, and
    // falloff starts at 0.75, so a grid bounded by 0.62 of the corner radius has margin.
    const half = 0.75 * POST.vignette.falloffStart * 0.7071067811865476;
    const gridX = 0.5 - half;
    const gridY = 0.5 - half;
    const gridW = half * 2;
    const gridH = half * 2;

    const cellW = gridW / cols;
    const cellH = gridH / rows;

    ALL_SWATCHES.forEach((entry, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const patch: Patch = {
        name: entry.family + '.' + entry.key,
        hex: entry.swatch.hex,
        x: gridX + col * cellW,
        y: gridY + row * cellH,
        w: cellW,
        h: cellH,
      };
      this.patches.push(patch);

      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(entry.swatch.hex),
        side: THREE.DoubleSide, // the y-down camera flips winding
        fog: false,
        // NOT toneMapped:false — same reasoning as the palette gate. Immunising the card
        // against the very transform it exists to police would make the gate decorative.
      });
      this.materials.push(material);
      this.scene.add(this.placed(material, patch));
    });

    // --- the sun stand-in ---------------------------------------------------------------
    // A ShaderMaterial because a colour cannot express 4.0: THREE.Color is [0,1] sRGB, and
    // the whole point is a value the palette can never reach. Writes raw linear into the
    // composer's half-float buffer, exactly as the sky dome's disc does.
    const sunMaterial = new THREE.ShaderMaterial({
      uniforms: { uValue: { value: SUN_PATCH_LINEAR } },
      vertexShader: /* glsl */ `
        void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uValue;
        void main() {
          gl_FragColor = vec4( vec3( uValue ), 1.0 );
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.materials.push(sunMaterial);

    const sun: Patch = { name: 'sun-disc', hex: 0xffffff, x: 0.06, y: 0.06, w: 0.07, h: 0.07 };
    this.scene.add(this.placed(sunMaterial, sun));
    return sun;
  }

  private placed(material: THREE.Material, p: Patch): THREE.Mesh {
    const mesh = new THREE.Mesh(this.quad, material);
    mesh.position.set(p.x + p.w / 2, p.y + p.h / 2, 0);
    mesh.scale.set(p.w, p.h, 1);
    return mesh;
  }

  // ---------------------------------------------------------------- run

  run(): PostReport {
    const saved = {
      scene: this.post.renderPass.scene,
      camera: this.post.renderPass.camera,
      bloom: this.post.bloomEnabled,
      grain: this.post.grainEnabled,
      vignette: this.post.vignetteEnabled,
      values: this.post.values,
      animateSeed: this.post.grainAnimated,
    };

    this.post.setScene(this.scene, this.camera);

    const order = this.probeOrder();

    // Everything off but the render + encode. This is the baseline every other section
    // differences against, and it is also the grading-lock measurement itself.
    this.post.setBloomEnabled(false);
    this.post.setGrainEnabled(false);
    this.post.setVignetteEnabled(false);
    const baseline = this.render();
    const grade = this.probeGrade(baseline);

    const bloom = this.probeBloom(baseline);
    const grain = this.probeGrain(baseline);
    const chroma = this.probeChroma(baseline);
    const vignette = this.probeVignette(baseline);

    // Restore, including the values the sabotage sections moved.
    this.post.setBloom(saved.values.bloomThreshold, saved.values.bloomStrength, saved.values.bloomRadius);
    this.post.setGrainStrength(saved.values.grainStrength);
    this.post.setChromaWobble(saved.values.chromaWobble);
    this.post.setVignetteCorner(saved.values.vignetteCorner);
    this.post.setGrainAnimateSeed(saved.animateSeed ? 1 : 0);
    this.post.setBloomEnabled(saved.bloom);
    this.post.setGrainEnabled(saved.grain);
    this.post.setVignetteEnabled(saved.vignette);
    this.post.setScene(saved.scene, saved.camera);

    const pass = order.pass && grade.pass && bloom.pass && grain.pass && chroma.pass && vignette.pass;
    return { order, grade, bloom, grain, chroma, vignette, pass };
  }

  private render(): Framebuffer {
    this.post.render(0);
    const gl = this.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width, height };
  }

  // ---------------------------------------------------------------- 1. order

  private probeOrder(): OrderResult {
    const violations = this.post.checkPostOrder();
    return {
      actual: this.post.composer.passes.map((p) => p.constructor.name),
      violations,
      pass: violations.length === 0,
    };
  }

  // ---------------------------------------------------------------- 2. grading lock

  private probeGrade(frame: Framebuffer): GradeResult {
    const contractViolations = [...checkRendererContract(this.renderer), ...checkPostContract()];

    let exact = 0;
    let within = 0;
    let worstDelta = 0;
    let worstName = '';

    for (const patch of this.patches) {
      const actual = this.sample(frame, patch);
      const expected = hexBytes(patch.hex);
      const delta = channelDelta(expected, actual);
      if (delta === 0) exact++;
      if (delta <= GRADE_TOLERANCE) within++;
      if (delta > worstDelta) {
        worstDelta = delta;
        worstName = patch.name;
      }
    }

    return {
      total: this.patches.length,
      exact,
      withinTolerance: within,
      worstDelta,
      worstName,
      contractViolations,
      pass: within === this.patches.length && contractViolations.length === 0,
    };
  }

  // ---------------------------------------------------------------- 3. bloom

  private probeBloom(baseline: Framebuffer): BloomResult {
    // The claim in art/post.ts, restated as a number the report prints: the brightest thing
    // the palette can put on screen sits below the threshold with room to spare.
    let brightestHex = 0;
    let brightestName = '';
    let brightestLuma = -1;
    for (const patch of this.patches) {
      const luma = linearLuminanceOfHex(patch.hex);
      if (luma > brightestLuma) {
        brightestLuma = luma;
        brightestHex = patch.hex;
        brightestName = patch.name;
      }
    }

    this.post.setBloomEnabled(true);
    const bloomed = this.render();

    let worstPaletteDelta = 0;
    let worstPaletteName = '';
    for (const patch of this.patches) {
      const delta = channelDelta(this.sample(baseline, patch), this.sample(bloomed, patch));
      if (delta > worstPaletteDelta) {
        worstPaletteDelta = delta;
        worstPaletteName = patch.name;
      }
    }

    // The halo: just outside the sun patch, where bloom must visibly land. Sampling inside
    // it would prove nothing — that patch is already clipped white in display space.
    const halo: Patch = {
      name: 'sun-halo',
      hex: 0,
      x: this.sunPatch.x + this.sunPatch.w,
      y: this.sunPatch.y + this.sunPatch.h * 0.4,
      w: 0.02,
      h: 0.02,
    };
    const sunHaloDelta = channelDelta(this.sample(baseline, halo), this.sample(bloomed, halo));

    // --- negative control ---------------------------------------------------------------
    // 04 §4.1 describes the failure mode directly: a low threshold "ruining the whole
    // render" by blooming every bright surface. Watch it happen, then put it back.
    this.post.setBloom(POST_SABOTAGE.bloomThreshold, POST.bloom.strength, POST.bloom.radius);
    const sabotaged = this.render();
    let sabotageDelta = 0;
    for (const patch of this.patches) {
      sabotageDelta = Math.max(sabotageDelta, channelDelta(this.sample(baseline, patch), this.sample(sabotaged, patch)));
    }
    this.post.setBloom(POST.bloom.threshold, POST.bloom.strength, POST.bloom.radius);
    this.post.setBloomEnabled(false);

    const sabotageDetected = sabotageDelta > BLOOM_LEAK_TOLERANCE;
    return {
      measured: true,
      worstPaletteDelta,
      worstPaletteName,
      sunHaloDelta,
      brightestHex,
      brightestName,
      brightestLinearLuma: round(brightestLuma, 3),
      threshold: POST.bloom.threshold,
      headroom: round(POST.bloom.threshold - brightestLuma, 3),
      sabotageDelta,
      sabotageDetected,
      pass:
        worstPaletteDelta <= BLOOM_LEAK_TOLERANCE &&
        sunHaloDelta >= BLOOM_MIN_EFFECT &&
        brightestLuma < POST.bloom.threshold &&
        sabotageDetected,
    };
  }

  // ---------------------------------------------------------------- 4. grain

  private probeGrain(baseline: Framebuffer): GrainResult {
    this.post.setGrainEnabled(true);
    const first = this.render();
    const second = this.render();

    // Static means byte-identical, not "close". Compared over the whole frame, so a crawl
    // anywhere shows up even if the sampled patches happen to agree.
    const changedPixelsBetweenFrames = countDifferingPixels(first, second);

    // --- negative control: 04 §7.3's own snippet behaviour ------------------------------
    this.post.setGrainAnimateSeed(1);
    const animatedA = this.render();
    this.post.setGrainAnimateSeed(2);
    const animatedB = this.render();
    const animatedChangedPixels = countDifferingPixels(animatedA, animatedB);
    this.post.setGrainAnimateSeed(0);

    // Amplitude, measured against the grain-free baseline on the palette patches — flat
    // colour fields, which is exactly where rule 8 says grain must stay invisible.
    let peak = 0;
    let sumSq = 0;
    let n = 0;
    let maxChannelSpread = 0;
    for (const patch of this.patches) {
      for (const px of this.pixelsIn(first, patch)) {
        const before = readPixel(baseline, px.x, px.y);
        const after = readPixel(first, px.x, px.y);
        const d: RGB = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];
        const mag = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
        peak = Math.max(peak, mag);
        sumSq += (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) / 3;
        n++;
        // Grain is achromatic: one value on all three channels. The chroma wobble is a
        // separate term and is measured on its own below, so it is switched off here.
        maxChannelSpread = Math.max(maxChannelSpread, Math.max(...d) - Math.min(...d));
      }
    }
    this.post.setGrainEnabled(false);

    // 04 §8.2's ceiling is a fraction of full scale; the amplitude is +/-strength/2, so the
    // peak a legal value can produce is ceiling/2 of 255, plus a count of encode rounding.
    const ceilingBytes = Math.ceil((LIGHT.grainStrengthRange[1] / 2) * 255) + 1;

    return {
      measured: n > 0,
      changedPixelsBetweenFrames,
      isStatic: changedPixelsBetweenFrames === 0,
      animatedChangedPixels,
      animationDetected: animatedChangedPixels > 0,
      peakAmplitude: peak,
      rmsAmplitude: round(Math.sqrt(sumSq / Math.max(n, 1)), 2),
      ceilingBytes,
      withinCeiling: peak <= ceilingBytes,
      maxChannelSpread,
      // The wobble is off, so the only per-pixel channel difference left is encode rounding.
      achromatic: maxChannelSpread <= 2,
      pass:
        n > 0 &&
        changedPixelsBetweenFrames === 0 &&
        animatedChangedPixels > 0 &&
        peak <= ceilingBytes &&
        maxChannelSpread <= 2,
    };
  }

  // ---------------------------------------------------------------- 5. chroma wobble

  private probeChroma(baseline: Framebuffer): ChromaResult {
    // Wobble alone: grain off (strength 0), wobble at its authored value. Isolating it is
    // the only way to say anything about brightness — additive grain is zero-mean too, and
    // would hide a wobble that was not.
    const savedGrain = this.post.values.grainStrength;
    this.post.setGrainStrength(0);
    this.post.setGrainEnabled(true);
    const wobbled = this.render();
    this.post.setGrainEnabled(false);
    this.post.setGrainStrength(savedGrain);

    let lumaSum = 0;
    let channelSum = 0;
    let n = 0;
    for (const patch of this.patches) {
      for (const px of this.pixelsIn(wobbled, patch)) {
        const before = readPixel(baseline, px.x, px.y);
        const after = readPixel(wobbled, px.x, px.y);
        lumaSum += displayLuma(after) - displayLuma(before);
        channelSum +=
          (Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1]) + Math.abs(after[2] - before[2])) / 3;
        n++;
      }
    }

    const meanLumaDelta = round(lumaSum / Math.max(n, 1), 3);
    const meanChannelDelta = round(channelSum / Math.max(n, 1), 3);
    const lumaNeutral = Math.abs(meanLumaDelta) <= CHROMA_LUMA_TOLERANCE;

    return {
      measured: n > 0,
      meanLumaDelta,
      meanChannelDelta,
      lumaNeutral,
      // Both halves: it must move colour AT ALL, and must not move brightness.
      pass: n > 0 && lumaNeutral && meanChannelDelta > 0,
    };
  }

  // ---------------------------------------------------------------- 6. vignette

  private probeVignette(baseline: Framebuffer): VignetteResult {
    this.post.setVignetteEnabled(true);
    const vignetted = this.render();
    this.post.setVignetteEnabled(false);

    // Inside the falloff radius nothing may change at all. The palette grid was laid out
    // inside it deliberately, so this is a direct read of "the grade left the picture alone".
    let innerDelta = 0;
    for (const patch of this.patches) {
      innerDelta = Math.max(innerDelta, channelDelta(this.sample(baseline, patch), this.sample(vignetted, patch)));
    }

    // Corner darkening, read a couple of pixels in from the extreme corner so the sample is
    // not sitting on the clamp. Measured on the card's background, a known flat field.
    const cornerBefore = readPixel(baseline, baseline.width - 3, 2);
    const cornerAfter = readPixel(vignetted, vignetted.width - 3, 2);
    // The card's background is black at the corner, which cannot show a multiply. Use the
    // brightest corner-adjacent sample available instead: the vignette is a fraction, so it
    // is measured where there is something to darken.
    const probeX = Math.floor(vignetted.width * 0.985);
    const probeY = Math.floor(vignetted.height * 0.985);
    const before = brightestNear(baseline, probeX, probeY, 6);
    const after = readPixel(vignetted, before.x, before.y);
    const beforeLuma = displayLuma(before.rgb);
    const afterLuma = displayLuma(after);
    const cornerDarkening =
      beforeLuma > 8 ? round(1 - afterLuma / beforeLuma, 4) : round(1 - displayLuma(cornerAfter) / Math.max(displayLuma(cornerBefore), 1), 4);

    const [lo, hi] = LIGHT.vignetteCornerRange;
    // The sample sits at ~0.985 of the frame, not exactly at the corner, so it sees slightly
    // less than the full corner figure. Compare against what the shader's own curve predicts
    // there rather than against the corner value, which would fail a correct implementation.
    const predicted = POST.vignette.corner * smoothstep(POST.vignette.falloffStart, 1, radiusAt(before.x, before.y, vignetted));
    const withinRange = POST.vignette.corner >= lo && POST.vignette.corner <= hi &&
      Math.abs(cornerDarkening - predicted) <= 0.01;

    return {
      measured: true,
      innerDelta,
      cornerDarkening,
      withinRange,
      innerClean: innerDelta <= VIGNETTE_INNER_TOLERANCE,
      pass: innerDelta <= VIGNETTE_INNER_TOLERANCE && withinRange,
    };
  }

  // ---------------------------------------------------------------- sampling helpers

  /** Centre pixel of a patch. Normalised y is DOWN; GL's readback origin is bottom-left. */
  private sample(frame: Framebuffer, patch: Patch): RGB {
    const px = clamp(Math.floor((patch.x + patch.w / 2) * frame.width), 0, frame.width - 1);
    const py = clamp(Math.floor((1 - (patch.y + patch.h / 2)) * frame.height), 0, frame.height - 1);
    return readPixel(frame, px, py);
  }

  /** A sparse interior sample set — enough for statistics, cheap enough to run every gate. */
  private *pixelsIn(frame: Framebuffer, patch: Patch): Generator<{ x: number; y: number }> {
    const x0 = clamp(Math.floor((patch.x + patch.w * 0.2) * frame.width), 0, frame.width - 1);
    const x1 = clamp(Math.floor((patch.x + patch.w * 0.8) * frame.width), 0, frame.width - 1);
    const y0 = clamp(Math.floor((1 - (patch.y + patch.h * 0.8)) * frame.height), 0, frame.height - 1);
    const y1 = clamp(Math.floor((1 - (patch.y + patch.h * 0.2)) * frame.height), 0, frame.height - 1);
    const stepX = Math.max(1, Math.floor((x1 - x0) / 8));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 8));
    for (let y = y0; y <= y1; y += stepY) {
      for (let x = x0; x <= x1; x += stepX) yield { x, y };
    }
  }

  dispose(): void {
    this.quad.dispose();
    for (const m of this.materials) m.dispose();
  }

  // ---------------------------------------------------------------- report

  static format(r: PostReport): string {
    const lines: string[] = [];
    lines.push('POST GATE (Step 6) — ' + (r.pass ? 'PASS' : 'FAIL'));
    lines.push('');

    lines.push('  chain order (04 §7.1)         ' + verdict(r.order.pass));
    lines.push('    ' + r.order.actual.join(' -> '));
    for (const v of r.order.violations) lines.push('    ! ' + v);
    lines.push('');

    lines.push('  grading lock (04 §7.2)        ' + verdict(r.grade.pass));
    lines.push(
      '    ' + r.grade.exact + '/' + r.grade.total + ' authored hexes exact through the composer, worst delta ' +
        r.grade.worstDelta + (r.grade.worstDelta > 0 ? ' (' + r.grade.worstName + ')' : ''),
    );
    for (const v of r.grade.contractViolations) lines.push('    ! ' + v);
    lines.push('');

    lines.push('  bloom threshold (04 §4.1)     ' + verdict(r.bloom.pass));
    lines.push(
      '    brightest authored colour ' + hex(r.bloom.brightestHex) + ' (' + r.bloom.brightestName + ') = ' +
        r.bloom.brightestLinearLuma + ' linear vs threshold ' + r.bloom.threshold +
        ', headroom ' + r.bloom.headroom,
    );
    lines.push('    palette moved by bloom      ' + r.bloom.worstPaletteDelta + '/255 (must be <= ' + BLOOM_LEAK_TOLERANCE + ')');
    lines.push('    halo beside the 4.0 patch   ' + r.bloom.sunHaloDelta + '/255 (must be >= ' + BLOOM_MIN_EFFECT + ')');
    lines.push(
      '    negative control @ ' + POST_SABOTAGE.bloomThreshold + '        palette moved ' + r.bloom.sabotageDelta +
        '/255 ' + (r.bloom.sabotageDetected ? '(detected)' : '(NOT DETECTED — the check has no teeth)'),
    );
    lines.push('');

    lines.push('  grain (rule 8, 04 §7.3)       ' + verdict(r.grain.pass));
    lines.push(
      '    static across frames        ' + (r.grain.isStatic ? 'yes, 0 px changed' : 'NO, ' + r.grain.changedPixelsBetweenFrames + ' px changed'),
    );
    lines.push(
      '    negative control (animated) ' + r.grain.animatedChangedPixels + ' px changed ' +
        (r.grain.animationDetected ? '(detected)' : '(NOT DETECTED)'),
    );
    lines.push(
      '    amplitude peak / rms        ' + r.grain.peakAmplitude + ' / ' + r.grain.rmsAmplitude +
        ' of 255, ceiling ' + r.grain.ceilingBytes,
    );
    lines.push('    achromatic (channel spread) ' + r.grain.maxChannelSpread + ' ' + verdict(r.grain.achromatic));
    lines.push('');

    lines.push('  chroma wobble (rule 8)        ' + verdict(r.chroma.pass));
    lines.push('    mean luma moved             ' + r.chroma.meanLumaDelta + '/255 (must be ~0)');
    lines.push('    mean channel moved          ' + r.chroma.meanChannelDelta + '/255 (must be > 0)');
    lines.push('');

    lines.push('  vignette (04 §7.4)            ' + verdict(r.vignette.pass));
    lines.push('    inside ' + POST.vignette.falloffStart + ' of corner radius  ' + r.vignette.innerDelta + '/255 changed (must be <= ' + VIGNETTE_INNER_TOLERANCE + ')');
    lines.push(
      '    darkening near the corner   ' + (r.vignette.cornerDarkening * 100).toFixed(2) + '% ' +
        '(authored corner ' + (POST.vignette.corner * 100).toFixed(0) + '%, 04 §8.2 allows ' +
        (LIGHT.vignetteCornerRange[0] * 100).toFixed(0) + '-' + (LIGHT.vignetteCornerRange[1] * 100).toFixed(0) + '%)',
    );

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------- free functions

function readPixel(frame: Framebuffer, x: number, y: number): RGB {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
}

function channelDelta(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Rec.709 weights applied to display-space bytes — Y', which is what "brightness" means
 *  for an artifact living on top of the encoded image. */
function displayLuma(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function countDifferingPixels(a: Framebuffer, b: Framebuffer): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let n = 0;
  // Every 4th pixel: a crawling grain changes essentially all of them, so a stride cannot
  // hide the failure, and a full-frame walk at 4K runs this gate into tens of milliseconds.
  for (let i = 0; i < a.data.length; i += 16) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  }
  return n;
}

/** Brightest pixel in a small window — the vignette needs something non-black to darken. */
function brightestNear(frame: Framebuffer, cx: number, cy: number, radius: number): { x: number; y: number; rgb: RGB } {
  let best = { x: cx, y: cy, rgb: readPixel(frame, cx, cy) };
  let bestLuma = displayLuma(best.rgb);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = clamp(cx + dx, 0, frame.width - 1);
      const y = clamp(cy + dy, 0, frame.height - 1);
      const rgb = readPixel(frame, x, y);
      const l = displayLuma(rgb);
      if (l > bestLuma) {
        bestLuma = l;
        best = { x, y, rgb };
      }
    }
  }
  return best;
}

/** The shader's own radius term, so the probe compares against the curve rather than a guess. */
function radiusAt(x: number, y: number, frame: Framebuffer): number {
  const u = (x + 0.5) / frame.width - 0.5;
  const v = (y + 0.5) / frame.height - 0.5;
  return Math.hypot(u, v) / 0.7071067811865476;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function verdict(pass: boolean): string {
  return pass ? 'ok' : 'FAIL';
}

function hex(v: number): string {
  return '#' + v.toString(16).padStart(6, '0');
}
