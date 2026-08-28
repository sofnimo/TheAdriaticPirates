#include ../../render/shading/chunks/gouache_ramp.glsl;
#include ../../render/shading/chunks/land_color.glsl;
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

  float ndotl = dot(normal, normalize(uSunDirection));
  vec3 color = applyGouacheRamp(base, ndotl, 1.0, normal, viewDir, 0.0);
  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
