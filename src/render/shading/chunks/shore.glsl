#include ./wave_time.glsl;
#include ./hash_noise.glsl;

// =====================================================================
// SHORELINE FOAM — `02b — Coastal Waves.md` §2.
//
// Two additive layers on one baked atlas (§2.1):
//   1. a static ring clamped to the first metre or so of water, always on, never animated;
//   2. an animated run-up band driven by an asymmetric sawtooth, whose reach scales with the
//      coastline's exposure channel.
//
// Both go through quantizeFoam() before they are used. 02b §2.2 is unusually direct about
// this — every source it surveyed defaults to a bare smoothstep, and the doc says override
// that. One smoothstep for antialiasing, then floor() to flat bands. The §9 checklist repeats
// it as "never ship a raw smoothstep foam edge", so it is the one thing here with its own
// negative control (`?foam=smooth`).
// =====================================================================

uniform sampler2D uShoreAtlas;
uniform vec2 uShoreOrigin;      // world XZ of the atlas's min corner
uniform float uShoreWorldSize;  // metres covered by the atlas
uniform float uMaxShoreDist;    // 60 m — the range the R channel spans
uniform float uRingWidth;       // 1.0-1.5 m static ring (02b §8.5)
uniform float uRunupReach;      // 8-15 m landward, before exposure scaling
uniform float uRunupSpeed;      // 0.55-0.7
uniform float uRunupFreq;       // 0.10-0.14 per metre, wet-sand cycle only
uniform float uRunupCycles;     // swash fronts visible across the run-up band at once
uniform float uFoamSteps;       // 3.0
uniform float uFoamDetailLOD;   // 1 near, 0 at altitude — CPU-side, per 02b §2.4
uniform vec3 cFoam;             // #ebedea
uniform vec3 cFoamShadow;       // #b1cbd3
/** Sabotage: 1 skips the quantiser and ships the raw smoothstep the doc forbids. */
uniform float uFoamSmoothSabotage;
/**
 * Atlas debug view — 0 off, 1 signed distance, 2 depth, 3 exposure, 4 foam mask alone.
 *
 * 02b §10's authoring checklist wants the shore data inspectable; more immediately, a foam
 * band that fails to appear is indistinguishable from an atlas that baked wrong, a uniform
 * that never bound, and a UV transform that is off by an origin. Being able to look at the
 * channels separates those in one render instead of three guesses.
 */
uniform float uShoreDebug;
/**
 * Master switch for the FOAM LAYERS ONLY, 1 in every shipping path. Wet sand ignores it, so
 * the gate's difference measures foam and nothing else.
 *
 * Exists for the gate. Identifying foam by colour cannot be made reliable here: the sea ramp's
 * shallow end (#a2baa7) and hazed limestone are both pale near-neutrals, and every threshold
 * tried either swallowed them or missed real foam — the first two attempts reported 100% and
 * 92% coverage of water that was mostly terrain. Rendering the same frame twice and diffing
 * identifies foam pixels exactly, with no heuristic at all.
 */
uniform float uFoamEnable;

struct ShoreSample {
  float distance;   // signed metres, negative under land
  float depth01;    // the same depth the shelf ramp reads
  float normalAngle;// radians
  float exposure;   // 0 sheltered cove, 1 exposed headland
  bool inAtlas;
};

ShoreSample sampleShore(vec2 worldXZ) {
  vec2 uv = (worldXZ - uShoreOrigin) / uShoreWorldSize;
  ShoreSample s;
  s.inAtlas = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  if (!s.inAtlas) {
    // Outside the baked region there is no coast, so nothing should foam. Returning the
    // clamped edge texel instead would smear the island's last row of foam across the whole
    // open sea, which is what ClampToEdge does if you let it.
    s.distance = uMaxShoreDist;
    s.depth01 = 1.0;
    s.normalAngle = 0.0;
    s.exposure = 0.0;
    return s;
  }
  vec4 t = texture2D(uShoreAtlas, uv);
  s.distance = (t.r - 0.5) * 2.0 * uMaxShoreDist;
  s.depth01 = t.g;
  s.normalAngle = t.b * 6.2831853 - 3.14159265;
  s.exposure = t.a;
  return s;
}

/**
 * 02b §2.2 verbatim: antialias the raw edge with ONE smoothstep, then collapse to N flat
 * bands. Not a raw step — that moires at distance — and not a bare smoothstep, which is a
 * soft gradient and against 00 §3 rule 1.
 */
