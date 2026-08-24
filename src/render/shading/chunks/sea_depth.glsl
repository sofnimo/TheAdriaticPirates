// =====================================================================
// THE SHARED DEPTH SIGNAL — the single source of truth for "how deep is the water here".
//
// The doc index is explicit: "The depth signal used by 02_WATER.md's colour ramp and 02b's
// foam must be the same buffer. One source of truth." 02b restates it — its shore atlas is
// "the nearshore companion" to this bathymetry, both baked from the same island heightmap.
//
// So NOTHING samples a depth texture directly. Both the ocean's shelf-colour ramp and (from
// Step 4) the shoreline foam call sampleSeaDepth01() and get the same number. When the shore
// atlas arrives, its higher-resolution nearshore band is blended in HERE, once, and both
// consumers inherit it without either shader changing.
//
// Encoding, per 02 §2.1: 0 = shoreline, 1 = abyssal.
// =====================================================================

uniform sampler2D uBathymetry;
uniform vec2 uBathyOrigin;  // world-space XZ of the texture's (0,0) corner
uniform float uBathyScale;  // world metres covered by the full texture

/** World XZ -> bathymetry UV. */
vec2 bathyUV(vec2 worldXZ) {
  return (worldXZ - uBathyOrigin) / uBathyScale;
}

/**
 * Canonical water depth at a world position, 0 (shoreline) .. 1 (abyssal).
 *
 * STEP 4 HOOK: the shore atlas (02b §1) covers the 0-60 m strip at higher resolution and
 * carries its depth in channel G. When it exists, sample it here and blend over the macro
 * bathymetry across the atlas edge — the blend belongs in this function and nowhere else,
 * so the shelf band and the foam band can never disagree about where "shallow" starts.
 */
float sampleSeaDepth01(vec2 worldXZ) {
  vec2 uv = bathyUV(worldXZ);
  // Outside the baked region the world is open sea: clamp to abyssal rather than
  // wrapping, which would tile a coastline across the horizon.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  return texture2D(uBathymetry, uv).r;
}
