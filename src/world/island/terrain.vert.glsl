// Tier A0 vertex stage. The mesh is already displaced and its normals are already central
// differences over its own vertices (see IslandMesh), so there is nothing to do here but hand
// the world-space position and normal to the fragment stage — every mask in land_cover.glsl is
// world anchored and needs the position, not a UV.

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vExposure;

attribute float aExposure;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vExposure = aExposure;
  gl_Position = projectionMatrix * viewMatrix * world;
}
