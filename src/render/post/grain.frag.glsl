// =====================================================================
// GRAIN + CHROMA WOBBLE — `04 — Light and Shadow.md` §7.3, `00 — Art Direction
// Bible.md` §3 rule 8: "a very subtle STATIC grain + 1-2% chroma wobble... below the
// threshold of 'effect'."
//
// Runs in DISPLAY SPACE, after OutputPass. 04 §7.1 puts grain and chroma last "so they
// sit on top of the final graded image uniformly, exactly like scan/print artifacts sit
// on top of a finished painting rather than being lit by it". A grain added before the
// sRGB encode would be lit by it instead: the same linear amplitude reads as a whisper
// in the highlights and as a shout in the sea's near-black shadow band, because the
// encode's slope near zero is ~12x. Post-encode, one amplitude means one visible
// amplitude everywhere, which is what "paper grain" actually is.
//
// TWO DELIBERATE DIVERGENCES FROM 04 §7.3'S SNIPPET
//
// 1. STATIC, not time-seeded. The snippet writes `hash(uv * ... + uTime * 60.0)`, which
//    crawls. Rule 8 says "static grain" and means it — paper does not boil. The hash is
//    seeded from gl_FragCoord alone, so consecutive frames are byte-identical and the
//    gate can assert that rather than hope for it. `uAnimateSeed` exists ONLY as the
//    standing negative control (`?grain=animated`); it is 0 in every shipping path.
//
// 2. CHROMA WOBBLE IS A PER-CHANNEL GAIN DRIFT, NOT AN RGB SPLIT. The snippet offsets the
//    R and B taps by a fraction of a pixel, which is lens chromatic aberration — a camera
//    artifact, and one that softens every hard edge 00 §3 rule 3 exists to protect. Rule 8
//    asks for the mark of a printed/painted origin, so this is instead a low-frequency
//    drift in the ink balance across the sheet: each channel's GAIN wanders +/-1.5% over a
//    ~96 px cell. Nothing moves, so nothing is softened.
//
// The wobble's mean is removed under Rec.709 weights, so the three channel gains average
// to exactly 1 in luma terms: the effect moves colour and leaves brightness alone. That is
// a measurable claim, and dev/PostProbe.ts measures it.
// =====================================================================

uniform sampler2D tDiffuse;

/** 0.02-0.035 (04 §8.2). Achromatic, added to all three channels. */
uniform float uGrainStrength;
/** 0.01-0.02 (rule 8's own figure), as a +/- fraction of each channel's gain. */
uniform float uChromaWobble;
/** Wobble cell size in PIXELS. Low frequency — ink drift, not speckle. */
uniform float uWobbleCellPx;
/** Non-zero only under `?grain=animated`, the negative control for the stability check. */
uniform float uAnimateSeed;

varying vec2 vUv;

const vec3 REC709 = vec3(0.2126, 0.7152, 0.0722);

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 hash32(vec2 p) {
  return vec3(
    hash12(p),
    hash12(p + 19.19),
    hash12(p + 71.53)
  );
}

/**
 * Smooth per-channel value noise on a `uWobbleCellPx` grid.
 *
 * Bilinear between corner hashes rather than a bare per-cell lookup: a hard cell grid at
 * this amplitude reads as faint rectangular patches, which is a compression artifact, not
 * paper. 00 §3 rule 7 ("no visible tiling") applies to the grade as much as to the ground.
 */
vec3 wobbleAt(vec2 px) {
  vec2 cell = px / max(uWobbleCellPx, 1.0);
  vec2 i = floor(cell);
  vec2 f = fract(cell);
  f = f * f * (3.0 - 2.0 * f);

  vec3 a = hash32(i);
  vec3 b = hash32(i + vec2(1.0, 0.0));
  vec3 c = hash32(i + vec2(0.0, 1.0));
  vec3 d = hash32(i + vec2(1.0, 1.0));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  vec3 col = texel.rgb;

  // ---- chroma wobble: multiplicative, luma-neutral ----------------------------------
  vec3 w = wobbleAt(gl_FragCoord.xy) - 0.5;   // -0.5 .. 0.5 per channel
  // Remove the REC.709-WEIGHTED mean, not the arithmetic one. Removing the arithmetic mean
  // preserves r+g+b, which is not the same as preserving brightness — green carries 71% of
  // the luma and blue 7%, so an equal-and-opposite green/blue swap still visibly changes
  // the value. Weighted, dot(w, REC709) == 0 and the gain is luma-neutral to first order.
  w -= dot(w, REC709);
  col *= 1.0 + w * 2.0 * uChromaWobble;

  // ---- grain: achromatic, static, additive -------------------------------------------
  // gl_FragCoord, not vUv * resolution: one grain sample per framebuffer pixel, unchanged
  // by anything but a resize, which is what makes the frame-to-frame stability check exact.
  float g = (hash12(gl_FragCoord.xy + uAnimateSeed) - 0.5) * uGrainStrength;
  col += g;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), texel.a);
}
