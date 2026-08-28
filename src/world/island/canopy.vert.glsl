// =====================================================================
// TIER C VERTEX — oak canopy hulls. `05 §7`, `§8.1`.
//
// NOT CARDS. §7 corrects the obvious approach directly: camera-facing quads rotate with the
// camera, which destroys any fixed sun-side dab placement, and crossed planes collapse to
// near-zero projected area from overhead — the dominant view in this game. So the canopy is
// irregular low-poly hulls with real volume, placed per world cell.
//
// The normal is SYNTHETIC and WORLD-FIXED (§8.1). The dome's own facet normals are discarded
// and replaced with a smooth ellipsoidal field blended toward straight up by `uNormalSpread`:
// low reads as a broad top-lit mass, high as a rounder sun-side split. Because it is built
// from the hull's own object-space position and never from the view, `dot(canopyN, sunDir)`
// puts the lit side on the same world-space flank no matter where the aircraft is.
// =====================================================================

uniform float uNormalSpread;

attribute vec3 aCenter;
attribute vec3 aRadius;
attribute float aSeed;

varying vec3 vWorldPos;
varying vec3 vCanopyNormal;
varying float vSeed;

void main() {
  // `position` is a unit dome, so it doubles as the ellipsoid coordinate q the normal wants —
  // no need to reconstruct it from the deformed world position.
  vec3 q = normalize(position + vec3(0.0, 0.001, 0.0));
  vec3 world = aCenter + position * aRadius;

  vCanopyNormal = normalize(mix(vec3(0.0, 1.0, 0.0), q, clamp(uNormalSpread, 0.0, 1.0)));
  vWorldPos = world;
  vSeed = aSeed;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
