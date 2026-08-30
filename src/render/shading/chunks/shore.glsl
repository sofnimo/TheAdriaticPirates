#include ./wave_time.glsl;
#include ./hash_noise.glsl;

// =====================================================================
// SHORELINE FOAM — breaking crests in the nearshore.
//
// A DEPARTURE FROM 02b §2.1, which specifies a static waterline ring plus an animated swash
// run-up, and the reason is worth stating because the doc is otherwise followed closely. Both
// of those layers treat foam as a property of the COASTLINE — a stroke that hugs the shore all
// the way round an island, on every side of it at once. That is a fair model of a beach seen
// from the sand. It is the wrong model from a seaplane at 200-1500 m, where what you actually
// read is which face of an island is taking the sea: whitecaps piling on the windward shore
// while the far side sits glassy. The old version drew the same collar on both.
//
// So foam is now a property of the water, gated on three things at once — nearshore, facing
// the incoming swell, and at the crest of a wave. See `shoreFoam` below.
//
// The quantiser survives unchanged. 02b §2.2 is unusually direct about
// this — every source it surveyed defaults to a bare smoothstep, and the doc says override
// that. One smoothstep for antialiasing, then floor() to flat bands. The §9 checklist repeats
// it as "never ship a raw smoothstep foam edge", so it is the one thing here with its own
// negative control (`?foam=smooth`).
// =====================================================================

uniform sampler2D uShoreAtlas;
uniform vec2 uShoreOrigin;      // world XZ of the atlas's min corner
uniform float uShoreWorldSize;  // metres covered by the atlas
uniform float uMaxShoreDist;    // metres the R channel spans; must exceed uFoamReach
uniform float uFoamReach;       // metres offshore the surf zone extends
uniform float uFoamCrest;       // -1..1 crest phase foam starts at
uniform float uFoamCrestSoft;   // width of that threshold, kept narrow
uniform float uFoamCrestNear;   // metres inside which foam rides the crests
uniform float uFoamCrestFar;    // metres beyond which it settles to a steady band
uniform float uFoamExposure;    // 0-1 fetch below which a coast simply does not foam
// THE ARRIVING WAVE. Wave 1 of the sea state, written out as direction/wavenumber/frequency so
// that both the water and the LAND can evaluate its phase — the terrain shader has no wave
// stack, and this is the only thing it needs from one. Set by `syncShoreSwell`.
uniform vec2 uSwashDir;         // unit XZ, the way the crests TRAVEL
uniform float uSwashK;          // 2*pi / wavelength
uniform float uSwashOmega;      // sqrt(g*k), the same relation the wave stack uses
uniform float uSwashReach;      // metres the waterline runs up and back down the beach

uniform vec3 cWetSand;          // the tint sand takes where the wave just reached
uniform float uWetSandBand;     // metres of damp band at rest, before the swash moves it
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
 * THE ARRIVING WAVE, at a point on the coast. -1 in the trough, +1 at the crest.
 *
 * The single phase both sides of the waterline run on. It is wave 1 of the sea state, written
 * out here from `uSwashDir/K/Omega` rather than sampled from the Gerstner stack, because the
 * land materials have no wave stack — the terrain shader knows nothing about `uWaves` — and
 * this is the one number it needs from it. Three uniforms and a sine are cheaper than plumbing
 * the whole stack into every land material, and being an exact copy of wave 1's phase term
 * means the surf on the beach is running on the same wave you can see arriving offshore.
 *
 * It replaces a free sine on `uRunupSpeed`/`uRunupFreq` that had no relation to the swell at
 * all: the sand could be drying while a crest was landing on it.
 */
float swashPhase(vec2 worldXZ) {
  return sin(dot(uSwashDir, worldXZ) * uSwashK - uWaveTime * uSwashOmega);
}

/**
 * How far up the beach the water has reached right now, in metres, signed.
 *
 * Positive pushes the waterline INLAND — the swash running up — and negative pulls it back
 * down as the water withdraws. Everything that keys off distance-from-shore subtracts this, so
 * the whole surf band travels up and down the sand together instead of the foam brightening
 * and dimming where it stands.
 *
 * Slower coming back than going up. A swash rushes in and drains out, so the phase is bent
 * with a power: the crest half of the cycle is short and the retreat is long, which is the
 * asymmetry that makes it read as water on sand rather than as a sine.
 */
