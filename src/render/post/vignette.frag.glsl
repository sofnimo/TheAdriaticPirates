// =====================================================================
// VIGNETTE — `04 — Light and Shadow.md` §7.4.
//
// "Barely perceptible... max 6-8% darkening at the corners, falloff starting past 75% of
// the frame radius, so it never reads as a deliberate frame or masks the '70%
// uninterrupted flat sea' compositions the art direction wants preserved (rule 10)."
//
// THIS IS THE ONE SANCTIONED MULTIPLY IN THE WHOLE RENDERER. 00 §3 rule 2 bans
// multiply-darkening everywhere, and 04 §7.4 carves out exactly this exception, on the
// grounds that a vignette is a LENS artifact rather than a scene shadow: it is not light
// failing to reach a surface, so it has no shadow hue to shift toward. Every other
// darkening in this codebase goes through the gouache ramp's authored tint. If you find
// yourself reaching for `* 0.5` somewhere else, that is the bug this comment exists for.
//
// The falloff is radial in UV, so `r` is 1.0 at all four corners whatever the aspect
// ratio. A screen-space circle would instead put the full 7% on the left and right edges
// of a 16:9 frame while the corners took more — visible banding down the sides of the very
// open-sea compositions rule 10 protects.
// =====================================================================

uniform sampler2D tDiffuse;
/** Darkening at the extreme corner, as a fraction. 0.06-0.08 (04 §8.2). */
uniform float uVignetteCorner;
/** Fraction of the corner radius where falloff starts. Nothing happens before this. */
uniform float uVignetteFalloffStart;

varying vec2 vUv;

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);

  // length(vec2(0.5)) is the centre-to-corner distance in UV, so r == 1 exactly at a corner.
  float r = length(vUv - 0.5) / 0.7071067811865476;
  float v = smoothstep(uVignetteFalloffStart, 1.0, r);

  gl_FragColor = vec4(texel.rgb * (1.0 - v * uVignetteCorner), texel.a);
}
