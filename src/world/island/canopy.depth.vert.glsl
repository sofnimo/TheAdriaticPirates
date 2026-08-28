// =====================================================================
// TIER C DEPTH — the canopy's shadow-casting pass.
//
// WHY THIS FILE HAS TO EXIST. three renders the shadow map with its own `MeshDepthMaterial`,
// not with the object's material, so it runs ITS vertex shader and not `canopy.vert.glsl`.
// Every hull's position lives in the `aCenter`/`aRadius` instance attributes, which that
// material knows nothing about — so all twelve hundred crowns would be transformed as one
// unit dome sitting at the world origin, and the island would be shadowed by a small sphere
// in the sea while the actual canopy cast nothing at all.
//
// `object.customDepthMaterial` is three's hook for exactly this case. The transform below is
// the same line as in `canopy.vert.glsl` and must stay that way; if the crowns ever move, they
// move here too.
//
// No fragment work is needed: the shadow map is a real depth attachment under `PCFShadowMap`,
// so the rasteriser supplies the value and the fragment stage only has to not discard.
// =====================================================================

attribute vec3 aCenter;
attribute vec3 aRadius;

void main() {
  gl_Position = projectionMatrix * viewMatrix * vec4(aCenter + position * aRadius, 1.0);
}
