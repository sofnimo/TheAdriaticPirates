/**
 * THE PALETTE — transcribed verbatim from `00 — Art Direction Bible.md` §2.
 *
 * These are measured dominant clusters sampled from the six reference frames, not
 * guesses. They are the anchor set; everything else in the world is interpolated
 * between them. Per the art bible and the doc index, `00` is the binding contract:
 * no other module may re-sample colour from screenshots or hardcode a hex inline.
 *
 * DATA ONLY — this module must never import three.js. The renderer layer converts.
 */

/** A colour role: the authored sRGB hex plus the note that justifies it. */
export interface Swatch {
  readonly hex: number;
  readonly role: string;
  /** Verbatim or near-verbatim note from 00 §2, kept so intent survives refactors. */
  readonly note?: string;
}

const s = (hex: number, role: string, note?: string): Swatch =>
  Object.freeze(note === undefined ? { hex, role } : { hex, role, note });

/* ------------------------------------------------------------------ *
 * Deep open sea — the signature colour
 * ------------------------------------------------------------------ */
export const SEA = Object.freeze({
  abyssal: s(0x0c3273, 'Abyssal / far-from-land', 'Frame 1. Almost ultramarine ink.'),
  deepSunlit: s(0x024892, 'Deep sea, sunlit', 'The workhorse open-water tone.'),
  deepSunlitAlt: s(0x033a82, 'Deep sea, sunlit (alt)'),
  midChop: s(0x014575, 'Mid-blue sea, chop-lit', 'Frame 5. Slightly greener, hazier.'),
  midChopAlt: s(0x03547c, 'Mid-blue sea, chop-lit (alt)'),
  shadow: s(0x012438, 'Sea in shadow / under cloud', 'Used as a HARD-EDGED patch, not a soft falloff.'),
  shadowAlt: s(0x02365b, 'Sea in shadow (alt)'),
  crestLow: s(0x488a95, 'Wave-crest / foam-streak highlight, low', 'Only 3-6% of sea pixels. Discrete dashes.'),
  crestMid: s(0xa6b5d5, 'Wave-crest / foam-streak highlight, mid'),
  crestHigh: s(0xe7e6eb, 'Wave-crest / foam-streak highlight, high'),
});

/* ------------------------------------------------------------------ *
 * Shallow / coastal water
 * The shelf transition is THE most important colour event in the game:
 * a visible band edge across ~40px, never a blur. (02_WATER.md §2.2)
 * ------------------------------------------------------------------ */
export const COAST = Object.freeze({
  lagoonEdge: s(0x074d5c, 'Deep lagoon edge'),
  turquoiseShelf: s(0x14707c, 'Turquoise shelf'),
  shallowSandLit: s(0x498e8e, 'Bright shallow sand-lit'),
  shallowSandLitMid: s(0x309dac, 'Bright shallow sand-lit (mid)'),
  shallowSandLitHigh: s(0x62afb4, 'Bright shallow sand-lit (high)'),
});

/* ------------------------------------------------------------------ *
 * Sky — a real cyan, not a pale blue
 * ------------------------------------------------------------------ */
export const SKY = Object.freeze({
  zenith: s(0x1ca6c7, 'Zenith'),
  zenithDeep: s(0x169abb, 'Zenith (deep)'),
  mid: s(0x4ba8c6, 'Mid sky'),
  midAlt: s(0x69b2cb, 'Mid sky (alt)'),
  horizonHaze: s(0xb1cbd3, 'Horizon haze', 'Aerial perspective lerps TOWARD this, never toward grey.'),
  horizonHazeFar: s(0xd0dbdf, 'Horizon haze (far)'),
  cloudLit: s(0xebedea, 'Cloud lit face', 'Near-white, very slightly warm/green-grey.'),
  cloudShadow: s(0x8cbdcb, 'Cloud shadow face', 'Clouds shade TOWARDS the sky cyan, never towards grey.'),
  cloudShadowAlt: s(0x9bb5a8, 'Cloud shadow face (alt)'),
  /**
   * WHAT SHADOW IS THE COLOUR OF. The one hex every surface's shadow band leans toward.
   *
   * It lives in SKY because that is the argument for it: a surface out of the sun is not
   * unlit, it is lit by the sky instead, so its shadow takes the sky's colour rather than a
   * darker version of its own. That is the physical reading of 00 §3 rule 2's "hue shift, not
   * base * 0.5", and it is why shadows in the reference frames are blue on warm stone.
   *
   * Dark and properly chromatic — sat 0.75 at lightness 0.15. A desaturated navy would land
   * every shadow back on the grey this exists to get rid of.
   */
  shadowDeep: s(0x0a2a45, 'Shadow core (sky blue, dark)', 'Shadows lean TOWARDS this, never towards grey.'),
});

