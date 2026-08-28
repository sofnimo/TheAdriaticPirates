#include ./wave_time.glsl;
// =====================================================================
// GERSTNER WAVE STACK — `02 — Water.md` §1.3, after GPU Gems 1 ch.1.
//
// Four waves only. From 200-1500 m the wave silhouette is sub-pixel; what actually reads is
// colour banding and glint placement, both fragment jobs (02 §1.1). So wave 1 carries the
// silhouette, waves 3-4 exist to perturb the normal enough to place glints, and the whole
// stack is evaluated ANALYTICALLY in the fragment shader — the far field gets correct wave
// normals feeding the ramp and the glint field even where the geometry stays dead flat.
//
// Steepness is bounded per GPU Gems as Qi = Q / (k * A * numWaves) to stop crests looping
// over themselves.
// =====================================================================

uniform vec4 uWaves[4];      // xy = unit direction, z = wavelength (m), w = amplitude (m)
uniform float uSteepness[4]; // artist Q in 0..1

// --- shelter (ShelterField.ts) -----------------------------------------------------------
uniform sampler2D uShelterMap;  // R = 0 fully sheltered .. 1 open sea
uniform vec2 uShelterOrigin;
uniform float uShelterSize;
uniform float uShelterMin;      // amplitude left in the deepest lee, 0 = dead flat
uniform float uShelterEnable;

const float GERSTNER_G = 9.8;

/** 0-1 open-water exposure — how much sea the swell crossed to get here. */
float shelterExposure(vec2 worldXZ) {
  if (uShelterEnable < 0.5) return 1.0;
  vec2 uv = (worldXZ - uShelterOrigin) / uShelterSize;
  // Off the baked tile is open sea, not shelter. Clamping instead would smear the tile's edge
  // row out over the whole horizon.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  return texture2D(uShelterMap, uv).r;
}

/**
 * Amplitude multiplier for the wave stack at a point.
 *
 * ONE SCALE ON THE WHOLE RESULT, not on each wave's `A` inside the loop, and the difference is
 * not cosmetic. Gerstner's horizontal term carries `Qi * A`, and `Qi` is itself `Q / (k·A·N)` —
 * so `A` cancels out of it. Scaling `A` per wave would flatten the vertical motion and leave
 * the horizontal sloshing at full strength, which is a sheltered cove whose surface still
 * slides about. Scaling the accumulated offset and the accumulated slope keeps the wave shape
 * intact and simply makes it smaller, which is what shelter does.
 */
float waveShelter(vec2 worldXZ) {
  return mix(clamp(uShelterMin, 0.0, 1.0), 1.0, shelterExposure(worldXZ));
}

/** Horizontal + vertical displacement at a world XZ position. */
vec3 gerstnerOffset(vec2 worldXZ) {
  vec3 offset = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 d = normalize(uWaves[i].xy);
    float wavelength = uWaves[i].z;
    float A = uWaves[i].w;
    float k = 6.28318530718 / max(wavelength, 0.001);
    float w = sqrt(GERSTNER_G * k);
    float phase = k * dot(d, worldXZ) + w * uWaveTime;
    float Qi = uSteepness[i] / max(k * A * 4.0, 1e-4);

    offset.x += Qi * A * d.x * cos(phase);
    offset.z += Qi * A * d.y * cos(phase);
    offset.y += A * sin(phase);
  }
  return offset * waveShelter(worldXZ);
}

/** Analytic surface normal for the same stack — no derivatives, no normal map. */
vec3 gerstnerNormal(vec2 worldXZ) {
  float dx = 0.0;
  float dz = 0.0;
  float dy = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 d = normalize(uWaves[i].xy);
    float wavelength = uWaves[i].z;
    float A = uWaves[i].w;
    float k = 6.28318530718 / max(wavelength, 0.001);
    float w = sqrt(GERSTNER_G * k);
    float phase = k * dot(d, worldXZ) + w * uWaveTime;
    float Qi = uSteepness[i] / max(k * A * 4.0, 1e-4);

    float wa = k * A;
    dx += d.x * wa * cos(phase);
    dz += d.y * wa * cos(phase);
    dy += Qi * wa * sin(phase);
  }
  // The slope is scaled, not the normal: flattening the accumulated gradient is what turns a
  // wave face back toward level, and it is the same scale the displacement above took.
  float s = waveShelter(worldXZ);
  return normalize(vec3(-dx * s, 1.0 - dy * s, -dz * s));
}
