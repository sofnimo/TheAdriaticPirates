#include ./wave_time.glsl;
#include ./hash_noise.glsl;
#include ./hsl.glsl;

// =====================================================================
// PAINTED GLINTS — `02 — Water.md` §3, 00 §3 rule 4.
//
// Highlights are "dashes, ovals and slashes with hard edges", covering only a few percent of
// sea pixels. Never a Blinn-Phong lobe.
//
// CALIBRATED AGAINST THE AMBIENT FRAMES, NOT THE MOTION FRAMES.
// The earlier version was measured off plane-topdown-shadow-sea-alt-crop.jpg.jpg, whose
// streaks radiate from behind the aircraft — the anime speed-line convention for velocity,
// not a water property. Re-measuring the two genuine ambient-sparkle frames by
// connected-component analysis moved two things:
//
//   aspect   8.8:1 -> 4.6:1   ambient marks are stubbier than speed lines
//                             (harbour median 4.5:1, open sea 4.8:1; motion frame 6.6:1)
//   colour   two fixed hexes -> derived from the local water colour
//
// What did NOT move is the single shared axis. The ambient frames measure R=0.98 and R=1.00
// on axial alignment, against R=0.84 for the speed-line frame — the sparkle is MORE globally
// aligned, not less, because wave crests in one sea state are parallel. See art/seaRamp.ts
// GLINT_SHAPE for the full measurements.
//
// Construction: world XZ is rotated into swell-local space and COMPRESSED along the swell
// axis. A round blob thresholded in that squashed space maps back to an ellipse in world
// space — which is what turns "noise blob" into "painted glint", and gives tapered ends for
// free. The threshold is a step(), never a smoothstep().
// =====================================================================

uniform vec2 uSwellDir;        // unit XZ, from wave 1
uniform float uGlintCoverage;  // target fraction of sea pixels
uniform float uGlintScale;     // cells per metre across the swell
uniform float uGlintStretch;   // along-swell compression = 1/aspect of the LIGHT population
uniform float uGlintDarkAspectMul; // dark marks run longer: dark.aspect / light.aspect
uniform float uGlintDrift;     // metres/second the field slides along the swell
uniform float uGlintFade;      // 0 = fully faded out (high altitude), 1 = full
// Two populations. x = light marks, y = dark marks. See art/seaRamp.ts GLINT_RULE.
uniform vec2 uGlintSatScale;   // (0.33, 0.53)  saturation multipliers
uniform vec2 uGlintLift;       // (+0.24, -0.08) SIGNED lightness offsets
uniform vec2 uGlintLiftVar;    // (0.18, 0.06)  per-mark spread
uniform float uGlintDarkFrac;  // 0.20 — image-4 measures roughly 4:1 light:dark
uniform float uGlintMaxLight;  // 0.70 — ceiling on the light population only
uniform vec2 uGlintDepthFade;  // depth01 range over which sparkle fades in
uniform float uGlintPatchScale;   // metres per patch-noise unit
uniform float uGlintPatchContrast; // 0 = even field, 1 = strongly patchy
uniform float uGlintPatchMean;     // mean of the patch gate, so patchiness does not thin the field
uniform float uGlintFacingMean;    // mean of the sun-facing gate's area term, same purpose
uniform vec2 uGlintRangeFade;      // metres: density taper with viewing distance

/** World XZ -> swell-local, compressed-along-swell cell space. */
vec2 swellUV(vec2 worldXZ) {
  vec2 d = normalize(uSwellDir);
  vec2 perp = vec2(-d.y, d.x);
  float along = dot(worldXZ, d) - uWaveTime * uGlintDrift;
  float across = dot(worldXZ, perp);
  return vec2(along * uGlintStretch, across) * uGlintScale;
}

