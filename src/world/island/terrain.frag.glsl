#include ../../render/shading/chunks/gouache_ramp.glsl;
#include ../../render/shading/chunks/csm_shadow.glsl;
#include ../../render/shading/chunks/land_color.glsl;
#include ../../render/shading/chunks/shore.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;

// =====================================================================
// TIER A0/A1 FRAGMENT.
//
// Same three-stage order as the sea, deliberately: base colour, then the SHARED gouache ramp,
// then haze. `land_color.glsl` decides what colour the ground is and never decides how it is
// lit; the ramp decides how it is lit and never decides what colour it is. That split is the
// only reason one ramp chunk can serve water, rock, grass and cloud without being forked.
// =====================================================================

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec3 normal = normalize(vWorldNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  vec3 base = landColor(vWorldPos, normal);

  // WET SAND, on the albedo and before the ramp.
  //
  // The land half of the waterline, and until now it was written and never called — the chunk
  // has carried `applyWetSand` since 02b §5 went in, with nothing invoking it, so the beach
  // stayed bone dry while surf broke a metre away. It runs on the same swash phase as the foam,
  // so the damp band is the mark the wave that just broke left behind rather than a second
  // animation running near the first.
  //
  // BEFORE the ramp on purpose, and for the reason the whole file is ordered this way: wet sand
  // is a different COLOUR of sand, not sand in shadow. Applying it after would be tinting the
  // lit result, which is the mistake `land_color.glsl` and the ramp are split up to prevent.
  base = applyWetSand(base, vWorldPos.xz, cWetSand, uWetSandBand);

  float ndotl = dot(normal, normalize(uSunDirection));
  vec3 color = applyGouacheRamp(base, ndotl, sunShadow(vWorldPos, normal), normal, viewDir, 0.0);
  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
