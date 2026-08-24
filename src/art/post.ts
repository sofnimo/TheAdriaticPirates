import { LIGHT } from './budgets';

/**
 * THE POST CHAIN'S AUTHORED VALUES — `04 — Light and Shadow.md` §4.1, §7.3, §7.4,
 * consolidated in §8.2. Bound by `00 — Art Direction Bible.md` §5's post-chain line:
 *
 *   "Depth-colour fog -> bloom (tight threshold, only for sun glare and foam) -> grain
 *    -> subtle chroma/vignette. Order matters."
 *
 * DATA ONLY — this module must never import three.js.
 *
 * Every number here is the middle of a range the doc gives, not a taste call. The ranges
 * live in art/budgets.ts (LIGHT, transcribed from 04 §8.2) and `checkPostContract()`
 * asserts these values against them, so "I nudged the grain up a bit" cannot quietly
 * leave the contract.
 */

export const POST = Object.freeze({
  /**
   * 04 §4.1. The threshold is the whole game: it is what keeps bloom off the terrain and
   * the sea's lit band. It is compared against LINEAR luminance in the composer's
   * half-float buffer, and the brightest thing the palette can put on screen is
   * `#ebedea` (cloud lit) at 0.833 linear — below 0.92 with room to spare. Only the sky
   * dome's sun disc, which writes above 1.0, crosses it. The post gate measures both
   * halves of that claim rather than asserting it.
   */
  bloom: Object.freeze({
    threshold: 0.92,
    strength: 0.5,
    /** Small kernel: a tight bloom reads as bright paint, a wide one as a camera lens. */
    radius: 0.25,
  }),

  /**
   * 04 §7.3 + 00 §2 rule 8: "a very subtle STATIC grain + 1-2% chroma wobble... below the
   * threshold of 'effect'."
   *
   * Static is the operative word and it is where this diverges from 04 §7.3's snippet,
   * which seeds its hash with `uTime`. Paper grain does not crawl. `animate` exists only
   * as the negative control (`?grain=animated`), which the stability check catches.
   */
  grain: Object.freeze({
    /** Achromatic, one value added to all three channels. Display space, post-sRGB. */
    strength: 0.028,
    /** Per-channel multiplicative wobble: each channel scaled by 1 +/- this, mean removed
     *  so it moves CHROMA and not brightness. 1-2% is rule 8's own figure. */
    chromaWobble: 0.015,
    /** Wobble cell size in pixels. Low frequency — ink/paper drift across the frame, not
     *  colour speckle sitting on top of the grain at the same scale. */
    wobbleCellPx: 96,
  }),

  /**
   * 04 §7.4. A lens artifact, so this one genuinely may be a soft multiply — it is the
   * single exception to 00 §3 rule 2. Kept where it cannot frame the shot: rule 10 wants
   * the "70% uninterrupted flat sea" compositions unobstructed.
   */
  vignette: Object.freeze({
    /** Darkening at the extreme corner, as a fraction. */
    corner: 0.07,
    /** Fraction of the corner radius where the falloff starts. Nothing before this. */
    falloffStart: 0.75,
  }),
});

/** Sabotage values for the standing negative controls. See main.ts's header. */
export const POST_SABOTAGE = Object.freeze({
  /** `?bloom=low` — the failure 04 §4.1 describes: bloom bleeding into every midtone. */
  bloomThreshold: 0.35,
  /** `?grain=heavy` — grain crossing 04 §8.2's 0.035 ceiling and reading as an effect. */
  grainStrength: 0.12,
  /** `?vignette=heavy` — a vignette that visibly frames the shot (04 §8.3). */
  vignetteCorner: 0.28,
});

const inRange = (v: number, [lo, hi]: readonly [number, number]): boolean => v >= lo && v <= hi;

/**
 * Returns a list of 04 §8.2 range violations, empty if clean.
 *
 * Non-throwing on purpose, matching checkRendererContract: the gate wants to render and
 * measure the damage while the contract is broken, because seeing how far a sabotaged
 * value moves the picture is the informative part.
 */
export function checkPostContract(post: typeof POST = POST): string[] {
  const problems: string[] = [];

  if (!inRange(post.bloom.threshold, LIGHT.bloomThresholdRange)) {
    problems.push(
      `bloom.threshold ${post.bloom.threshold} outside 04 §8.2's ${fmt(LIGHT.bloomThresholdRange)}`,
    );
  }
  if (!inRange(post.bloom.strength, LIGHT.bloomStrengthRange)) {
    problems.push(`bloom.strength ${post.bloom.strength} outside 04 §8.2's ${fmt(LIGHT.bloomStrengthRange)}`);
  }
  if (!inRange(post.bloom.radius, LIGHT.bloomRadiusRange)) {
    problems.push(`bloom.radius ${post.bloom.radius} outside 04 §8.2's ${fmt(LIGHT.bloomRadiusRange)}`);
  }
  if (!inRange(post.grain.strength, LIGHT.grainStrengthRange)) {
    problems.push(`grain.strength ${post.grain.strength} outside 04 §8.2's ${fmt(LIGHT.grainStrengthRange)}`);
  }
  if (!inRange(post.grain.chromaWobble, LIGHT.chromaWobbleRange)) {
    problems.push(
      `grain.chromaWobble ${post.grain.chromaWobble} outside 04 §8.2's ${fmt(LIGHT.chromaWobbleRange)}`,
    );
  }
  if (!inRange(post.vignette.corner, LIGHT.vignetteCornerRange)) {
    problems.push(`vignette.corner ${post.vignette.corner} outside 04 §8.2's ${fmt(LIGHT.vignetteCornerRange)}`);
  }

  return problems;
}

function fmt([lo, hi]: readonly [number, number]): string {
  return `${lo}-${hi}`;
}

/** sRGB byte -> linear, the transfer function three's ColorManagement uses. */
export function srgbByteToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Rec.709 luminance of an sRGB hex, in LINEAR light — the space bloom thresholds in. */
export function linearLuminanceOfHex(hex: number): number {
  const r = srgbByteToLinear((hex >> 16) & 0xff);
  const g = srgbByteToLinear((hex >> 8) & 0xff);
  const b = srgbByteToLinear(hex & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
