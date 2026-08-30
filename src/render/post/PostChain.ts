import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

import { POST } from '../../art/post';
import FULLSCREEN_VERT from './fullscreen.vert.glsl';
import GRAIN_FRAG from './grain.frag.glsl';
import VIGNETTE_FRAG from './vignette.frag.glsl';

/**
 * THE POST CHAIN — `00 — Art Direction Bible.md` §5 and `04 — Light and Shadow.md` §7.1.
 *
 *   "Depth-colour fog -> bloom (tight threshold, only for sun glare and foam) -> grain
 *    -> subtle chroma/vignette. Order matters."
 *
 * The order is binding, so it is DATA here (`PASS_ORDER`) and `checkPostOrder()` reads the
 * built composer back and compares. That is the same shape as `checkRendererContract` —
 * a contract that can only be honoured by reading the comment is not a contract.
 *
 * WHERE THE HAZE IS. The first stage of §7.1's chain is not a pass. Aerial perspective is
 * already resolved per-fragment inside `aerial_perspective.glsl`, called by every gouache
 * surface before it writes. That satisfies the ordering requirement — haze is resolved
 * strictly before bloom sees the frame — and it is the only way to get 00 §3 rule 5's
 * behaviour at all, since a screen-space fog pass has one depth per pixel and no idea
 * whether it is looking at land (desaturates) or sea (holds saturation to the last band).
 *
 * WHY OutputPass SITS IN THE MIDDLE. The composer's buffers are half-float in the LINEAR
 * working space, so three makes every material's `<colorspace_fragment>` an identity while
 * it renders into them (`WebGLPrograms`: a non-XR render target forces the working colour
 * space). Bloom therefore thresholds against genuinely linear luminance, which is the only
 * space where 04 §4.1's "0.90-0.94" means anything. OutputPass then applies the sRGB encode
 * — and NoToneMapping, so it is an encode and nothing else. Grain and vignette run after it,
 * in display space, per §7.1's "on top of the finished painting".
 *
 * NOTHING HERE IS A TASTE CALL. Every number comes from art/post.ts, which is range-checked
 * against 04 §8.2 by `checkPostContract()`.
 */

/** 04 §7.1, as data. `checkPostOrder()` asserts the built chain against this. */
export const PASS_ORDER = Object.freeze([
  'render', // haze already resolved in-material, see the header
  'stats-tap',
  'bloom',
  'output',
  'grain',
  'vignette',
] as const);

export type PassName = (typeof PASS_ORDER)[number];

/**
 * A zero-draw pass whose only job is to snapshot `renderer.info` immediately after the
 * scene has been drawn and before any fullscreen quad has.
 *
 * The budget HUD gates world content at 00 §5's 40 draw calls. Without this tap the four
 * post quads land in the same counter as the terrain, and the island's honest 7 draws
 * would report as 11 — the same mis-attribution the Engine already keeps dev helpers out
 * of. Counting post separately also makes it visible, which is the point: the post chain
 * is not free and should not hide inside the world's number.
 */
class StatsTapPass extends Pass {
  constructor(private readonly onTap: () => void) {
    super();
    // Draws nothing and consumes nothing, so the read/write buffers must not swap.
    this.needsSwap = false;
  }

  override render(): void {
    this.onTap();
  }
}

export interface PostChainOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Called with the draw/triangle counts of the scene pass alone. */
  onSceneStats?: (calls: number, triangles: number) => void;
}

export class PostChain {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloomPass: UnrealBloomPass;
  readonly outputPass: OutputPass;
  readonly grainPass: ShaderPass;
  readonly vignettePass: ShaderPass;

  /** Master switch. `?post=0` and the debug panel turn the whole chain off. */
  enabled = true;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly statsTap: StatsTapPass;

  constructor(options: PostChainOptions) {
    this.renderer = options.renderer;

    const size = options.renderer.getDrawingBufferSize(new THREE.Vector2());

    // A MULTISAMPLED TARGET, PASSED IN EXPLICITLY — and without it the whole game renders with
    // no antialiasing at all.
    //
    // `RendererConfig` asks for `antialias: true`, which is honoured, and it does nothing here:
    // that flag multisamples the DEFAULT FRAMEBUFFER, and a composer never draws to the default
    // framebuffer. It renders the scene into its own target and only blits the finished image
    // to the screen. three's EffectComposer builds that target itself when one is not supplied,
    // with `{ type: HalfFloatType }` and no `samples` — so it defaults to zero and every edge in
    // the frame comes out hard-stepped. The renderer flag is still worth keeping: it covers the
    // `?post=0` path, where the scene does go straight to the default framebuffer.
    //
    // It shows worst on the waterline, which is why this was found there. That edge is the
    // highest-contrast boundary in the frame — near-white foam against deep blue — and it runs
    // close to horizontal across long stretches, the orientation that stair-steps most visibly.
    // But nothing was being antialiased: island silhouettes, the leaf blades and the glint marks
    // were all aliased for the same reason.
    //
    // 4 samples rather than 8: the cost is bandwidth on a full-screen HalfFloat target, and
    // the returns past 4 are slight on edges this high-contrast.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    target.texture.name = 'PostChain.rt';

    this.composer = new EffectComposer(options.renderer, target);
    // The composer's own default is 1; the renderer already carries the device ratio and
    // setSize() below is given drawing-buffer pixels, so leave it at 1 and do the maths once.
    this.composer.setPixelRatio(1);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(options.scene, options.camera);

    this.statsTap = new StatsTapPass(() => {
      const info = options.renderer.info;
      options.onSceneStats?.(info.render.calls, info.render.triangles);
    });

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      POST.bloom.strength,
      POST.bloom.radius,
      POST.bloom.threshold,
    );

