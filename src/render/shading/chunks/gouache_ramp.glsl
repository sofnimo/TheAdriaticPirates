// =====================================================================
// THE SHARED GOUACHE RAMP — `04 — Light and Shadow.md` §2.2.
//
// THIS IS THE ONLY COPY. Terrain, cliffs, foliage, buildings, clouds, water and the
// aircraft all run this exact code with different uniform values (04 §2.3). Per the doc
// index: "Do not fork it per material." If you are about to paste a variant of this
// function somewhere else, add a uniform instead.
//
// What it does, and why each line is the way it is:
//   - quantised band ramp, 2-4 steps, instead of Lambert falloff  (00 §3 rule 1)
//   - shadow band is a HUE SHIFT toward a tint, never base * 0.5  (00 §3 rule 2)
//   - cast shadow is a binary step, no penumbra gradient          (00 §3 rule 3, 04 §3.3)
//   - rim is a hard-edged painted accent, not a Fresnel glow      (00 §3 rule 4)
// =====================================================================

uniform float uRampSteps;      // 2.0-4.0, per-surface
uniform vec3  uShadowTint;     // hue-shift target. NOT black/grey.
uniform float uShadowTintMix;  // 0-1, how far the shadow band leans into the tint
uniform vec3  uRimColor;
uniform float uRimPower;       // 2.0-6.0
uniform float uRimStrength;    // 0-0.6, kept low

// Band tints carrying the sun/fill colour of the current time-of-day preset.
// Applied to the whole band, so the bands stay FLAT. See uHemiGradient below.
uniform vec3  uLitTint;
uniform vec3  uFillTint;

// Optional continuous hemisphere term, 0 by default.
// 04 §1 recommends a THREE.HemisphereLight for fake GI. A smooth N.y gradient on top of
// stepped bands would visibly un-flatten them, so the fill ships as a band tint above and
// this knob stays at 0 — available if a scene ever wants a little real gradient back.
uniform float uHemiGradient;
uniform vec3  uHemiSky;
uniform vec3  uHemiGround;

/**
 * Half-Lambert, then quantise.
 * The 0.5/+0.5 remap avoids a fully black terminator; `aoBias` lets art push a region
 * toward the shadow band without a screen-space AO pass (04 §6, the Guilty Gear Xrd
 * vertex-colour threshold trick).
 *
 * Note vs the doc snippet: the divisor is clamped and the floor is capped at steps-1.
 * `floor(hl * steps) / (steps - 1)` overshoots past 1.0 exactly at hl == 1.0, which
 * blows out the lit band on any fragment pointing straight at the sun.
 */
float gouacheStep(float ndotl, float steps, float aoBias) {
  float hl = clamp(ndotl * 0.5 + 0.5 - aoBias * 0.3, 0.0, 1.0);
  float band = min(floor(hl * steps), steps - 1.0);
  return band / max(steps - 1.0, 1.0);
}

/**
 * Core ramp, with the shadow tint passed explicitly.
 *
 * Surfaces whose base colour varies per fragment need their shadow tint to vary with it:
 * the ocean's depth ramp runs from turquoise shallows to abyssal blue, and forcing one
 * uniform tint across all of it would collapse the shelf bands into a single navy wherever
 * a wave face fell into shadow. Water passes a depth-interpolated tint here; every other
 * surface uses the uniform-driven wrapper below. Same code either way — no fork.
 *
 * @param baseColor    authored lit tone (the palette hex)
 * @param shadowTint   hue-shift target for the shadow band
 * @param ndotl        dot(worldNormal, sunDir)
 * @param shadowFactor 0 = fully shadowed, 1 = lit, straight from the shadow map
 * @param worldNormal  normalised, world space
 * @param viewDir      normalised, fragment -> camera
 * @param aoBias       0 = none, 1 = strong bias toward the shadow band
 */
vec3 applyGouacheRampTinted(
  vec3 baseColor,
  vec3 shadowTint,
  float ndotl,
  float shadowFactor,
  vec3 worldNormal,
  vec3 viewDir,
  float aoBias
) {
  float band = gouacheStep(ndotl, uRampSteps, aoBias);

  // Cast shadow: a binary cut, never a lerp (04 §3.3). A shadowed fragment does not get
  // darker, it SNAPS to the shadow band — same hue-shifted tone the terminator uses.
  float hardShadow = step(0.5, shadowFactor);
  band *= hardShadow;

  // Authored tint, never a flat multiply: lerp toward a hand-picked hex (00 §3 rule 2).
  // How far that moves the hue is a property of the sampled palette, not a target to
  // chase — cloud swings ~93 deg toward the sky's cyan, sea only ~9 deg into near-black
  // indigo. Both are correct; the mechanism is what's binding.
  vec3 shadowColor = mix(baseColor * 0.82, shadowTint, uShadowTintMix) * uFillTint;
  vec3 litColor = baseColor * uLitTint;
  vec3 shaded = mix(shadowColor, litColor, band);

  // Optional continuous hemisphere fill, off by default (see uHemiGradient).
  if (uHemiGradient > 0.0) {
    vec3 hemi = mix(uHemiGround, uHemiSky, worldNormal.y * 0.5 + 0.5);
    shaded = mix(shaded, shaded * hemi * 2.0, uHemiGradient);
  }

  // Rim / backlight: a thin painted edge, hard-shouldered by the smoothstep window.
  float rim = pow(1.0 - clamp(dot(worldNormal, viewDir), 0.0, 1.0), uRimPower);
  rim = smoothstep(0.55, 0.85, rim) * uRimStrength;
  shaded += uRimColor * rim;

  return shaded;
}

/** Uniform-driven wrapper — what every surface except water calls. */
vec3 applyGouacheRamp(
  vec3 baseColor,
  float ndotl,
  float shadowFactor,
  vec3 worldNormal,
  vec3 viewDir,
  float aoBias
) {
  return applyGouacheRampTinted(baseColor, uShadowTint, ndotl, shadowFactor, worldNormal, viewDir, aoBias);
}