/**
 * Glint colour from the water under it — SIGNED, two populations.
 *
 * Marks go both lighter and darker than the water, roughly 4:1 (image-4.jpg). Measured
 * against the base water #025277 there:
 *
 *   light  #548da2   dHue -3 deg   saturation x0.33   lightness +0.24
 *   dark   #142c3e   dHue +7 deg   saturation x0.53   lightness -0.08
 *
 * Hue is near-invariant in both directions and saturation drops hard in both, so the
 * derive-from-water rule holds; only the lightness term needed a sign. Dropping the dark
 * population is what left the surface reading as flat colour with highlights printed on it
 * rather than as a lit, textured surface.
 *
 * Measured in sRGB (the frames are sRGB) so the conversion happens here rather than applying
 * an sRGB-derived constant to linear values, which would silently change what it does.
 *
 * @param isDark  0 = light population, 1 = dark
 */
vec3 glintColor(vec3 waterLinear, float brightRand, float isDark) {
  vec3 hsl = rgb2hsl(linearToApproxSrgb(waterLinear));
  hsl.y *= mix(uGlintSatScale.x, uGlintSatScale.y, isDark);
  float lift = mix(uGlintLift.x, uGlintLift.y, isDark);
  float spread = mix(uGlintLiftVar.x, uGlintLiftVar.y, isDark);
  // The spread runs away from the water in whichever direction this population goes, so a
  // dark mark's variation makes it darker still rather than dragging it back toward the sea.
  float z = hsl.z + lift + brightRand * spread * sign(lift);
  // The ceiling guards the light population only; a dark mark cannot run away upward.
  hsl.z = clamp(z, 0.0, mix(uGlintMaxLight, 1.0, isDark));
  return approxSrgbToLinear(hsl2rgb(hsl));
}

/**
 * @param worldXZ  surface position
 * @param facing   0..1, how much this wave face tilts toward the sun. Glints cluster on
 *                 sun-facing faces instead of spreading uniformly — cheap Fresnel-ish
 *                 gating that never evaluates a specular lobe.
 * @param water    the shaded water colour under this pixel, linear
 * @param depth01  sea depth, used to keep sparkle off sheltered shallows — see below
 * @return         rgb glint colour, a = 0/1 coverage mask
 */
