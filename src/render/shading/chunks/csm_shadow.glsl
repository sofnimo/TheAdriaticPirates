// =====================================================================
// THE SHARED CASCADE LOOKUP — `04 — Light and Shadow.md` §3.
//
// One function, called by every surface that receives a shadow: terrain, the tier-B overlay,
// the canopy hulls, the sea, and the gouache material the props use. It returns the raw
// shadow factor and NOTHING ELSE — it does not decide what a shadow looks like. That belongs
// to `gouache_ramp.glsl`, which cuts this to binary with `step(0.5, ...)` and then snaps the
// fragment to a hue-shifted band rather than darkening it (00 §3 rules 2 and 3, 04 §3.3).
//
// Keeping the two apart is what lets the sea take its shadow tint from its own depth ramp
// while the limestone takes one from the palette, off the same lookup.
//
// SAMPLED AS A COMPARISON, NOT AS A DEPTH READ. three renders directional shadow maps into a
// real `DepthTexture` with `compareFunction = LessEqualCompare` under `PCFShadowMap`, so the
// hardware does the depth test and the 2x2 filter in one fetch. That residual 2x2 is the only
// softening in the whole system, and the ramp's binary cut removes even that — which is the
// point of §3.3: correct perspective from a real shadow map, but an edge that reads as a
// painted silhouette.
// =====================================================================

uniform float uCsmEnabled;
uniform float uCsmCount;
uniform float uCsmMapSize;
uniform float uCsmBias;
/** World metres per shadow texel, per cascade. Drives the normal offset below. */
uniform vec4 uCsmTexel;

uniform sampler2DShadow uCsmMap0;
uniform sampler2DShadow uCsmMap1;
uniform sampler2DShadow uCsmMap2;
uniform sampler2DShadow uCsmMap3;

uniform mat4 uCsmMatrix0;
uniform mat4 uCsmMatrix1;
uniform mat4 uCsmMatrix2;
uniform mat4 uCsmMatrix3;

/** True when the projected point actually lands inside this cascade's map. */
bool csmInside(vec3 c) {
  return c.x >= 0.0 && c.x <= 1.0 && c.y >= 0.0 && c.y <= 1.0 && c.z <= 1.0;
}

/**
 * The lit fraction at a world point.
 *
 * CASCADE CHOICE IS BY CONTAINMENT, NOT BY DISTANCE. The usual scheme compares the fragment's
 * view depth against the split distances, which needs the splits, the camera axis and a rule
 * for what happens in the overlap. Testing the cascades in order and taking the first that
 * contains the point gets the same answer — cascade 0 is the tightest, so the first hit is
 * always the densest one available — costs three matrix multiplies, and cannot disagree with
 * the fit, because it IS the fit.
 *
 * The normal offset is scaled by the cascade's own world texel size. A fixed offset in metres
 * is either acne in the near cascade or peter-panning in the far one; the artefact it exists
 * to fix is a texel-sized quantity, so the fix is too (§3.2).
 *
 * @param worldPos    the receiving fragment, world space
 * @param worldNormal normalised; used only to push the sample off the surface
 */
float sunShadow(vec3 worldPos, vec3 worldNormal) {
  if (uCsmEnabled < 0.5) return 1.0;

  vec4 c;
  vec3 p;

  p = worldPos + worldNormal * uCsmTexel.x * 1.5;
  c = uCsmMatrix0 * vec4(p, 1.0);
  c.xyz /= c.w;
  if (csmInside(c.xyz)) return texture(uCsmMap0, vec3(c.xy, c.z + uCsmBias));

  if (uCsmCount > 1.5) {
    p = worldPos + worldNormal * uCsmTexel.y * 1.5;
    c = uCsmMatrix1 * vec4(p, 1.0);
    c.xyz /= c.w;
    if (csmInside(c.xyz)) return texture(uCsmMap1, vec3(c.xy, c.z + uCsmBias));
  }

  if (uCsmCount > 2.5) {
    p = worldPos + worldNormal * uCsmTexel.z * 1.5;
    c = uCsmMatrix2 * vec4(p, 1.0);
    c.xyz /= c.w;
    if (csmInside(c.xyz)) return texture(uCsmMap2, vec3(c.xy, c.z + uCsmBias));
  }

  if (uCsmCount > 3.5) {
    p = worldPos + worldNormal * uCsmTexel.w * 1.5;
    c = uCsmMatrix3 * vec4(p, 1.0);
    c.xyz /= c.w;
    if (csmInside(c.xyz)) return texture(uCsmMap3, vec3(c.xy, c.z + uCsmBias));
  }

  // Past the last cascade there is no shadow information, and inventing one would draw a hard
  // terminator across open water at a fixed range from the camera.
  return 1.0;
}
