// =====================================================================
// SKY GRADIENT — the single definition of what the sky looks like.
// `01 — Sky and Clouds.md` §1.2.
//
// This file is included by BOTH the sky dome material and the aerial-perspective
// chunk. That is deliberate and load-bearing: 04 §5.2 flags "matching the haze colour
// to the actual sky shader rather than a hand-picked constant that can drift out of
// sync" as a known pitfall. Here the haze does not approximate the sky, it *calls* it.
//
// Not three's `Sky` addon: that is Preetham/Nishita atmospheric scattering, which wants
// to converge on a realistic pale blue and fights a flat saturated cyan (01 §1.1).
// =====================================================================

uniform vec3 uSkyZenith;   // #1ca6c7 — a real cyan, not a pale blue
uniform vec3 uSkyMid;      // #4ba8c6
uniform vec3 uSkyHorizon;  // #d0dbdf — pale haze band
uniform vec3 uSunDirection; // unit vector, surface -> sun
uniform vec3 uSunColor;
uniform float uSunSize;    // cos-angle threshold, ~0.99985 for a 1 deg disc

/**
 * Sky colour for a view direction, WITHOUT the sun disc.
 * This is the function the haze fades toward, so it must stay disc-free — otherwise
 * distant terrain would inherit a smear of sun disc wherever it crossed the sun azimuth.
 */
vec3 skyGradient(vec3 dir) {
  vec3 sunDir = normalize(uSunDirection);
  float sunDot = dot(dir, sunDir);

  // Horizon band widens toward the sun azimuth, so haze "blooms" toward the sun
  // as it does in the reference frames (01 §1.2).
  float h = dir.y + 0.05 * max(sunDot, 0.0);

  // Two chained smoothsteps, kept fairly wide so it still reads as a gradient.
  // The sky is the one surface allowed a soft ramp: it has no silhouette to protect.
  vec3 col = mix(uSkyHorizon, uSkyMid, smoothstep(-0.02, 0.28, h));
  col = mix(col, uSkyZenith, smoothstep(0.20, 0.75, h));
  return col;
}

/** Sky including the sun disc and its small painted glow. Dome only. */
vec3 skyWithSun(vec3 dir) {
  vec3 col = skyGradient(dir);
  float sunDot = dot(dir, normalize(uSunDirection));

  // Hard-edged core, small painted glow, no physical scattering.
  float disc = smoothstep(uSunSize, uSunSize + 0.0006, sunDot);
  float glow = pow(max(sunDot, 0.0), 220.0) * 0.35;

  col += disc * vec3(1.0, 0.98, 0.9);
  col += glow * uSunColor;
  return col;
}
