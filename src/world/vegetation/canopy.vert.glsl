#include ../../render/shading/chunks/hash_noise.glsl;

// =====================================================================
// CANOPY-MASS VERTEX — the non-instanced half of 03 §8.2's LOD ladder.
//
// Shares `foliage.frag.glsl` with the instanced species, so the far LOD and the near one are
// banded by the same Ghibli chunk with the same colour map. A separate fragment shader here
// would let the mass and the trees standing in it drift apart in colour, which is the single
// most visible way a canopy LOD can fail.
//
// It cannot share the VERTEX shader, because `instanceMatrix` only exists when three defines
// USE_INSTANCING, and this mesh is one hull rather than N instances.
// =====================================================================

/** Metres this vertex sits above the terrain, baked by CanopyMass. */
attribute float aLift;

uniform float uTime;
uniform float uWindSpeed;
uniform vec2  uWindDir;
uniform float uSway;
uniform vec3  uCameraPos;
uniform float uNearRange;
uniform float uFarRange;
uniform float uLodEnabled;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vMapIndex;
varying float vAoBias;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);

  // --- THE HALF OF §8.2's LOD THAT IS EASY TO FORGET -------------------------------------
  //
  // The instanced trees fade out with distance; this has to fade IN over the same range, or
  // the two representations are both present at close range and the hull — 7 m of solid
  // canopy standing over ground the trees are rooted in — simply buries them. The first
  // build did exactly that: the dense-forest slope rendered as a bare green mesa with a few
  // thousand invisible trees inside it.
  //
  // Retracting rather than fading: the hull is pulled down to a metre and a half BELOW the
  // terrain it was built over, so the ground occludes it. That needs no blending, no draw
  // order, and no second pass — and unlike collapsing the primitive it cannot pop, because
  // the surface slides out of sight continuously.
  float lodFar = smoothstep(uNearRange, uFarRange, distance(uCameraPos, world.xyz));
  lodFar = mix(1.0, lodFar, uLodEnabled);
  world.y -= mix(aLift + 1.5, 0.0, lodFar);

  // The whole canopy breathes with the same gust field the individual trees use, at a
  // fraction of the amplitude. A mass this size does not sway, it ripples — but a completely
  // static forest under moving trees is worse than either.
  float gust = fbm2(world.xz * 0.006 + uWindDir * (uTime * uWindSpeed * 0.06)) - 0.5;
  world.xz += uWindDir * gust * uSway;

  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);

  // Alternate the colour map at patch scale rather than per instance, so one hillside of
  // forest is not one flat green. Same two authored maps, chosen the same way — selected,
  // never blended.
  vMapIndex = step(0.5, fbm2(world.xz * 0.0055 + 17.3));

  // No AO term on the mass: its own shading already comes from the hull's normals, and the
  // instanced trees' base darkening exists to seat them ON this surface.
  vAoBias = 0.0;

  gl_Position = projectionMatrix * viewMatrix * world;
}
