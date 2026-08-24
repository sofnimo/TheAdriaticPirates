#include ./hash_noise.glsl;
#include ./sea_depth.glsl;

// =====================================================================
// CONTINUOUS DEPTH -> SEA COLOUR — `02 — Water.md` §2.2.
//
// "The shelf transition is the most important colour event in the entire game" (00 §2).
//
// This used to quantise depth into 5 flat bands with hard floor() edges. That targeted the
// wrong effect. Sampling the reference frames directly: on a clean water column in the cove
// frame (image-3.jpg x=500) the colour changes on essentially EVERY row — mean step 1.2/255,
// longest near-flat run 6 px out of 133 — with no plateau-then-jump anywhere. The sky
// gradient behaves the same way. There are no bands in the source material.
//
// So the ramp is now a continuous LUT fetch. What survives from the banded version is the
// noise: it still perturbs the DEPTH SIGNAL, so iso-colour contours wander at shape scale
// instead of tracing the bathymetry exactly. The difference is that the output colour is no
// longer quantised afterwards — the contours wander, the colour does not step.
//
// This is the BASE COLOUR only. The stepped gouache lit/shadow ramp still runs on top of it,
// unchanged: colour continuous, light response banded. See `04 — Light and Shadow.md`.
// =====================================================================

uniform sampler2D uSeaRamp;     // 256x1 LUT baked from art/seaRamp.ts, sRGB-tagged
uniform float uEdgeNoiseScale;  // world metres per noise unit (SHAPE scale, not texture)
uniform float uEdgeNoiseAmount; // +/- fraction of depth01 the contours wander

/**
 * SABOTAGE TOGGLE — 0 in every shipping path. Set from `?bands=N`.
 *
 * Puts the old quantiser back, so the smoothness gate has a working negative control that
 * lives in the codebase rather than in a throwaway experiment. A gate nobody has watched fail
 * is not evidence. Kept permanently, alongside `?tonemap=aces`.
 */
uniform float uBandSabotage;

/**
 * Depth with its contours wandered by shape-scale noise.
 *
 * Kept from the banded version on purpose. A mathematically perfect iso-contour reads as a
 * level-set diagram, which is its own failure mode; the wander is what makes the shelf edge
 * look painted. It just must not be followed by a quantiser.
 */
float wanderedDepth(float depth01, vec2 worldXZ) {
  float n = (fbm2(worldXZ / uEdgeNoiseScale) - 0.5) * 2.0 * uEdgeNoiseAmount;
  return clamp(depth01 + n, 0.0, 1.0);
}

/**
 * Sampled depth ramp: shallow sand-lit green -> turquoise shelf -> near-black teal -> deep
 * blue. Every stop was read off a reference frame; see `art/seaRamp.ts` for the citations.
 *
 * Half a texel of inset so LINEAR filtering cannot clamp-bleed at the ends, which would
 * flatten the two extreme stops into short plateaus — the exact artefact being removed.
 */
vec3 seaColor(float depth01) {
  float d = clamp(depth01, 0.0, 1.0);
  if (uBandSabotage > 0.5) {
    d = min(floor(d * uBandSabotage), uBandSabotage - 1.0) / uBandSabotage;
  }
  float u = d * (255.0 / 256.0) + (0.5 / 256.0);
  return texture2D(uSeaRamp, vec2(u, 0.5)).rgb;
}

/** Shadow tint for the ramp, following the depth so shallows never go navy. */
vec3 seaShadowTint(float depth01, vec3 lagoonEdge, vec3 seaShadow) {
  return mix(lagoonEdge, seaShadow, smoothstep(0.2, 0.75, depth01));
}
