#include ../../render/shading/chunks/ghibli_band.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;

// =====================================================================
// FOLIAGE FRAGMENT — craftzdog/ghibli-style-shader's band, in this world's palette.
//
// The band itself is the upstream shader unchanged: a hard `if` chain over four authored
// colours. Two things wrap it, and both are the world's rules rather than the shader's:
//
//   1. TWO COLOUR MAPS, selected per instance. `Scene.jsx` upstream draws two tree groups
//      with two different four-colour arrays; this is that, per instance instead of per
//      group, so a stand is several greens without any of them being invented.
//   2. AERIAL PERSPECTIVE. 00 §3 rule 5 and the reference frames: distant land collapses in
//      saturation. Foliage that skipped the haze would stay vivid green while the hillside
//      it stands on greys out, and the trees would detach from the island at range.
// =====================================================================

uniform vec3 uColorMapA[4];
uniform vec3 uColorMapB[4];
uniform vec3 uThresholds;
uniform float uAoStrength;

// Declared here rather than pulled in with the whole gouache ramp: this material does not
// run that ramp, and including it just to reach two uniforms would put the fork this chunk
// exists to avoid one #include away. Same `{ value }` objects either way — ShadingUniforms
// hands out one instance and every material points at it (see globalUniforms).
uniform vec3 uLitTint;
uniform vec3 uFillTint;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vMapIndex;
varying float vAoBias;

void main() {
  vec3 normal = normalize(vWorldNormal);
  vec3 sunDir = normalize(uSunDirection);

  // The upstream shader's one line. `lightPosition - worldPosition` there because its light
  // is a point 15 m from the model; here the sun is directional and 04 §1 says there is
  // exactly one of it, so the direction comes straight from the shared uniform.
  float brightness = dot(normal, sunDir);

  // Push the underside of the canopy one band down — see vAoBias in the vertex shader.
  brightness -= vAoBias * uAoStrength;

  vec3 mapA[4];
  vec3 mapB[4];
  mapA[0] = uColorMapA[0]; mapA[1] = uColorMapA[1]; mapA[2] = uColorMapA[2]; mapA[3] = uColorMapA[3];
  mapB[0] = uColorMapB[0]; mapB[1] = uColorMapB[1]; mapB[2] = uColorMapB[2]; mapB[3] = uColorMapB[3];

  // Selected, not blended: a mix between the two maps would land between two authored hexes
  // and put a colour on screen that is in no palette entry.
  vec3 color = vMapIndex < 0.5
    ? ghibliBand(brightness, mapA, uThresholds)
    : ghibliBand(brightness, mapB, uThresholds);

  // Time-of-day band tints, the same ones the gouache ramp applies, so foliage warms and
  // cools with everything else instead of staying at noon while the island goes gold.
  color *= mix(uFillTint, uLitTint, step(uThresholds.y, brightness));

  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
