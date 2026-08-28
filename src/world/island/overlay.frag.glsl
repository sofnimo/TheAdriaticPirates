#include ../../render/shading/chunks/gouache_ramp.glsl;
#include ../../render/shading/chunks/csm_shadow.glsl;
#include ../../render/shading/chunks/land_cover.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;

// =====================================================================
// TIER B FRAGMENT — alpha TEST, never alpha blending. `05 §5`.
//
// Surviving fragments are fully opaque and write depth, so the holes need no sorting and the
// base terrain simply shows through them. A transparent material would be pushed into the
// transparent pass and sorted per object, which is the wrong queue for what is really an
// opaque ground layer with holes in it.
//
// The colour is the SHADOW stop of §8.2's three-stop ladder. That is not a coincidence and not
// a saving: tier B is the dark value underpainting the canopy hulls sit on, so when the hulls
// fade out at range the mass they leave behind is already the right tone.
// =====================================================================

uniform vec3 cLongGrass;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec3 normal = normalize(vWorldNormal);
  vec2 worldXZ = vWorldPos.xz;

  vec4 cover = sampleCover(worldXZ);
  vec4 character = sampleCharacter(worldXZ);
  float inland = inlandMetres(worldXZ);

  float weight = longGrassWeight(worldXZ, cover, inland);
  // Rock and sand are vetoes, not weights: long grass does not grow on a limestone face or on
  // a beach whatever the mask says about this texel.
  weight *= 1.0 - rockMask(worldXZ, normal, character, inland);
  weight *= 1.0 - sandMask(worldXZ, character, inland);

  if (weight < uLongGrassThreshold) discard;

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float ndotl = dot(normal, normalize(uSunDirection));
  vec3 color = applyGouacheRamp(cLongGrass, ndotl, sunShadow(vWorldPos, normal), normal, viewDir, 0.0);
  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