float quantizeFoam(float x, float steps) {
  float s = smoothstep(0.0, 1.0, clamp(x, 0.0, 1.0));
  return floor(s * steps) / steps;
}

/**
 * Asymmetric run-up phase — 02b §2.1.
 *
 * A sine is symmetric and reads mechanical; real swash surges fast and drains slowly. So the
 * phase is a sawtooth: fract() rises linearly and drops instantly, and feeding the RISING
 * part through a sharp curve and the falling part through a slack one gives a fast leading
 * edge with a long retreat. The doc traces the same conclusion through the Babylon.js beach
 * thread, where a symmetric version looked wrong for exactly this reason.
 *
 * @return 0..1 reach of the swash at this point on the shore right now
 */
float runupBand(float shoreDist, float reach) {
  // A gradient TOWARD shore: 1 at the waterline, 0 at the run-up limit. 02b §2.1's
  // construction starts here — "a gradient towards shore", offset by time, repeated with
  // frac, then thresholded.
  float g = 1.0 - clamp(max(shoreDist, 0.0) / max(reach, 0.5), 0.0, 1.0);
  if (g <= 0.0) return 0.0;

  // Successive swash fronts travelling shoreward through that gradient.
  //
  // The first version multiplied the band's REACH by the phase, which reads plausibly and is
  // wrong: whenever the phase was low the whole band collapsed to nothing, so the foam mask
  // measured ~0 almost everywhere and the system rendered as if it were switched off. The
  // phase decides where the leading edge IS; it must not decide whether the band exists.
  float saw = fract(g * uRunupCycles - uWaveTime * uRunupSpeed);

  // Asymmetric, per 02b §2.1: a swash surges fast and drains slowly, and a symmetric sine
  // reads mechanical. Sharp leading edge, long trailing retreat.
  //
  // NOT multiplied by g. Fading the band's strength toward its limit is a soft gradient, which
  // is the thing 02b §2.2 exists to forbid — and it interacts badly with the quantiser, which
  // needs its input above ~0.4 to produce anything at all after the antialiasing smoothstep.
  // With the fade in place the measured foam coverage was 0.1%: the band was being computed
  // and then quantised straight back to nothing. g bounds where the swash reaches; the saw
  // decides whether foam is there; neither dims it.
  float lead = smoothstep(0.0, 0.10, saw);
  float trail = 1.0 - smoothstep(0.45, 0.9, saw);
  return min(lead, trail);
}

/** Retained for the wet-sand band, which wants the bare cycle rather than a spatial band. */
float runupPhase(float shoreDist, float exposure) {
  return 0.5 + 0.5 * sin(uWaveTime * uRunupSpeed * 6.2831853 - shoreDist * uRunupFreq);
}

/**
 * @param worldXZ  surface position
 * @param fade     0..1 overall foam strength; 0 removes the system entirely
 * @return         rgb foam colour, a = coverage 0..1
 */
