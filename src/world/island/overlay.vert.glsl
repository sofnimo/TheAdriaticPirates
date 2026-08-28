// =====================================================================
// TIER B VERTEX — the raised long-grass overlay. `05 §5`.
//
// A TOPOLOGY-MATCHED COPY, NOT A DECAL. This shader runs on the SAME geometry object the base
// terrain draws, so the height and the normal are the same evaluation by construction rather
// than by two systems agreeing. §5's first failure mode is the overlay picking a different
// height sample or LOD from the base; sharing the buffer makes that impossible.
//
// The displacement is REAL GEOMETRIC SEPARATION along the normal, and it is the primary fix
// for coincident-surface flicker — not polygonOffset, which is only ever a small safety bias
// on top (§5's fix order). It tapers to zero on steep ground: a normal-offset skin peels at
// grazing angles, and cliffs are where that shows.
// =====================================================================

uniform float uLongGrassOffset;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);

  float taper = smoothstep(0.55, 0.86, worldNormal.y);
  world.xyz += worldNormal * (uLongGrassOffset * taper);

  vWorldPos = world.xyz;
  vWorldNormal = worldNormal;
  gl_Position = projectionMatrix * viewMatrix * world;
}
