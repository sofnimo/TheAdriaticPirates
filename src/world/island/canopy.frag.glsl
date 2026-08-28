#include ../../render/shading/chunks/canopy_shade.glsl;
#include ../../render/shading/chunks/csm_shadow.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;

// =====================================================================
// TIER C FRAGMENT.
//
// This is the one land surface that does NOT go through the gouache ramp, and the reason is in
// the doc rather than in convenience: §8.2 specifies three flat stops for vegetation against
// the ramp's two-to-four generic bands, and §2.2 measures the ladder as a hue rotation with
// falling saturation rather than the ramp's tint-toward-a-shadow-hex. Running the canopy
// through the generic ramp would flatten a measured three-stop ladder into a generic one.
//
// Haze is still the shared one: the canopy has to sit in the same atmosphere as everything
// else, and §9 requires the palette and light direction to match across the LOD boundary.
// =====================================================================

varying vec3 vWorldPos;
varying vec3 vCanopyNormal;
varying float vSeed;

void main() {
  vec3 canopyN = normalize(vCanopyNormal);
  vec3 color = canopyStops(
    canopyN, normalize(uSunDirection), vWorldPos, vSeed, sunShadow(vWorldPos, canopyN)
  );
  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
