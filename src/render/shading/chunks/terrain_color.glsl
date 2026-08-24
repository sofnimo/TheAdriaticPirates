#include ./hash_noise.glsl;
#include ./shore.glsl;

// =====================================================================
// TERRAIN BASE COLOUR — `03 — Procedural Islands.md` §3.1, §3.2, §7.
//
// This decides WHAT COLOUR the ground is. It never decides how the ground is lit — that is
// the shared gouache ramp's job, exactly as it is for the sea. Same split, same chunk, no
// fork: base colour first, then `applyGouacheRampTinted` on top.
//
// Three things combine, in this order:
//   1. Biome, assigned per COARSE CELL rather than per pixel (§7.3).
//   2. Slope, blending that biome toward bare limestone on steep ground (§3.1).
//   3. Strata, banding the limestone horizontally in world Y (§3.2).
// =====================================================================

uniform vec3 cBeach;        // #cbc5ad
uniform vec3 cRockLit;      // #cbc5ad
uniform vec3 cRockShadow;   // #726f60
uniform vec3 cRockDark;     // #2e312b
uniform vec3 cMacchia;      // #8eac71
uniform vec3 cPasture;      // #a8b19d
uniform vec3 cForest;       // #1f4e38
uniform vec3 cForestSparse; // #45764e
uniform vec3 cTerrace;      // #6a955f

uniform float uBiomeCellSize;   // metres; 30-80 per 03 §7.3
uniform float uBiomeEdgeWobble; // metres of domain warp on the cell boundary
uniform float uStrataSpacing;   // metres between bedding planes
uniform float uPeakHeight;
uniform vec3 cWetSand;      // #8f8874 — 02b §5
uniform float uWetSandBand; // ~20 m landward

// The baked biome field — see world/island/BiomeField.ts. R = biome id, G = cover density.
uniform sampler2D uBiomeMap;
uniform vec2 uBiomeMapOrigin;
uniform float uBiomeMapSize;

/**
 * Biome per coarse cell, NOT per pixel — 03 §7.3.
 *
 * The cell assignment itself no longer happens here. It is baked on the CPU by `BiomeField`,
 * because §8's vegetation has to stand on the biome it was placed for, and the only way two
 * systems agree on a field is for there to be one of it. This shader used to evaluate the
 * driving fields per fragment; reproducing that in JS would have meant a second copy of
 * `fbm2`/`hash22` and the hope that they matched, which is the two-owners bug the shoreline
 * already taught this project about.
 *
 * What stays here is the part that has to be sub-texel: the few-metre boundary wobble, so a
 * cell edge reads as a hand-painted irregular line rather than as the lattice it is. The
 * wobble is applied to the LOOKUP POSITION, which perturbs the boundary without needing the
 * cell geometry the bake already resolved.
 */
int biomeIdAt(vec2 worldXZ) {
  vec2 wobble = vec2(
    fbm2(worldXZ / (uBiomeCellSize * 2.7)) - 0.5,
    fbm2(worldXZ / (uBiomeCellSize * 2.7) + 31.7) - 0.5
  ) * 2.0 * uBiomeEdgeWobble;

  vec2 uv = (worldXZ + wobble - uBiomeMapOrigin) / uBiomeMapSize;
  // NearestFilter on an 8-bit enum: the +0.5 is the usual guard against a texel value
  // landing a hair under its integer after the float round-trip.
  return int(texture2D(uBiomeMap, uv).r * 255.0 + 0.5);
}

/** 03 §7.2's palette-anchor column, keyed by the baked id. */
vec3 biomeColor(vec2 worldXZ) {
  int id = biomeIdAt(worldXZ);
  if (id == 1) return cBeach;
  if (id == 2) return cRockShadow;
  if (id == 3) return cMacchia;
  if (id == 4) return cPasture;
  if (id == 5) return cForest;
  if (id == 6) return cForestSparse;
  if (id == 7) return cTerrace;
  return cPasture; // id 0 is sea; the only land fragments that reach it are the shore apron
}

/**
 * Horizontal limestone bedding — 03 §3.2.
 *
 * Driven off world Y, so the bands stay level whatever the face is doing. `step()`, not
 * smoothstep: the doc calls for a hard two-tone strata edge, and a gradient here would be the
 * same mistake the sea's depth bands were, in the opposite direction — this one really is a
 * discrete edge in the source material, because it is a material boundary rather than a
 * distance gradient.
 */
vec3 strataColor(vec3 worldPos, float slope) {
  float f = worldPos.y / max(uStrataSpacing, 0.5);
  // Irregular bed thickness: without the per-bed hash the bands are a perfect comb.
  float jitter = hash12(vec2(floor(f), 0.0)) * 0.45;
  float band = fract(f + jitter);
  float hard = step(0.42, band);
  vec3 rock = mix(cRockShadow, cRockLit, hard);
  // A darker parting every few beds, so the face has a structure rather than a stripe rhythm.
  float parting = step(0.93, fract(f * 0.31 + hash12(vec2(floor(f * 0.31), 7.0))));
  rock = mix(rock, cRockDark, parting * 0.55);

  // STRATA ONLY ON STEEP FACES. This is why 03 §3.2 specifies triplanar: bedding planes are
  // visible where the surface CUTS ACROSS them, which is a cliff. Banding world Y over gentle
  // ground instead draws contour lines — the bands widen as the slope flattens until the
  // island reads as a topographic map, which is what the first build of this did.
  float onFace = smoothstep(0.42, 0.72, slope);
  return mix(cRockLit, rock, onFace);
}

/**
 * @param worldPos  fragment world position
 * @param normal    world-space surface normal
 * @param exposure  -1..1, seaward-facing at +1 (03 §3.5)
 * @return          base colour, before any lighting
 */
vec3 terrainColor(vec3 worldPos, vec3 normal, float exposure) {
  float slope = 1.0 - clamp(dot(normalize(normal), vec3(0.0, 1.0, 0.0)), 0.0, 1.0);

  vec3 cover = biomeColor(worldPos.xz);
  vec3 rock = strataColor(worldPos, slope);

  // 03 §3.1's workhorse: a ~20-33 deg transition band from cover to bare limestone. Pushed
  // earlier on the exposed flank, which is where the doc puts the denuded cliffs.
  float bandStart = mix(0.42, 0.26, clamp(exposure * 0.5 + 0.5, 0.0, 1.0));
  float rockMix = smoothstep(bandStart, bandStart + 0.2, slope);

  // Wave-washed limestone at the waterline: bare regardless of slope, but only for the first
  // few metres. A wide band here reads as a bright collar drawn round the whole island.
  rockMix = max(rockMix, 1.0 - smoothstep(0.8, 4.0, worldPos.y));

  vec3 base = mix(cover, rock, rockMix);

  // Wet sand — 02b §5. Applied last, so it darkens whatever the ground turned out to be:
  // the damp band crosses sand and wave-washed rock alike, and masking it to the beach biome
  // would leave a dry-looking rock shelf inside the same swash the sand beside it is wet from.
  return applyWetSand(base, worldPos.xz, cWetSand, uWetSandBand);
}
