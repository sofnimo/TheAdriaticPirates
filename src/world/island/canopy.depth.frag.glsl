// Companion to canopy.depth.vert.glsl. The shadow map is a depth attachment, so nothing here
// contributes to it — the fragment stage exists only so the rasteriser runs.
void main() {
  gl_FragColor = vec4(1.0);
}
