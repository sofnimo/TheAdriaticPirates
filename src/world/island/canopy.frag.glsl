#include ../../render/shading/chunks/leaf.glsl;
#include ../../render/shading/chunks/canopy_shade.glsl;
#include ../../render/shading/chunks/csm_shadow.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;

// =====================================================================
// TIER C FRAGMENT — the dome and its leaves, through the same three stops.
//
// This is the one land surface that does NOT go through the gouache ramp, and the reason is in
// the doc rather than in convenience: §8.2 specifies three flat stops for vegetation against
// the ramp's two-to-four generic bands, and §2.2 measures the ladder as a hue rotation with
// falling saturation rather than the ramp's tint-toward-a-shadow-hex. Running the canopy
// through the generic ramp would flatten a measured three-stop ladder into a generic one.
//
// THE LEAVES USE THE SAME LADDER, deliberately. It would have been easy to give foliage its
// own greens, and it would have broken the tier in two: a leaf is part of the same painted
// mass as the crown it sits on, and the whole argument of §8.2 is that the mass has three
// tones. What differs between a leaf and the dome under it is the NORMAL each is lit by, not
// the palette it is lit into. So a leaf turned to the sun lands on the light stop while its
// neighbour lands on the mid, out of the same three colours the crown has always used.
//
// Haze is still the shared one: the canopy has to sit in the same atmosphere as everything
// else, and §9 requires the palette and light direction to match across the LOD boundary.
// =====================================================================

varying vec3 vWorldPos;
varying vec3 vCanopyNormal;
varying float vSeed;
varying vec2 vLeafUV;
varying vec2 vLeafInfo;

void main() {
  bool isLeaf = vLeafInfo.x > 0.0001;

  // CUT THE BLADE OUT OF ITS QUAD, before anything else is computed for it. The same test runs
  // in the depth pass, from the same chunk, so the shadow a leaf casts is the shape of the leaf
  // and not the shape of the quad it was carried on.
  if (isLeaf && !leafInside(vLeafUV, vLeafInfo.y)) discard;

  vec3 canopyN = normalize(vCanopyNormal);
  vec3 sunDir = normalize(uSunDirection);

  // A LEAF HAS NO INSIDE. It is a flat blade a fraction of a millimetre thick, lit on whichever
  // face the sun is on, and which way its normal happens to point is an accident of how the
  // quad was wound on the CPU. Left unflipped, half of every crown's blades would be dark by
  // construction — a fixed random half, unrelated to where the sun actually is, which is the
  // opposite of foliage answering the light. The dome is not flipped: it is a closed body with
  // a real outside, and its dark flank is meant to be dark.
  if (isLeaf && dot(canopyN, sunDir) < 0.0) canopyN = -canopyN;

  vec3 color = canopyStops(
    canopyN, sunDir, vWorldPos, vSeed, sunShadow(vWorldPos, canopyN)
  );
  color = applyAerialPerspective(color, vWorldPos, cameraPosition);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
