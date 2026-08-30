#include ../../render/shading/chunks/leaf.glsl;

// =====================================================================
// TIER C VERTEX — oak crowns: a dome clad in 2D leaves. `05 §7`, `§8.1`.
//
// NOT CARDS, STILL. §7's objection is to CAMERA-FACING quads: they turn to meet the aircraft,
// so the lit flank follows the camera and no sun-side placement survives. Every leaf here is
// pinned in the world instead — its plane is chosen once on the CPU in the crown's frame, and
// after the per-crown yaw it is a fixed direction. Fly around a tree and the same leaves stay
// lit; move the sun and different ones light up.
//
// TWO NORMALS LEAVE THIS SHADER, and the fragment picks per vertex which it got:
//
//   the DOME's, synthetic and smooth (§8.1) — the ellipsoidal field blended toward straight up
//   by `uNormalSpread`, unchanged, still carrying the crown as one painted mass.
//
//   the LEAF's, its own plane normal — a blade is a flat thing with a direction, and lighting
//   it by the crown's smooth field would be lighting it as if it were part of the dome. This
//   is the normal that makes the foliage answer the sun leaf by leaf.
//
// `uLeafNormalMix` slides between them, so the tier can be pulled back toward §8.1's single
// coherent field without touching the geometry.
// =====================================================================

uniform float uNormalSpread;
uniform float uLeafNormalMix;

attribute vec3 aCenter;
attribute vec3 aRadius;
attribute float aSeed;

attribute vec2 aLeafCorner;
attribute vec3 aLeafU;
attribute vec3 aLeafV;
attribute vec2 aLeafInfo;   // x = size multiplier, and 0 marks a dome vertex. y = per-leaf rand

varying vec3 vWorldPos;
varying vec3 vCanopyNormal;
varying float vSeed;
varying vec2 vLeafUV;
varying vec2 vLeafInfo;

void main() {
  // One yaw per crown. Without it the leaf arrangement is baked into the shared geometry and
  // every oak on the island is the same oak, which reads instantly as a repeated asset.
  float ang = aSeed * 6.2831853;
  float s = sin(ang);
  float c = cos(ang);

  // `position` is a unit dome, so it doubles as the ellipsoid coordinate the synthetic normal
  // wants — no need to reconstruct it from the deformed world position.
  vec3 q = normalize(position + vec3(0.0, 0.001, 0.0));
  vec3 domeN = normalize(mix(vec3(0.0, 1.0, 0.0), leafYaw(q, s, c), clamp(uNormalSpread, 0.0, 1.0)));

  float isLeaf = step(0.0001, aLeafInfo.x);
  vec3 world;
  vec3 shadeN = domeN;

  if (isLeaf > 0.5) {
    // Leaves shrink to nothing over the fade band rather than switching off, so a crown loses
    // its blades gradually and the hull is already carrying the shape by the time they go.
    float grow = leafGrow(aCenter, cameraPosition);
    world = leafCorner(position, aLeafU, aLeafV, aLeafCorner, aLeafInfo.x,
      aCenter, aRadius, s, c, grow);
    // The blade's own plane normal. It is NOT flipped toward the sun here — `uSunDirection` is
    // declared in sky_gradient.glsl, which only the fragment stage pulls in — so the fragment
    // does the flip. See the note there for why a leaf needs one at all.
    vec3 leafN = normalize(cross(leafYaw(aLeafU, s, c), leafYaw(aLeafV, s, c)));
    shadeN = normalize(mix(domeN, leafN, clamp(uLeafNormalMix, 0.0, 1.0)));
  } else {
    world = aCenter + leafYaw(position, s, c) * aRadius;
  }

  vCanopyNormal = shadeN;
  vWorldPos = world;
  vSeed = aSeed;
  vLeafUV = aLeafCorner;
  vLeafInfo = aLeafInfo;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
