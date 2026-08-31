/**
 * Budget ceilings from `00 — Art Direction Bible.md` §5 and the per-system docs.
 * DATA ONLY. The debug HUD asserts against these; nothing here imports three.js.
 */

/** 00 §5 — the global performance contract. */
export const GLOBAL = Object.freeze({
  targetFps: 60,
  targetResolution: '1440p on a mid laptop GPU',
  /** Ocean + sky + 3 visible islands, combined. */
  maxTriangles: 1_200_000,
  /** Terrain-class draw calls, shared across ocean/sky/terrain/clouds. */
  maxDrawCalls: 40,
});

/** 02_WATER.md §6.1 / §6.3 */
export const OCEAN = Object.freeze({
  maxTriangles: 300_000,
  maxDrawCalls: 5,
  ringRadiiMetres: [50, 150, 400, 1000, 2500] as const,
  wakeBufferResolution: 256,
  glintCoverageRange: [0.03, 0.06] as const,
});

/** 02b_COASTAL_WAVES.md §7.2 */
export const COAST = Object.freeze({
  shoreAtlasMemoryMB: 16,
  maxFoamRibbons: 6,
  maxRockSprayInstances: 32,
  maxRibbonTriangles: 5_000,
});

/** 03_ISLANDS.md §10.1 */
export const ISLANDS = Object.freeze({
  chunkSizeMetres: 512,
  maxFoliageInstances: 150_000,
  erosionWorkingResolution: 512,
  bakedHeightmapResolution: 2048,
  perIslandGenerationBudgetMs: 150,
});

/** 04_LIGHT.md §8.2 — starting uniform values, consolidated. */
export const LIGHT = Object.freeze({
  rampStepsRange: [2, 4] as const,
  shadowTintMix: 0.85,
  csmCascades: 3,
  /**
   * 2048, where 04 §8.2 says 1024 — a deliberate departure, and the reason is measurable.
   *
   * Nothing else in the shadow path is soft: the filter is PCFShadowMap with radius 0, and the
   * gouache ramp cuts the sampled factor to binary with `step(0.5, ...)`. So a shadow edge is
   * hard in TONE already, and every bit of apparent softness is the edge's POSITION quantising
   * to the shadow texel grid. At 1024 the near cascade's texel was 1.13 m of world — over half
   * a person — which is why edges read as ragged rather than crisp.
   *
   * Doubling halves it. Costs 48 MB of shadow map across three cascades, up from 12.
   */
  csmShadowMapSize: 2048,
  shadowBiasRange: [-0.0005, 0.0001] as const,
  shadowRadiusRange: [0, 1] as const,
  bloomThresholdRange: [0.9, 0.94] as const,
  bloomStrengthRange: [0.4, 0.6] as const,
  bloomRadiusRange: [0.2, 0.3] as const,
  hazeDensityRange: [0.0001, 0.00035] as const,
  hazeHeightFalloff: 0.0012,
  grainStrengthRange: [0.02, 0.035] as const,
  chromaWobbleRange: [0.01, 0.02] as const,
  vignetteCornerRange: [0.06, 0.08] as const,
});

export const BUDGETS = Object.freeze({ GLOBAL, OCEAN, COAST, ISLANDS, LIGHT });
