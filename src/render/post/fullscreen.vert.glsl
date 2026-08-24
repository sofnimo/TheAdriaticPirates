// Fullscreen-quad vertex shader shared by every post pass. Identical to the one
// three's ShaderPass examples use; kept here so the passes below own their whole
// program rather than half of it.

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
