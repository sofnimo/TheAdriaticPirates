#include ./hash_noise.glsl;
#include ./shore.glsl;

// =====================================================================
// LAND COVER — the shared sampling half of `05 — Distant Terrain Layering.md` §3.
//
// Every land material includes this file: the A0 base, the tier-B long-grass overlay and the
// tier-C canopy hulls. It answers four questions and nothing else — what the cover masks say
// here, what kind of coast this is, how far inland we are, and whether this fragment is rock.
// What COLOUR any of that is belongs to land_color.glsl; how it is LIT belongs to the shared
// gouache ramp. Keeping the three apart is what stops the tiers drifting: §5's failure table
// blames both "overlay seams" and "swimming patch boundaries" on layers evaluating different
// data, and there is only one evaluation here.
//
// All coordinates are WORLD anchored (§3.1, §8.3). Nothing in this file may be sampled in
// screen space; a mask that moves with the camera shimmers under flight.
// =====================================================================

uniform sampler2D uCoverMap;       // R dry grass, G long grass, B forest, A suitability
uniform vec2 uCoverOrigin;
uniform float uCoverSize;

uniform sampler2D uCharacterMap;   // R sand reach, G cliffiness, B back-cliff, A beach width
uniform vec2 uCharacterOrigin;
uniform float uCharacterSize;
uniform float uBeachWidthMax;

uniform float uDryBoost;
uniform float uDrySoftness;

uniform float uSandWidth;
uniform float uShoreSandWidth;
uniform float uSandSeaward;
uniform float uSandSoftness;
uniform float uSandEdgeWobble;
uniform float uSandEdgeScale;

uniform float uCliffSlopeStart;
uniform float uCliffSoftness;
uniform float uCoastRockNear;
uniform float uCoastRockFar;

uniform float uLongGrassThreshold;
uniform float uLongGrassBreakupScale;
uniform float uLongGrassSandMargin;

uniform float uForestThreshold;
uniform float uForestSandMargin;

vec4 sampleCover(vec2 worldXZ) {
  return texture2D(uCoverMap, (worldXZ - uCoverOrigin) / uCoverSize);
}

vec4 sampleCharacter(vec2 worldXZ) {
  return texture2D(uCharacterMap, (worldXZ - uCharacterOrigin) / uCharacterSize);
}

/** Positive on land, negative at sea. The same signed field the foam reads. */
float inlandMetres(vec2 worldXZ) {
  return -sampleShore(worldXZ).distance;
}

/**
 * Metres of pale shore at this point.
 *
 * Two terms, and they mean different things. `uShoreSandWidth` is the strip the swell works
 * over daily: on limestone it is bare and bright whether or not any sediment was deposited,
 * and without it most of the coast is grass running straight into the sea. The character
 * texture's alpha is the beach the GENERATOR actually deposited, and the ground under it was
 * shaped to match — so the painted sand follows the shaped sand rather than being a ribbon of
 * fixed width offset from the coastline.
 */
float beachMetres(vec4 character) {
  return uShoreSandWidth + character.a * uBeachWidthMax + uSandWidth;
}

/** 0-1 sand coverage. Runs seaward as well as landward: a beach does not stop at the water. */
float sandMask(vec2 worldXZ, vec4 character, float inland) {
  float width = beachMetres(character);
  // A wander on the landward edge, so the sand line is not a contour offset (00 rule 7).
  float wobble = (fbm2(worldXZ / max(uSandEdgeScale, 1.0)) - 0.5) * 2.0 * uSandEdgeWobble;
  float outer = width + wobble;
  // Narrow pocket beaches get a proportionally narrower blend, or they dissolve into grass.
  float soft = min(uSandSoftness, outer * 0.6);
  float landward = 1.0 - smoothstep(outer - soft, outer + soft, inland);
  float seaward = smoothstep(-uSandSeaward, -uSandSeaward * 0.25, inland);
  // Cliff coasts have no beach however much sediment drifted past them.
  return clamp(landward * seaward * step(-uSandSeaward, inland), 0.0, 1.0) *
         smoothstep(0.02, 0.25, character.r);
}

/** §3.1's slope-threshold blend, the cliff workhorse. */
float cliffMask(vec3 normal) {
  float slope = 1.0 - clamp(normal.y, 0.0, 1.0);
  return smoothstep(uCliffSlopeStart, uCliffSlopeStart + uCliffSoftness, slope);
}

/**
 * Rock claimed by the COAST rather than by the slope.
 *
 * A cliffed coast is rock at the waterline even where the mesh resolution has smoothed the
 * face below the slope threshold. Bounded in metres inland, because the cliffiness channel is
 * a per-station number and is constant the whole way across a flank — unbounded, it stops
 * being a cliff and becomes a limestone sheet over half the island.
 */
float coastRockMask(vec4 character, float inland) {
  float claim = smoothstep(0.15, 0.55, character.g);
  float band = 1.0 - smoothstep(uCoastRockNear, uCoastRockFar, max(inland, 0.0));
  return claim * band;
}

float rockMask(vec2 worldXZ, vec3 normal, vec4 character, float inland) {
  return max(cliffMask(normal), coastRockMask(character, inland));
}

/** Tier B occupancy: the baked medium-scale mask, raggeded by a separately seeded breakup. */
float longGrassWeight(vec2 worldXZ, vec4 cover, float inland) {
  float breakup = fbm2(worldXZ / max(uLongGrassBreakupScale, 1.0) + 37.1);
  float margin = smoothstep(uLongGrassSandMargin, uLongGrassSandMargin + 12.0, inland);
  return cover.g * mix(0.75, 1.25, breakup) * margin;
}

/** Tier C weight. §7.1: continuous, so density and the LOD handoff stay stable. */
float forestWeight(vec2 worldXZ, vec4 cover, float inland) {
  float margin = smoothstep(uForestSandMargin, uForestSandMargin + 20.0, inland);
  return cover.b * margin;
}
