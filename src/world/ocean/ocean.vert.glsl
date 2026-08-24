#include ../../render/shading/chunks/gerstner.glsl;

uniform float uDisplaceFadeStart;
uniform float uDisplaceFadeEnd;

varying vec3 vWorldPos;

void main() {
  vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;

  // Vertex displacement only in the near field. Beyond the fade the surface stays flat and
  // the fragment shader's analytic normal carries the waves (02 §1.1, §6.1) — a nearly free
  // LOD win, since it is a shader branch rather than a geometry swap. Amplitude reaches zero
  // BEFORE the next ring's resolution change, so the LOD boundary can never crack.
  float camDist = length(worldPos.xz - cameraPosition.xz);
  float displaceFade = 1.0 - smoothstep(uDisplaceFadeStart, uDisplaceFadeEnd, camDist);
  if (displaceFade > 0.0) {
    worldPos += gerstnerOffset(worldPos.xz) * displaceFade;
  }

  vWorldPos = worldPos;
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
