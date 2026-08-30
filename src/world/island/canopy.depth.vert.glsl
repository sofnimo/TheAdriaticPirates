#include ../../render/shading/chunks/leaf.glsl;

// =====================================================================
// TIER C DEPTH — the canopy's shadow-casting pass.
//
// WHY THIS FILE HAS TO EXIST. three renders the shadow map with its own `MeshDepthMaterial`,
// not with the object's material, so it runs ITS vertex shader and not `canopy.vert.glsl`.
// Every crown's position lives in the `aCenter`/`aRadius` instance attributes, which that
// material knows nothing about — so all twelve hundred crowns would be transformed as one
// unit dome sitting at the world origin, and the island would be shadowed by a small sphere
// in the sea while the actual canopy cast nothing at all.
//
// `object.customDepthMaterial` is three's hook for exactly this case. The transform below is
// the same one as in `canopy.vert.glsl` and must stay that way; both now get the leaf half of
// it from `leaf.glsl` rather than each carrying a copy, which is the only way to be sure a
// leaf casts its shadow from where it is drawn.
//
// ONE DELIBERATE DIFFERENCE: NO DISTANCE FADE. The visible pass shrinks leaves away past
// `uLeafFadeStart` using the eye position, but in this pass `cameraPosition` is the LIGHT's
// camera, not the player's — three sets it from whatever camera is rendering. Fading on that
// would thin a crown's shadow according to how far the crown is from the sun's frustum origin,
// which is meaningless. So shadow-casting leaves are always full size. The mismatch is
// harmless in the direction it errs: a distant crown that has faded to its bare hull still
// casts a fully leafed shadow, and at that range its shadow is a few pixels of dapple.
// =====================================================================

attribute vec3 aCenter;
attribute vec3 aRadius;
attribute float aSeed;

attribute vec2 aLeafCorner;
attribute vec3 aLeafU;
attribute vec3 aLeafV;
attribute vec2 aLeafInfo;

varying vec2 vLeafUV;
varying vec2 vLeafInfo;

void main() {
  float ang = aSeed * 6.2831853;
  float s = sin(ang);
  float c = cos(ang);

  vec3 world;
  if (aLeafInfo.x > 0.0001) {
    world = leafCorner(position, aLeafU, aLeafV, aLeafCorner, aLeafInfo.x,
      aCenter, aRadius, s, c, 1.0);
  } else {
    world = aCenter + leafYaw(position, s, c) * aRadius;
  }

  vLeafUV = aLeafCorner;
  vLeafInfo = aLeafInfo;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