/* ------------------------------------------------------------------ *
 * Land
 * ------------------------------------------------------------------ */
export const LAND = Object.freeze({
  forestDense: s(0x1f4e38, 'Dense forest / shadow mass'),
  forestDeep: s(0x101d19, 'Dense forest / shadow mass (deep)'),
  canopyMid: s(0x45764e, 'Mid canopy'),
  forestSparse: s(0x45764e, 'Sparse forest', '03 §7.2 sparse-forest anchor.'),
  scrubOlive: s(0x6a955f, 'Sparse scrub / olive'),
  scrubOlivePale: s(0x8eac71, 'Sparse scrub / olive (pale)'),
  pastureDry: s(0xa8b19d, 'Dry pasture, sun-bleached grass'),
  pastureBleached: s(0xc8cdbe, 'Dry pasture (bleached)'),
  limestoneLit: s(0xcbc5ad, 'Limestone cliff, lit'),
  limestoneLitPale: s(0xd6d2cc, 'Limestone cliff, lit (pale)'),
  limestoneStrata: s(0x726f60, 'Limestone strata / shadow'),
  limestoneShadow: s(0x534a40, 'Limestone shadow'),
  limestoneShadowDeep: s(0x2e312b, 'Limestone shadow (deep)'),
  sand: s(0xcbc5ad, 'Beach sand'),
  sandWarm: s(0xddd0a8, 'Beach sand, warmed'),
  sandWet: s(0x8f8874, 'Beach sand, wet', '02b §5 wet-sand tint. Cool/dark shift of the dry sand, applied as a tint lerp per 00 §3 rule 2 — never a multiply.'),
  terracotta: s(0xa42a08, 'Terracotta roof, brick, harbour detail'),
  brickShadow: s(0x654532, 'Brick / harbour detail shadow'),
});

/* ------------------------------------------------------------------ *
 * THE HERO ACCENT — RESERVE IT
 *
 * 00 §2: "No natural surface in the world may use saturated red. Red is the
 * player, the roofs, and the Italian tricolour rudder. This is why the sea is
 * allowed to be so blue."
 * ------------------------------------------------------------------ */
export const ACCENT = Object.freeze({
  planeVermilion: s(0xc63427, 'Plane vermilion', 'RESERVED. Hero accent.'),
  planeVermilionDeep: s(0xb63118, 'Plane vermilion (deep)', 'RESERVED. Hero accent.'),
  terracottaAccent: s(0xa42a08, 'Terracotta', 'RESERVED. Roofs and harbour detail only.'),
});

export const PALETTE = Object.freeze({ SEA, COAST, SKY, LAND, ACCENT });

/** Family name -> ordered swatch list. Used by the palette gate and debug UI. */
export const PALETTE_FAMILIES: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, Swatch]>]> =
  Object.freeze(
    (Object.entries(PALETTE) as ReadonlyArray<[string, Record<string, Swatch>]>).map(
      ([family, group]) => [family, Object.freeze(Object.entries(group))] as const,
    ),
  );

/** Flat list of every authored swatch, in declaration order. */
export const ALL_SWATCHES: ReadonlyArray<{ family: string; key: string; swatch: Swatch }> = Object.freeze(
  PALETTE_FAMILIES.flatMap(([family, entries]) =>
    entries.map(([key, swatch]) => ({ family, key, swatch })),
  ),
);

/** `0x024892` -> `#024892`. */
export function hexString(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** `0x024892` -> `[2, 72, 146]`, the authored sRGB bytes. */
export function hexBytes(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}