vec4 shoreFoam(vec2 worldXZ, float fade) {
  ShoreSample s = sampleShore(worldXZ);

  if (uShoreDebug > 0.5) {
    if (!s.inAtlas) return vec4(0.35, 0.0, 0.35, 1.0);            // magenta: outside the atlas
    if (uShoreDebug < 1.5) {
      // Signed distance: red landward, green seaward, black band on the zero contour.
      float d = s.distance;
      vec3 c = d < 0.0 ? vec3(1.0, 0.3, 0.2) : vec3(0.2, 1.0, 0.4);
      c *= clamp(abs(d) / uMaxShoreDist, 0.0, 1.0);
      if (abs(d) < 1.0) c = vec3(1.0);
      return vec4(c, 1.0);
    }
    if (uShoreDebug < 2.5) return vec4(vec3(s.depth01), 1.0);
    if (uShoreDebug < 3.5) return vec4(vec3(s.exposure), 1.0);
  }

  if (!s.inAtlas || s.distance > uMaxShoreDist || fade <= 0.001 || uFoamEnable < 0.5) return vec4(0.0);

  // Layer 1: the static ring. Seaward side only — foam clings to the waterline, it does not
  // sit on dry land. Always on, never animated, and cheap enough that 02b §7.3 keeps it alive
  // even when every other shoreline layer has been budgeted away.
  float ring = 1.0 - smoothstep(0.0, uRingWidth, max(s.distance, 0.0));
  ring *= step(-0.6, s.distance);

  // Layer 2: the animated run-up. Reach scales with exposure, so an open headland is washed
  // much further than a sheltered cove — 02b §2.1 and §8.5's "8-15 m landward, scaled by
  // exposure channel A". The floor is 0.6 rather than 0.45: at 0.45 a sheltered stretch's band
  // was thin enough to disappear into the ring, which is not what "scaled by exposure" means.
  float reach = uRunupReach * mix(0.6, 1.0, s.exposure);
  float band = runupBand(s.distance, reach);
  // Break up positional repetition, never soften the edge (02b §2.3): the noise moves WHERE
  // the band sits, it does not blur it.
  band *= 0.7 + 0.3 * fbm2(worldXZ * 0.09);
  band *= step(-1.5, s.distance);

  // The run-up layer is the one that must go at altitude (02b §2.4): a metre-scale animated
  // band under a 1500 m camera is sub-pixel and will alias into crawling noise. The static
  // ring survives as a flat coastline stroke.
  float runup = band * uFoamDetailLOD;

  float raw = max(ring, runup);
  float tone = quantizeFoam(raw, uFoamSteps);

  // Debug 4: the tone alone, so a missing band can be told apart from a band that is present
  // but too thin, too dim, or occluded by terrain.
  if (uShoreDebug > 3.5) return vec4(vec3(tone), 1.0);

  // THE SABOTAGE TARGETS WHAT ACTUALLY PRODUCES FLATNESS.
  //
  // `?foam=smooth` originally just bypassed the floor() in quantizeFoam, and the gate did not
  // notice: it still reported 4 flat tones and passed. That was correct behaviour from a
  // useless control. Once coverage became binary and the tone chose among three fixed colours,
  // the floor() stopped being the thing that makes the output flat — the three-way branch does
  // that, and floor()'s output already lands exactly on its thresholds. So the control now
  // does what 02b §9 actually forbids: a continuous ramp between the foam tones, faded in by
  // its own raw value. That is the "raw smoothstep foam edge" the checklist rules out, and the
  // gate's tone count sees it immediately.
  if (uFoamSmoothSabotage > 0.5) {
    float soft = smoothstep(0.0, 1.0, raw);
    if (soft <= 0.0) return vec4(0.0);
    return vec4(mix(cFoamShadow, cFoam, soft), soft * fade);
  }

  // COVERAGE IS BINARY; THE QUANTISED VALUE PICKS A TONE.
  //
  // The first version returned `tone` as the alpha, which looks reasonable and is wrong: the
  // outermost band then ships at one-third opacity, so the widest and most visible part of the
  // foam is a 33% wash of near-white over teal. Measured, it came out #97b8ac against #205d72
  // water — a faint haze, not foam. 00 §3 rule 1 asks for flat tonal bands and 02b §2 for
  // "hard edges", and neither is a translucent gradient. So presence is a hard cut and the
  // three quantised levels choose among three opaque foam tones instead.
  if (tone <= 0.0) return vec4(0.0);
  vec3 color = tone > 0.66 ? cFoam : (tone > 0.33 ? mix(cFoamShadow, cFoam, 0.55) : cFoamShadow);
  return vec4(color, fade);
}

/**
 * Wet sand — 02b §5.
 *
 * Darkens and cools beach albedo within a band landward of the waterline, and the band
 * breathes with the same run-up phase the foam uses, so the wet shape mirrors where the last
 * wave actually reached. A tint lerp, never a multiply — 00 §3 rule 2 governs this the same
 * way it governs shadows.
 */
vec3 applyWetSand(vec3 albedo, vec2 worldXZ, vec3 wetTint, float bandWidth) {
  ShoreSample s = sampleShore(worldXZ);
  if (!s.inAtlas || s.distance > 0.0) return albedo;

  float landward = -s.distance;                 // metres inland from the waterline
  float phase = runupPhase(s.distance, s.exposure);
  float reach = bandWidth * mix(0.5, 1.0, s.exposure) * (0.55 + 0.45 * phase);
  float wet = 1.0 - smoothstep(0.0, reach, landward);
  // Quantised like the foam, for the same reason: a smooth damp gradient is a soft edge.
  wet = quantizeFoam(wet, uFoamSteps);
  return mix(albedo, wetTint, wet * 0.85);
}
