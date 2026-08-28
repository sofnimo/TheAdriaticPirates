#include ../../render/shading/chunks/gouache_ramp.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;

// =====================================================================
// THE AIRCRAFT — the shared gouache ramp, unforked (04 §2.3).
//
// One flat base colour per mass, run through the same band ramp the terrain, the water and
// the clouds use. The aircraft is the one object in the frame the camera is always close to,
// so it is the one that would most obviously give the game away if it were lit differently
// from the world it is flying over — which is precisely why it must not have its own shader.
// =====================================================================

uniform vec3 uBaseColor;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec3 normal = normalize(vWorldNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  // Two-sided: the hull is built from open boxes and a backface must not read as unlit.
  if (dot(normal, viewDir) < 0.0) normal = -normal;

  float ndotl = dot(normal, normalize(uSunDirection));
  vec3 color = applyGouacheRamp(uBaseColor, ndotl, 1.0, normal, viewDir, 0.0);
  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
