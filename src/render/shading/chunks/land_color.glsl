#include ./land_cover.glsl;

// =====================================================================
// TIER A0 + A1 — the base terrain material. `05 §4`.
//
// Four materials, blended in a strict order: sand over rock over dried grass over short grass.
// Order matters because the rules are vetoes, not weights — a cliff is never a beach however
// much sand drifted past it, and dried grass exists only INSIDE the light-grass branch and
// must never tint sand, rock or the tier-B overlay above it (§4).
//
// TWO SPATIAL SCALES, NEVER ONE (§4, anti-tiling). A broad baked mask that defines readable
// masses, plus one decorrelated world-space detail noise. A single frequency reads either as
// featureless blocking or as texture; the art bible forbids both.
//
// The dried grass is an INTERPOLATION BETWEEN TWO AUTHORED COLOURS, never a brightness
// multiply on the green (§4, and 00 rule 2). That is the difference between a sun-dried
// hillside and an underexposed one.
// =====================================================================

uniform vec3 cCliff;
uniform vec3 cCliffStrata;
uniform vec3 cSand;
uniform vec3 cGrass;
uniform vec3 cGrassDry;

uniform float uStrataMetres;
uniform float uStrataStrength;

/**
 * §3.2's stratification, driven off world Y so the beds stay horizontal on any face.
 *
 * Quantised to a hard two-tone edge rather than a gradient (00 rule 1), and faded out on
 * near-horizontal ground: a bedding plane seen face-on is a floor, not a band, and letting the
 * function run there draws contour lines across every gentle slope on the island.
 */
vec3 limestone(vec3 worldPos, vec3 normal) {
  float verticality = 1.0 - clamp(normal.y, 0.0, 1.0);
  float bed = worldPos.y / max(uStrataMetres, 0.5);
  // A per-bed jitter, so beds are not perfectly even in thickness the way a fract() is.
  float band = fract(bed + hash11(floor(bed)) * 0.22);
  float edge = step(0.5, band);
  float strength = uStrataStrength * smoothstep(0.25, 0.65, verticality);
  return mix(cCliff, cCliffStrata, edge * strength);
}

/** A0's short grass with A1's dried patches composited inside it. */
vec3 grassColor(vec2 worldXZ, vec4 cover) {
  // The baked mask is the mass; this is the small decorrelated detail that keeps its edges
  // from reading as one smooth blob field.
  float detail = fbm2(worldXZ / 19.0 + 91.7) - 0.5;
  float dry = clamp(cover.r * uDryBoost + detail * 0.35, 0.0, 1.0);
  dry = smoothstep(0.5 - uDrySoftness, 0.5 + uDrySoftness, dry);
  return mix(cGrass, cGrassDry, dry);
}

/**
 * The base terrain colour.
 *
 * THE FOREST TINT IS GONE WITH THE TREES. This used to fold `forestWeight` in here — the
 * low-frequency dark coverage of the forest baked into A0's own colour, using the same shadow
 * stop the canopy hulls were painted in. That was §9's C3 far handoff: it kept the forest
 * footprint identical at every LOD, so when the hulls faded the ground underneath was already
 * the right colour and nothing changed shape.
 *
 * With tier C removed it had nothing left to hand off to, and leaving it would have been worse
 * than pointless — dark green patches shaped exactly like groves, on islands with no trees on
 * them. A shadow cast by something that is not there.
 */
vec3 landColor(vec3 worldPos, vec3 normal) {
  vec2 worldXZ = worldPos.xz;
  vec4 cover = sampleCover(worldXZ);
  vec4 character = sampleCharacter(worldXZ);
  float inland = inlandMetres(worldXZ);

  vec3 color = grassColor(worldXZ, cover);
  color = mix(color, limestone(worldPos, normal), rockMask(worldXZ, normal, character, inland));
  color = mix(color, cSand, sandMask(worldXZ, character, inland));
  return color;
}
