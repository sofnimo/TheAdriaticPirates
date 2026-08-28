#include ./hash_noise.glsl;

// =====================================================================
// CANOPY SHADING — `05 — Distant Terrain Layering.md` §8.
//
// THREE FLAT STOPS, NOT TWO (§2.1). The reference frame clusters at 68% shadow, 24% mid and
// 8% lit; a two-tone split cannot reproduce it. And the ladder is a HUE ROTATION, about 10.5
// degrees per stop with saturation roughly halving (§2.2) — the three colours are authored
// palette entries, and nothing here multiplies one to get another.
//
// DELIBERATELY NOT `base * max(noL, 0)`. A smooth Lambert multiplier gives the airbrushed
// gradient the reference does not have. The split is a pair of hard thresholds on N.L, and the
// lit stop is gated further by a world-anchored dab mask so it covers ~8% of the sun side
// rather than the ~50% a half-Lambert would give (§2.3).
//
// THE NORMAL IS SYNTHETIC AND WORLD-FIXED (§8.1). Per-facet normals on a hull glitter as the
// aircraft circles; the whole point of the tier is that it reads as one painted mass. The
// vertex shader builds a smooth ellipsoidal normal and this function only ever sees that.
// =====================================================================

uniform vec3 cCanopyDark;
uniform vec3 cCanopyMid;
uniform vec3 cCanopyLight;
uniform float uSplitMid;
uniform float uSplitLit;
uniform float uDabDensity;
uniform float uDabScale;

/**
 * @param canopyNormal synthetic, world space, normalised
 * @param sunDir       normalised, surface toward sun
 * @param worldPos     for the world-anchored dab lookup — never a screen coordinate
 * @param seed         per-hull, so neighbouring crowns do not share a dab phase
 */
vec3 canopyStops(vec3 canopyNormal, vec3 sunDir, vec3 worldPos, float seed) {
  float noL = dot(canopyNormal, sunDir);

  // Two spatial frequencies (§8.3 rule 1): a broad 20-80 m modulation that splits masses, and
  // the dab shapes themselves at a scale comparable to the masses rather than fine speckle.
  float broad = fbm2(worldPos.xz / 46.0);
  float dab = fbm2(worldPos.xz / max(uDabScale, 1.0) + seed * 17.3);

  float midMask = step(uSplitMid, noL + (broad - 0.5) * 0.18);
  float litMask = step(uSplitLit, noL) * step(1.0 - uDabDensity * 3.0, dab);

  vec3 c = mix(cCanopyDark, cCanopyMid, midMask);
  return mix(c, cCanopyLight, litMask);
}
