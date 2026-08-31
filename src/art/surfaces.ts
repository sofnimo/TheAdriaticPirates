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
  /**
   * How far this surface's shadow tint leans toward `SKY.shadowDeep` — the sky-blue core.
   *
   * The second half of rule 2, and the reason shadows read as blue rather than as grey. A
   * surface out of the sun is lit by the sky, so its shadow tends toward the sky's colour;
   * this is how much of that each material takes. It is PER SURFACE and not a global constant
   * because two rows here carry explicit instructions that a global would trample:
   *
   *   aircraft   0    "NEVER blue-shifted — the plane must stay hot" (04 §8.3)
   *   terracotta 0.2  brickShadow is "warm, never desaturated to grey" — measured, a full
   *                   lean takes it to sat 0.11, which is that failure exactly
   *   openSea    0    its tint is already deeper and bluer than the core, so leaning toward
   *                   it would LIGHTEN the sea's shadow, which is the opposite of the point
   *
   * The rest lean hard, because they are the ones that were reading grey.
   */
  readonly shadowCool: number;
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
    // Already deeper and bluer than the core; leaning would lighten it.
    shadowCool: 0,
    rampSteps: 3,
    rimColor: SEA.crestHigh.hex, // #e7e6eb foam-white
    // ZERO, and the old note beside it said why before the ocean existed: "rim handed off to
    // 02_WATER.md glints once the ocean exists". That handoff never happened — the glints
    // landed and the rim stayed on underneath them, so the sea carried two sun responses at
    // once. The rim is the wrong one of the two to keep: it is a smooth `pow` of the view
    // angle, so it draws a soft gradient along every wave silhouette, where the glints are the
    // discrete painted marks 02 §3 actually specifies. Same reasoning as the aircraft row
    // below, which has run at zero from the start.
    rimStrength: 0,
    rimPower: 3.5,
    note: 'No rim: the sun response on water is 02 §3\'s painted glints, and was always meant to be.',
  }),

  cloud: preset({
    label: 'Cloud',
    baseColor: SKY.cloudLit.hex, // #ebedea
    shadowTint: SKY.cloudShadow.hex, // #8cbdcb — cyan, NEVER grey
    shadowTintMix: 0.85,
    // Cloud shadow is already cyan by design; a light lean keeps it there and darkens it.
    shadowCool: 0.35,
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
    shadowCool: 0.7,
    rampSteps: 3,
    rimColor: SKY.cloudShadow.hex, // #8cbdcb
    rimStrength: 0.2,
    rimPower: 3.5,
  }),

  limestone: preset({
    label: 'Limestone cliff',
    baseColor: LAND.limestoneLit.hex, // #cbc5ad
    // WAS `limestoneStrata` #726f60, and that was the wrong hex off the right shelf. Strata is
    // the colour of the rock's BEDDING — the horizontal banding `uStrataStrength` draws on a
    // cliff face — not the colour of limestone out of the sun, and the palette carries
    // `limestoneShadow` and `limestoneShadowDeep` for that, both unused until now. Measured,
    // the strata hex put the shadow band at #7a7767: saturation 0.08 and lightness 0.44, which
    // is a mid grey, and limestone is most of the island's surface area.
    shadowTint: LAND.limestoneShadow.hex, // #534a40
    shadowTintMix: 0.85,
    shadowCool: 0.75,
    rampSteps: 4, // strata read best with more bands (04 §2.3)
    rimColor: SKY.horizonHazeFar.hex, // #d0dbdf
    // DOWN TO A TENTH, 0.15 -> 0.015. The rim is the only thing in the gouache ramp that reads
    // as shine — there is no specular lobe anywhere in this renderer — so it is the whole of
    // what "shiny" means on the islands. This row drives the terrain AND the long-grass
    // overlay, which between them are every land surface that goes through the ramp, so one
    // number covers the lot.
    //
    // Left present rather than zeroed: 00 §3 rule 4 wants a thin painted edge where land meets
    // sky, and at 0.015 that edge survives as a hint on the silhouette instead of a sheen
    // across the slopes. Zero is one keystroke away if the hint is unwanted too.
    rimStrength: 0.015,
    rimPower: 3.5,
  }),

  terracotta: preset({
    label: 'Terracotta / buildings',
    baseColor: LAND.terracotta.hex, // #a42a08
    shadowTint: LAND.brickShadow.hex, // #654532 — warm, never desaturated to grey
    shadowTintMix: 0.85,
    // Low on purpose: brickShadow must stay warm, and a full lean measures sat 0.11.
    shadowCool: 0.2,
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
    // Zero, and it must stay zero. See the note on this preset.
    shadowCool: 0,
    rampSteps: 3,
    rimColor: SEA.crestHigh.hex, // #e7e6eb thin edge highlight only
    rimStrength: 0.1,
    rimPower: 6.0, // tight
    note: 'If this ever cools toward blue in shadow or haze, that is a bug (04 §8.3).',
  }),
});

export type SurfaceName = keyof typeof SURFACES;

export const SURFACE_NAMES = Object.freeze(Object.keys(SURFACES) as SurfaceName[]);