vec4 glintField(vec2 worldXZ, float facing, vec3 water, float depth01, float viewDist) {
  vec2 uv = swellUV(worldXZ);

  // RANGE TAPER. Coverage as a fraction of PIXELS is framing-dependent, but the field is
  // world-space, so a fixed fraction blankets the frame at any altitude. The references say
  // otherwise, and consistently: image-4.jpg's near water runs 16.1%, mid-altitude open sea
  // in plane-skimming runs 1.6%, and plane-over-archipelago-wide and the peninsula show
  // essentially none at all. Marks thin out with distance long before they alias out.
  //
  // This tapers DENSITY, not radius, so distant water loses marks rather than growing a haze
  // of shrunken ones. The sub-pixel guard below still handles the aliasing end separately.
  float rangeFade = 1.0 - smoothstep(uGlintRangeFade.x, uGlintRangeFade.y, viewDist);

  // Sub-pixel guard (02 §3.2). Where one cell covers less than ~0.75 px the field would
  // boil frame to frame, so it fades to nothing rather than aliasing in and out. Glints are
  // painted marks, not physically-accurate sparkle — dropping them at range is correct.
  float footprint = max(fwidth(uv.x), fwidth(uv.y));
  float footprintFade = 1.0 - smoothstep(0.5, 1.4, footprint);

  // Sparkle belongs to open water. Both cove references — image-3 and the karst pool — are
  // glassy across the whole turquoise shelf with no discrete marks anywhere, while the
  // harbour and open-sea frames are full of them. Depth stands in for shelter here: it is
  // the signal available in Step 2, and it puts the marks where the references put them.
  // Step 4's fetch/wind field is the honest version of this.
  float shelterFade = smoothstep(uGlintDepthFade.x, uGlintDepthFade.y, depth01);

  // Patchiness. 02 §3 asks for marks "clustered in patches with real empty water between
  // them", and the harbour reference does exactly that — dense runs with bare stretches
  // between, not an even scatter. A per-cell hash alone cannot produce it: it is uniform by
  // construction, so the field comes out evenly spread however much the marks themselves
  // vary. A low-frequency field gating whole patches is the missing scale, and it is the
  // right phenomenon too — this is where the cat's-paws of wind are touching the water.
  // NB: `patch` is a reserved word in GLSL ES 3.00 (tessellation), and three upgrades
  // this shader to ES 3.00 on WebGL2 — so it compiles as GLSL1 and fails on WebGL2 only.
  float patchNoise = fbm2(worldXZ / uGlintPatchScale + uWaveTime * 0.004);
  float patchGate = mix(1.0, smoothstep(0.35, 0.62, patchNoise), uGlintPatchContrast);

  float fade = uGlintFade * footprintFade * shelterFade;
  if (fade <= 0.001 || patchGate <= 0.001 || rangeFade <= 0.001) return vec4(0.0);

  vec2 cellBase = floor(uv);
  vec2 f = uv - cellBase;

  // Patchiness gates HOW MANY marks appear, never how big they are. Folding it into `fade`
  // scales the radius instead, which shrinks every mark everywhere — measured, that took
  // coverage from 3.6% to 1.2% and made the marks smaller rather than clumpier.
  //
  // Density and radius together hit the coverage target: coverage ~= density * pi * r^2. The
  // target is an average over open water, so density is normalised by the gate's mean and
  // the radius is computed from the UNGATED density — patches redistribute marks, they do
  // not thin the field out.
  const float BASE_DENSITY = 0.5;
  float patchMean = mix(1.0, uGlintPatchMean, uGlintPatchContrast);
  float density = clamp(BASE_DENSITY * patchGate * rangeFade / patchMean, 0.0, 1.0);
  // The sun-facing gate below scales each mark's radius, so it thins coverage the same way
  // patchiness would. Normalising by its mean keeps uGlintCoverage meaning what it says —
  // measured coverage over lively open water — rather than roughly half of it.
  float baseRadius = sqrt(max(uGlintCoverage, 0.0)
                          / (BASE_DENSITY * 3.14159265 * max(uGlintFacingMean, 0.05)));

  float mask = 0.0;
  float brightRand = 0.0;
  float markIsDark = 0.0;

  // Scan the 3x3 neighbourhood so a mark can sit ANYWHERE in its cell and still be drawn
  // when it overhangs the edge. One-cell evaluation forces centres into the middle of each
  // cell, and the leftover regularity reads as faint diagonal rows across open water —
  // visible in the previous build and exactly the "mechanical" tell 00 §3 rule 7 warns about.
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 offset = vec2(float(ox), float(oy));
      vec2 cell = cellBase + offset;
      if (hash12(cell) > density) continue;

      vec2 jitter = hash22(cell + 7.31);
      float sizeRand = hash12(cell + 19.7);

      // Which population this mark belongs to. Its own hash, so darkness does not correlate
      // with size or position.
      float isDark = step(hash12(cell + 91.7), uGlintDarkFrac);

      // Per-mark aspect. Without this every mark is the same lens at the global stretch and
      // the shape distribution comes out far too tight. The spread is solved rather than
      // guessed: with the square bias, r=0.5 gives the median and r=0.9 the 90th percentile,
      // so mix(0.78, 1.66, r*r) puts the median on image-4's 6.9:1 and p90 on its 10.3:1.
      // Dark marks run longer — 8.5 median, 11.5 p90 — carried by uGlintDarkAspectMul; their
      // spread is a little wider than measured, which is noted rather than separately tuned.
      float aspectRand = hash12(cell + 61.3);
      float stretch = mix(0.78, 1.66, aspectRand * aspectRand)
                    * mix(1.0, uGlintDarkAspectMul, isDark);

      // Radius shrinks as the mark lengthens so total coverage stays on target.
      float radius = baseRadius * mix(0.55, 1.45, sizeRand) * inversesqrt(stretch)
                   * mix(0.35, 1.25, facing) * fade;

      vec2 delta = f - (offset + jitter);
      delta.x /= stretch;

      // Hard cut. No smoothstep: the mark's edge is the whole point.
      float hit = step(length(delta), radius);
      if (hit > mask) {
        mask = hit;
        markIsDark = isDark;
        // Brightness uses its OWN hash. Deriving it from sizeRand correlates the two, so
        // every pale mark is also the largest — a tell the reference frames do not have.
        brightRand = hash12(cell + 43.7);
      }
    }
  }

  return vec4(glintColor(water, brightRand, markIsDark), mask);
}
