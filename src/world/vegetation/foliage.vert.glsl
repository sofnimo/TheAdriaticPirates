#include ../../render/shading/chunks/hash_noise.glsl;

// =====================================================================
// FOLIAGE VERTEX — `03 — Procedural Islands.md` §8.2 (LOD) and §8.3 (wind).
//
// One InstancedMesh per species per the doc, so `instanceMatrix` carries position, yaw and
// size and this shader only has to add the two things that vary per frame: sway, and the
// distance collapse.
// =====================================================================

/** Per-instance: x = colour-map index (0/1), y = phase, z = crown height in metres. */
attribute vec3 aInstance;

uniform float uTime;
uniform vec3  uCameraPos;
uniform float uWindSpeed;
uniform vec2  uWindDir;
uniform float uSway;        // metres of travel at the crown, per species
uniform float uNearRange;   // full size inside this
uniform float uFarRange;    // collapsed past this
uniform float uLodEnabled;  // 0 disables the collapse, for the gate's negative control

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vMapIndex;
varying float vAoBias;

void main() {
  vec4 instPos = instanceMatrix * vec4(position, 1.0);
  vec4 world = modelMatrix * instPos;

  // Instance origin in world space — the base of the trunk. Everything below is measured
  // from it, so a tree on a hillside sways about its own root rather than about the origin.
  vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float crown = max(aInstance.z, 0.001);
  float up01 = clamp((world.y - base.y) / crown, 0.0, 1.0);

  // --- 03 §8.3: wind ---------------------------------------------------------------------
  // "a shared low-frequency scrolling noise texture sampled by world XZ and instance ID
  // phase-offset". Sampled analytically rather than from a texture — one fbm2 call is
  // cheaper than a fetch and this is the only place it is needed.
  //
  // Weighted by up01 cubed, not linearly: a trunk does not translate, a crown does. A linear
  // weight shears the whole shape and the tree reads as rubber.
  float gust = fbm2(base.xz * 0.006 + uWindDir * (uTime * uWindSpeed * 0.06)) - 0.5;
  float flutter = sin(uTime * 1.7 + aInstance.y * 6.2831);
  float amount = uSway * (gust * 1.4 + flutter * 0.5) * up01 * up01 * up01;
  world.xz += uWindDir * amount;

  // --- 03 §8.2: LOD ----------------------------------------------------------------------
  // Distance is measured to the instance BASE, not to the vertex, so every vertex of one
  // tree agrees about which LOD it is in. Per-vertex distance tears a canopy in half at the
  // range boundary.
  float dist = distance(uCameraPos, base);
  float lod = 1.0 - smoothstep(uNearRange, uFarRange, dist);
  lod = mix(1.0, lod, uLodEnabled);

  // Shrink toward the base rather than fading opacity: these are opaque, and 00 §3 rule 1's
  // flat bands mean a cross-fade would show as a translucent ghost rather than as a fade.
  // Below the canopy-mass hull's own height the shrink is invisible — the hull is already
  // carrying the silhouette by then, which is precisely what §8.2's far LOD asks for.
  world.xyz = mix(base, world.xyz, max(lod, 0.0));

  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vMapIndex = aInstance.x;

  // Cheap fake occlusion under the canopy. The island passes shadowFactor = 1.0 into the
  // shared ramp (no terrain self-shadowing until Step 5), so nothing else would darken the
  // underside of a tree and the whole stand would read as pasted on. This is 04 §6's
  // vertex-threshold trick, applied where the doc's own AO term would go.
  vAoBias = 1.0 - up01;

  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;

  // §8.2's forest trick, verbatim in intent: collapse the primitive so the GPU discards it
  // before the fragment stage rather than shading a sub-pixel tree.
  if (lod <= 0.0) gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