    this.outputPass = new OutputPass();

    this.grainPass = new ShaderPass({
      name: 'GrainChromaShader',
      uniforms: {
        tDiffuse: { value: null },
        uGrainStrength: { value: POST.grain.strength },
        uChromaWobble: { value: POST.grain.chromaWobble },
        uWobbleCellPx: { value: POST.grain.wobbleCellPx },
        uAnimateSeed: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: GRAIN_FRAG,
    });

    this.vignettePass = new ShaderPass({
      name: 'VignetteShader',
      uniforms: {
        tDiffuse: { value: null },
        uVignetteCorner: { value: POST.vignette.corner },
        uVignetteFalloffStart: { value: POST.vignette.falloffStart },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: VIGNETTE_FRAG,
    });

    // §7.1's order, once, here.
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.statsTap);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    this.composer.addPass(this.grainPass);
    this.composer.addPass(this.vignettePass);
  }

  /** Repoint the scene pass. The composer outlives any one test-scene camera. */
  setScene(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  /** Sizes are DRAWING-BUFFER pixels, not CSS pixels — see the pixel-ratio note above. */
  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  render(deltaTime: number): void {
    this.composer.render(deltaTime);
  }

  // ---------------------------------------------------------------- per-pass toggles
  //
  // The probe drives these. 04 §8.2's values are measured one at a time and never all at
  // once: grain perturbs every pixel by a few counts, which is correct and is also enough
  // to swamp a byte-exact palette comparison. Same discipline the ocean gate uses when it
  // switches glints off to measure the depth ramp.

  setBloomEnabled(on: boolean): void {
    this.bloomPass.enabled = on;
  }

  setGrainEnabled(on: boolean): void {
    this.grainPass.enabled = on;
  }

  setVignetteEnabled(on: boolean): void {
    this.vignettePass.enabled = on;
  }

  get bloomEnabled(): boolean {
    return this.bloomPass.enabled;
  }

  get grainEnabled(): boolean {
    return this.grainPass.enabled;
  }

  get vignetteEnabled(): boolean {
    return this.vignettePass.enabled;
  }

  // ---------------------------------------------------------------- live tuning
  //
  // Setters rather than exposed uniforms, so the debug panel and the sabotage flags go
  // through one door and the values stay inspectable via the getters below.

  setBloom(threshold: number, strength: number, radius: number): void {
    this.bloomPass.threshold = threshold;
    this.bloomPass.strength = strength;
    this.bloomPass.radius = radius;
  }

  setGrainStrength(v: number): void {
    this.grainPass.uniforms.uGrainStrength!.value = v;
  }

  setChromaWobble(v: number): void {
    this.grainPass.uniforms.uChromaWobble!.value = v;
  }

  setVignetteCorner(v: number): void {
    this.vignettePass.uniforms.uVignetteCorner!.value = v;
  }

  /**
   * Non-zero makes the grain crawl — 04 §7.3's snippet behaviour, which rule 8 forbids.
   * The standing negative control for the stability check; 0 in every shipping path.
   */
  setGrainAnimateSeed(seed: number): void {
    this.grainPass.uniforms.uAnimateSeed!.value = seed;
  }

  get grainAnimated(): boolean {
    return (this.grainPass.uniforms.uAnimateSeed!.value as number) !== 0;
  }

  get values(): {
    bloomThreshold: number;
    bloomStrength: number;
    bloomRadius: number;
    grainStrength: number;
    chromaWobble: number;
    vignetteCorner: number;
  } {
    return {
      bloomThreshold: this.bloomPass.threshold,
      bloomStrength: this.bloomPass.strength,
      bloomRadius: this.bloomPass.radius,
      grainStrength: this.grainPass.uniforms.uGrainStrength!.value as number,
      chromaWobble: this.grainPass.uniforms.uChromaWobble!.value as number,
      vignetteCorner: this.vignettePass.uniforms.uVignetteCorner!.value as number,
    };
  }

  /**
   * Reads the BUILT chain back and checks it against `PASS_ORDER`. Returns violations,
   * empty when clean — non-throwing, matching `checkRendererContract`.
   *
   * This catches the failure 04 §7.1 warns about specifically: aerial perspective resolved
   * after bloom (so haze-lightened distance spuriously crosses the threshold), or grain
   * applied before the grade (so it gets lit by the encode instead of sitting on top).
   */
  checkPostOrder(): string[] {
    const problems: string[] = [];
    const actual = this.composer.passes.map((p) => this.nameOf(p));

    if (actual.length !== PASS_ORDER.length) {
      problems.push(`chain has ${actual.length} passes, expected ${PASS_ORDER.length}: [${actual.join(', ')}]`);
      return problems;
    }
    PASS_ORDER.forEach((expected, i) => {
      if (actual[i] !== expected) {
        problems.push(`pass ${i} is "${actual[i]}", expected "${expected}" — 04 §7.1 order is binding`);
      }
    });
    return problems;
  }

  private nameOf(pass: Pass): PassName | 'unknown' {
    if (pass === this.renderPass) return 'render';
    if (pass === this.statsTap) return 'stats-tap';
    if (pass === this.bloomPass) return 'bloom';
    if (pass === this.outputPass) return 'output';
    if (pass === this.grainPass) return 'grain';
    if (pass === this.vignettePass) return 'vignette';
    return 'unknown';
  }

  dispose(): void {
    this.composer.dispose();
    this.bloomPass.dispose();
    this.outputPass.dispose();
    this.grainPass.dispose();
    this.vignettePass.dispose();
    this.renderer.setRenderTarget(null);
  }
}
