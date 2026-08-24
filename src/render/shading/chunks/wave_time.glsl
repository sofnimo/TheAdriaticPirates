// Single declaration of the wave clock. Both gerstner.glsl and glints.glsl need it, and
// GLSL will not tolerate the same uniform being declared twice in one program — so it
// lives here and both include it. The plugin dedupes the include.
uniform float uWaveTime;
