import * as THREE from 'three';

/**
 * THE RENDERER CONTRACT — `00 — Art Direction Bible.md` §5, `04_LIGHT.md` §8.1.
 *
 * This is the only place in the codebase that configures the renderer. Every value
 * here is a style decision, not a default:
 *
 *  - NoToneMapping. ACESFilmic is explicitly OFF. The palette in art/palette.ts is
 *    sampled sRGB hex that must survive untouched to the screen; ACES applies a
 *    filmic contrast/desaturation curve that measurably crushes exactly those values.
 *    Deliberate grading happens later, as a hand-authored LUT in the post chain.
 *  - SRGBColorSpace output, albedo authored in sRGB, lighting maths linear.
 *  - PCFShadowMap (hard), NOT PCFSoftShadowMap's wide default radius. The style wants
 *    hard shadow edges with soft interiors; shadow.radius is pinned near 0 per-light.
 *
 * If a screenshot's colours ever stop matching the authored hex, suspect this file first.
 */

export const RENDERER_CONTRACT = Object.freeze({
  toneMapping: THREE.NoToneMapping,
  outputColorSpace: THREE.SRGBColorSpace,
  shadowMapType: THREE.PCFShadowMap,
  /** FXAA or supersampling later; never TAA (02_WATER.md §6.2 — it softens hard edges). */
  antialias: true,
  maxPixelRatio: 2,
});

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** Dev-only: required for the palette gate's readPixels verification. */
  preserveDrawingBuffer?: boolean;
}

export function createRenderer({ canvas, preserveDrawingBuffer = false }: RendererOptions): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: RENDERER_CONTRACT.antialias,
    preserveDrawingBuffer,
    alpha: false,
    powerPreference: 'high-performance',
  });

  renderer.outputColorSpace = RENDERER_CONTRACT.outputColorSpace;
  renderer.toneMapping = RENDERER_CONTRACT.toneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = RENDERER_CONTRACT.shadowMapType;
  renderer.shadowMap.autoUpdate = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDERER_CONTRACT.maxPixelRatio));

  return renderer;
}

/**
 * Returns a list of §5 contract violations, empty if clean. Non-throwing, because the
 * palette gate wants to render and measure the damage even while the contract is broken —
 * seeing *how far* the colours moved is the informative part.
 */
export function checkRendererContract(renderer: THREE.WebGLRenderer): string[] {
  const problems: string[] = [];

  if (renderer.toneMapping !== THREE.NoToneMapping) {
    problems.push(`toneMapping is ${renderer.toneMapping}, expected NoToneMapping (${THREE.NoToneMapping}) — 00 §5`);
  }
  if (renderer.outputColorSpace !== THREE.SRGBColorSpace) {
    problems.push(`outputColorSpace is "${renderer.outputColorSpace}", expected "${THREE.SRGBColorSpace}" — 00 §5`);
  }
  if (renderer.shadowMap.type !== THREE.PCFShadowMap) {
    problems.push(`shadowMap.type is ${renderer.shadowMap.type}, expected PCFShadowMap (${THREE.PCFShadowMap}) — 04 §8.1`);
  }
  if (!THREE.ColorManagement.enabled) {
    problems.push('THREE.ColorManagement.enabled is false — authored sRGB hex will not round-trip');
  }

  return problems;
}

/** Hard-fails on contract drift. For world scenes, where there is no reason to continue. */
export function assertRendererContract(renderer: THREE.WebGLRenderer): void {
  const problems = checkRendererContract(renderer);
  if (problems.length > 0) {
    throw new Error(`Renderer contract violated:\n  - ${problems.join('\n  - ')}`);
  }
}
