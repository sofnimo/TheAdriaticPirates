#include ../../render/shading/chunks/leaf.glsl;

// =====================================================================
// TIER C DEPTH FRAGMENT.
//
// This used to be empty, and correctly so: the shadow map is a real depth attachment under
// `PCFShadowMap`, the rasteriser supplies the value, and the only job was to not discard.
//
// It has work now, and it is the same work `canopy.frag.glsl` does — cut the blade out of its
// quad. Without it every leaf casts the shadow of the RECTANGLE it was carried on, so a crown
// that draws as a spray of blades would lay down a solid slab of shade beneath itself, and the
// dappled light under a tree would be a hard-edged block. Both passes call `leafInside` from
// the same chunk with the same inputs, which is what keeps the shadow and the leaf the same
// shape as the outline is tuned.
// =====================================================================

varying vec2 vLeafUV;
varying vec2 vLeafInfo;

void main() {
  if (vLeafInfo.x > 0.0001 && !leafInside(vLeafUV, vLeafInfo.y)) discard;
  gl_FragColor = vec4(1.0);
}
