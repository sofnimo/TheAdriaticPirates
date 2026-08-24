#include ../../render/shading/chunks/gouache_ramp.glsl;
#include ../../render/shading/chunks/terrain_color.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;

// =====================================================================
// ISLAND FRAGMENT — `03 — Procedural Islands.md`.
//
// Same order as the sea, deliberately: base colour first, then the SHARED gouache ramp, then
// haze. `terrain_color.glsl` decides what colour the ground is; it never decides how it is
// lit. That split is what lets one ramp chunk serve water, rock, scrub and cloud without
// forking, which 04 §2 requires.
//
// The one place land and sea differ is aerial perspective, and they differ because the
// reference frames do: land desaturates with distance (00 §3 rule 5, measured at s=0.09-0.20
// on distant islands) while the sea holds its saturation until the final band. So this calls
// the plain `applyAerialPerspective`, which is rule 5's curve untouched.
// =====================================================================

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vExposure;

void main() {
  vec3 normal = normalize(vWorldNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  vec3 base = terrainColor(vWorldPos, normal, vExposure);

  vec3 sunDir = normalize(uSunDirection);
  float ndotl = dot(normal, sunDir);
  vec3 color = applyGouacheRamp(base, ndotl, 1.0, normal, viewDir, 0.0);

  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
