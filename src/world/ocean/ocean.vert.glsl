#include ../../render/shading/chunks/gerstner.glsl;

uniform float uDisplaceFadeStart;
uniform float uDisplaceFadeEnd;

varying vec3 vWorldPos;
/**
 * The surface BEFORE the swell displaces it.
 *
 * 04 §3.3, on the signature shot: an aircraft shadow sampled against displaced water
 * geometry swims and ripples with the waves, when the contract wants a rigid silhouette. So
 * the shadow lookup runs on the flat base plane and the wave motion never reaches it — the
 * doc's "decal-space version of option 1".
 */
varying vec3 vBasePos;

/**
 * SEAM STITCHING — the two coarse neighbours of a vertex sitting on a ring boundary.
 *
 * xy is the offset to the neighbour on one side, zw to the other, both in world XZ; zero on
 * every vertex that is not on a seam, which is nearly all of them. See RingMesh.buildAnnulus.
 */
attribute vec4 aStitch;

void main() {
  vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vBasePos = worldPos;

  // WAVES CROSS THE RING BOUNDARIES NOW, and this is what lets them.
  //
  // The rings step down in resolution outward, so along a shared edge the fine ring carries
  // extra vertices between each pair of the coarse ring's. Displace those by their own
  // position and they lift off the straight chord the coarse ring draws between the same two
  // points — a T-junction, which opens as a hairline of sky running around the camera. That
  // is why displacement used to have to die before the first boundary, capping real geometric
  // waves at 45 m and leaving the rest of the sea a flat plane.
  //
  // The fix is to make the fine edge agree with the coarse chord by construction. A seam
  // vertex takes the INTERPOLATED displacement of its two coarse neighbours instead of its
  // own, so it lands exactly on the line between them — the same line the coarse ring is
  // drawing. Since `gerstnerOffset` is a pure function of world XZ, both rings evaluate the
  // identical value at those two shared points, and the seam closes exactly rather than
  // approximately. It costs two extra wave evaluations on a handful of edge vertices.
  //
  // What it buys: displacement can now run at full strength through the 150 m and 600 m
  // boundaries and only has to fade before the LAST one it reaches.
  float camDist = length(worldPos.xz - cameraPosition.xz);
  float displaceFade = 1.0 - smoothstep(uDisplaceFadeStart, uDisplaceFadeEnd, camDist);
  if (displaceFade > 0.0) {
    vec2 toA = aStitch.xy;
    vec2 toB = aStitch.zw;
    float span = length(toB - toA);
    vec3 offset;
    if (span > 1e-4) {
      // Where this vertex falls between the two coarse ones, 0 at A and 1 at B.
      float t = clamp(length(toA) / span, 0.0, 1.0);
      offset = mix(
        gerstnerOffset(worldPos.xz + toA),
        gerstnerOffset(worldPos.xz + toB),
        t
      );
    } else {
      offset = gerstnerOffset(worldPos.xz);
    }
    worldPos += offset * displaceFade;
  }

  vWorldPos = worldPos;
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
