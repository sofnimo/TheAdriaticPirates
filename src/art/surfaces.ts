import { ACCENT, LAND, SEA, SKY } from './palette';

/**
 * PER-SURFACE TUNING — `04 — Light and Shadow.md` §2.3, transcribed.
 *
 * This table *is* the "one shared chunk, many uniform sets" mechanism the art bible
 * calls for. Every surface in the world runs the identical gouache GLSL; only these
 * numbers change. Adding a surface means adding a row here, never a second shader.
 *
 * DATA ONLY — no three.js import.
 */

export interface SurfacePreset {
  /** Display name for the debug UI. */
  readonly label: string;
  /** Lit tone — the authored base colour the ramp's top band resolves to. */
  readonly baseColor: number;
  /**
   * Shadow band target. HUE-SHIFTED, never a darkened base (00 §3 rule 2).
   * The ramp lerps toward this; it never multiplies the base down.
   */
  readonly shadowTint: number;
  /** How far the shadow band leans into shadowTint vs base*0.82. 04 §8.2: 0.85. */
  readonly shadowTintMix: number;
  /** Quantised band count, 2-4 (00 §3 rule 1). */
  readonly rampSteps: number;
  /** Rim/backlight accent. */
  readonly rimColor: number;
  /** 0-0.6, kept low — a paint accent, not a Fresnel glow. */
  readonly rimStrength: number;
  /** Rim falloff exponent, 2.0-6.0. */
  readonly rimPower: number;
  readonly note?: string;
}

const preset = (p: SurfacePreset): SurfacePreset => Object.freeze(p);

export const SURFACES = Object.freeze({
  openSea: preset({
    label: 'Open sea',
    baseColor: SEA.deepSunlit.hex, // #024892
    shadowTint: SEA.shadow.hex, // #012438 — violet-navy per 00 §3
    shadowTintMix: 0.85,
    rampSteps: 3,
    rimColor: SEA.crestHigh.hex, // #e7e6eb foam-white
    rimStrength: 0.15,
    rimPower: 3.5,
    note: 'Rim handed off to 02_WATER.md glints once the ocean exists.',
  }),

  cloud: preset({
    label: 'Cloud',
    baseColor: SKY.cloudLit.hex, // #ebedea
    shadowTint: SKY.cloudShadow.hex, // #8cbdcb — cyan, NEVER grey
    shadowTintMix: 0.85,
    rampSteps: 2,
    rimColor: SKY.zenith.hex, // #1ca6c7
    rimStrength: 0.1,
    rimPower: 3.0,
    note: 'Clouds shade towards the sky own cyan (00 §2).',
  }),

  forest: preset({
    label: 'Forest / canopy',
    baseColor: LAND.canopyMid.hex, // #45764e
    shadowTint: LAND.forestDense.hex, // #1f4e38 — blue-green shifted
    shadowTintMix: 0.85,
    rampSteps: 3,
    rimColor: SKY.cloudShadow.hex, // #8cbdcb
    rimStrength: 0.2,
    rimPower: 3.5,
  }),

  limestone: preset({
    label: 'Limestone cliff',
    baseColor: LAND.limestoneLit.hex, // #cbc5ad
    shadowTint: LAND.limestoneStrata.hex, // #726f60 — warm brown-grey
    shadowTintMix: 0.85,
    rampSteps: 4, // strata read best with more bands (04 §2.3)
    rimColor: SKY.horizonHazeFar.hex, // #d0dbdf
    rimStrength: 0.15,
    rimPower: 3.5,
  }),

  terracotta: preset({
    label: 'Terracotta / buildings',
    baseColor: LAND.terracotta.hex, // #a42a08
    shadowTint: LAND.brickShadow.hex, // #654532 — warm, never desaturated to grey
    shadowTintMix: 0.85,
    rampSteps: 2,
    rimColor: 0x000000,
    rimStrength: 0, // reserve red: no rim stealing the accent (04 §2.3)
    rimPower: 3.0,
  }),

  aircraft: preset({
    label: 'Aircraft (vermilion)',
    baseColor: ACCENT.planeVermilion.hex, // #c63427
    shadowTint: 0x6e1c12, // warm-dark, NEVER blue-shifted — the plane must stay hot
    shadowTintMix: 0.85,
    rampSteps: 3,
    rimColor: SEA.crestHigh.hex, // #e7e6eb thin edge highlight only
    rimStrength: 0.1,
    rimPower: 6.0, // tight
    note: 'If this ever cools toward blue in shadow or haze, that is a bug (04 §8.3).',
  }),
});

export type SurfaceName = keyof typeof SURFACES;

export const SURFACE_NAMES = Object.freeze(Object.keys(SURFACES) as SurfaceName[]);