float swashReach(vec2 worldXZ) {
  float p = swashPhase(worldXZ);
  float up = 0.5 + 0.5 * p;                  // 0..1
  up = pow(up, 0.65);                        // fast up, slow back
  return (up * 2.0 - 1.0) * uSwashReach;
}


/**
 * BREAKING CRESTS IN THE NEARSHORE — the foam model, rebuilt.
 *
 * This replaces a waterline ring plus an animated swash run-up. That construction drew foam
 * as a property of the COASTLINE: a stroke that hugged the shore all the way round an island,
 * present on every side of it at once, and animated by a phase of its own that had nothing to
 * do with the waves running past. Which meant an island in a heavy swell wore the same collar
 * on its sheltered back as on the face taking the sea.
 *
 * Foam is now a property of the WATER, and it needs three things to be true at once:
 *
 *   1. CLOSE TO SHORE. Within `uFoamReach` of the coastline — where a wave feels the bottom,
 *      steepens and breaks. Out in open water it does not.
 *   2. ON THE SIDE THE SWELL ARRIVES FROM. Gated on the fetch field (ShelterField), which is
 *      already the answer to "how much open sea did the swell cross to get here". The lee of
 *      an island scores near zero, so the calm side simply has no foam on it — the same field
 *      that flattens the waves there takes their whitecaps with them.
 *   3. AT THE TIP OF A WAVE, CLOSE UP. Gated on the crest phase near the camera, so foam sits
 *      on the crests and moves with them; the gate opens with distance so far islands wear a
 *      steady white edge instead of a field of flickering sub-pixel marks.
 *
 * The three multiply. A gate that added them would put foam on every crest in the ocean and on
 * every metre of every coast, which is the failure the old model actually had.
 *
 * @param worldXZ    surface position
 * @param crest01    -1..1 wave phase, 1 at the crest — `gerstnerCrest`
 * @param exposure01 0..1 open-water fetch — `shelterExposure`
 * @return           rgb foam colour, a = coverage 0..1
 */
