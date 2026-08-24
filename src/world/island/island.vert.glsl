attribute float aExposure;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vExposure;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vExposure = aExposure;
  gl_Position = projectionMatrix * viewMatrix * world;
}