vec4 shoreFoam(vec2 worldXZ, float crest01, float exposure01, float viewDist) {
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

  // THE EDGE IS RAGGED, NOT POLYGONAL, and this is where that is decided.
  //
  // `s.distance` comes out of an atlas at 8 m per texel over an 8 km tile. Bilinear across a
  // texel that large is smooth in value but not in shape: its contours are the diagonals of the
  // sample grid, so a band edge drawn on it runs in long straight facets with corners every
  // 8 m. Quantised into three hard tones the facets become stair-steps, and that is the
  // jaggedness at the waterline — geometry from the bake showing through, not aliasing.
  //
  // Perturbing the distance itself fixes it at the source. Every downstream band edge — foam,
  // wet sand — follows the same wandering contour, so they stay consistent with each other
  // while none of them is straight. Two octaves, at metre scale and at ten-metre scale, so the
  // outline breaks up close in and still reads as an irregular coast further out. This softens
  // no edges: a step() on a wandering field is exactly as hard as a step() on a flat one, which
  // is what 00 §3 rule 1 asks for.
  float edge = (fbm2(worldXZ * 0.09) - 0.5) * 3.4 + (fbm2(worldXZ * 0.021) - 0.5) * 7.0;

  // AND THE WAVE RUNS UP THE BEACH. Subtracting the swash moves the whole surf band inshore as
  // a crest lands and drags it back out as the water withdraws, so the waterline travels.
  // Before this the band sat still and only changed brightness, which reads as foam blinking
  // on and off rather than as water arriving.
  float dist = s.distance - swashReach(worldXZ) + edge;

  // Water only, and only inside the band. Land has no foam on it, and neither does open sea.
  // Tested on the SHIFTED distance, so the foam follows the wave past the still waterline.
  if (!s.inAtlas || s.distance < 0.0 || dist > uFoamReach) return vec4(0.0);
  if (uFoamEnable < 0.5) return vec4(0.0);

  // 1. Close to shore. Full strength at the waterline, gone by the reach — a wave breaks
  //    harder the shallower it gets, so this is a ramp rather than a hard edge on the outer
  //    limit. The edge that must stay hard is the crest gate below, not this one.
  float near = 1.0 - smoothstep(uFoamReach * 0.35, uFoamReach, max(dist, 0.0));

  // 2. On the side the swell arrives from. Below the threshold there is simply no foam: the
  //    lee of an island is not lightly foamed, it is glassy.
  float facing = smoothstep(uFoamExposure, uFoamExposure + 0.2, exposure01);

  // 3. At the tip of the wave — BUT ONLY UP CLOSE.
  //
  // Two readings of the same shoreline, chosen by how far away it is.
  //
  // Near, the crest gate is on: foam sits on the tips of the waves and travels with them,
  // which is what you see standing off a beach. Far, the gate opens to 1 and the same three
  // other terms leave a steady band along the exposed shore — thicker, and not moving.
  //
  // That is not a compromise, it is the correct picture at each range, and it is 02b §2.4's
  // argument arriving at a different answer than the doc's. At a kilometre a crest mark is
  // sub-pixel: gating on it there does not draw small foam, it draws foam that flickers on and
  // off as crests cross pixel centres, which reads as crawling noise. What an island's surf
  // actually reads as from the air is a white edge on the windward side — steady, because you
  // cannot resolve the individual waves making it. The doc solved the same aliasing by deleting
  // the animated layer at altitude; this keeps the foam and stops it animating, which holds the
  // island's silhouette instead of losing it.
  float crestGate = smoothstep(uFoamCrest, uFoamCrest + uFoamCrestSoft, crest01);
  float detail = 1.0 - smoothstep(uFoamCrestNear, uFoamCrestFar, viewDist);
  float crest = mix(1.0, crestGate, detail);

  // Break up positional repetition, never soften the edge (02b §2.3): the noise moves WHERE
  // foam sits along a crest, it does not blur it. Without this every crest foams along its
  // whole length and the sea reads as corduroy.
  //
  // It MODULATES between 0.55 and 1 rather than running to zero. A term that reaches zero
  // multiplies `raw` down through the quantiser's first step — which needs about 0.35 to
  // produce any tone at all — so a break-up meant to thin the foam along a crest instead
  // deleted it, and the gate measured 0% coverage on a system that was computing foam
  // correctly and then rounding all of it away.
  float broken = mix(0.55, 1.0, smoothstep(0.4, 0.7, fbm2(worldXZ * 0.035)));

  // The whole thing is animated, so it is all subject to 02b §2.4's altitude LOD — a
  // metre-scale foam mark under a 1500 m camera is sub-pixel and aliases into crawling noise.
  // The old model kept a static ring alive down there; this one has nothing static to keep,
  // so at altitude the foam goes and the coastline is drawn by the shelf colour alone.
  // NOT multiplied by uFoamDetailLOD any more. That uniform faded the whole system out with
  // altitude, which is why distant islands carried no surf at all; the crest blend above now
  // does the anti-aliasing job it was there for, by making distant foam steady rather than by
  // deleting it.
  float raw = near * facing * crest * broken;
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
    return vec4(mix(cFoamShadow, cFoam, soft), soft);
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
  return vec4(color, 1.0);
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

  // THE SAME SWASH THE FOAM RIDES, and the same ragged edge, so the damp line and the surf
  // that wet it are one event seen from two sides of the waterline rather than two animations
  // that happen to be near each other. The wave runs up: the band reaches inland. It drains:
  // the band shrinks back and the sand behind it dries.
  float edge = (fbm2(worldXZ * 0.09) - 0.5) * 3.4 + (fbm2(worldXZ * 0.021) - 0.5) * 7.0;
  float landward = -s.distance - edge;          // metres inland from the waterline
  float swash = swashReach(worldXZ);

  // An exposed shore is worked harder, so its wet band is wider — the same exposure the foam
  // gates on, read off the atlas rather than recomputed.
  float reach = bandWidth * mix(0.5, 1.0, s.exposure) + swash;
  float wet = 1.0 - smoothstep(0.0, max(reach, 0.5), landward);
  // Quantised like the foam, for the same reason: a smooth damp gradient is a soft edge.
  wet = quantizeFoam(wet, uFoamSteps);
  return mix(albedo, wetTint, wet * 0.85);
}
