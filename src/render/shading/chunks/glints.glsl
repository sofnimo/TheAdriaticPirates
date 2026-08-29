#include ./wave_time.glsl;
#include ./hash_noise.glsl;
#include ./hsl.glsl;

// =====================================================================
// PAINTED GLINTS — the light and dark spots caught on moving water.
//
// A glint is a REFLECTION: a patch of wave face angled so that it sends the sun, or the
// bright sky beside it, straight at the eye. The faces next to it send something darker. So
// the field has to produce both — marks above the water's lightness and marks below it — or
// the sea reads as flat colour with highlights printed on top of it.
//
// THREE STOPS OFF THE WATER, NOT THREE FIXED HEXES. Every mark takes the colour of the sea
// underneath it and moves only in LIGHTNESS: the bottom stop darker, the middle lighter, the
// top lightest, with saturation falling as it climbs. The same mark over a turquoise shelf
// and over deep blue is therefore two different colours, which is what the eye expects of
// light on water and what keeps it from looking like paint dropped on top. The TOP stop is
// the most prevalent of the three — it is the highlight; the other two exist to give it
// something to sit against.
//
// THE MARKS LIE ALONG THE CRESTS. `uSwellDir` is the direction the wave pattern travels. A
// crest is a line of constant phase, so it runs at right angles to that, and the marks are
// laid out along it. The rotation is DERIVED here rather than authored, so turning the swell
// heading turns every mark with it and the two cannot drift out of step.
//
// PUDDLE SHAPES, NOT ELLIPSES. A clean ellipse reads as one stamp repeated once there are
// thousands on screen. Each mark's outline is pushed in and out by a pair of sinusoids in its
// own local angle, at its own phase, so the silhouette is a warped, elongated blob — closer
// to a puddle than to a lozenge — and no two are quite the same shape.
//
// THREE BEHAVIOURS, ALL THREE AT ONCE, ALL THREE OVER THE WHOLE OCEAN. They are three
// different phenomena, not three tunings of one and NOT a choice of one — a real sea carries
// all of them simultaneously, and each covers the entire surface. Only their DENSITY varies
// from place to place, and only one of them is shaped like a triangle:
//
//   PATCHES     Cat's-paws of wind touching down, in clusters with quieter water between,
//               everywhere on the sea. This is the one behaviour graded by proximity: close
//               in, a patch carries all three stops; past `uGlintNearLayers` (~50 m) only the
//               top stop survives, because that is all that resolves at range.
//
//   SUN PATH    The glitter road: a wedge anchored AT THE CAMERA and pointed along the sun's
//               bearing, a point at your feet widening as it runs out — the upside-down
//               triangle you actually see on water. It opens further as the sun drops,
//               because a low sun catches a far wider spread of wave faces on the way to the
//               eye: a tight pool at noon, a road to the horizon at sunset.
//
//               THE WEDGE ADDS MARKS, IT DOES NOT CONFINE THEM. It is a region of the same
//               water where more of the surface happens to be angled at the sun, so it rides
//               on top of the patch field as extra density and shares its lattice. An earlier
//               pass had it gate the whole field instead, which emptied every other square
//               metre of sea the moment the road was switched on. Not proximity graded: the
//               road runs the whole way out.
//
//   WAVE TIPS   Top stop only, held hard to the crest phase so the marks sit on the tips of
//               the waves, and drifting at the crests' own speed so they TRAVEL WITH THEM.
//               Both halves are needed: the phase gate alone puts marks on the tips but
//               leaves them winking on and off against stationary water, which reads as a
//               field flashing in sequence rather than as light riding a wave. Its own
//               lattice, because it is the only one moving at 16 m/s. Not proximity graded.
//
// `uGlintSolo` isolates one of them. It is a DEBUG control and its default is zero, meaning
// all three — the field is the sum, and the probe uses the switch to check that none of the
// three has silently gone empty.
//
// Everything that decides a mark's outline is a step(), never a smoothstep(). The hard edge
// is the whole point: a soft one is a specular lobe wearing a costume.
// =====================================================================

uniform vec2 uSwellDir;         // unit XZ, from wave 1. Marks lie ACROSS this — see above.
uniform float uGlintSolo;       // DEBUG: 0 = all three, 1 = patches, 2 = sun path, 3 = tips
uniform vec3 uGlintBehaviour;   // coverage weight of (patches, sun path, wave tips)
uniform float uGlintFade;       // master multiplier, 1 = on
uniform float uGlintDrift;      // metres/second the patch/road field rides WITH the crests
uniform float uGlintCrestSpeed; // metres/second the crests travel — the wave tips ride this

uniform float uGlintCoverage;   // fraction of open water carrying a mark, all stops together
uniform float uGlintCellMetres; // across-crest world size of one cell, at reference range
uniform float uGlintAspect;     // world long:short of a cell, before per-stop and per-mark
uniform float uGlintRefDist;    // metres — beyond this, cells grow to hold their screen size
uniform float uGlintWobble;     // 0 = clean ellipse, 1 = strongly puddled outline
uniform float uGlintSpeckle;    // base twinkle, every mode, before the distance speckle

// Per stop, ordered (bottom, middle, top).
uniform vec3 uGlintLayerShare;  // coverage split. The top stop is the most prevalent.
uniform vec3 uGlintLayerCell;   // cell-size multiplier: bigger = fewer, larger marks
uniform vec3 uGlintLayerAspect; // aspect multiplier off uGlintAspect
uniform vec3 uGlintLayerFacing; // floor on the sun-facing gate, 1 = ignores the sun entirely
uniform vec3 uGlintLayerCrest;  // how hard this stop is held to wave crests, 0 = not at all

// Colour, all relative to the water beneath the mark.
uniform vec3 uGlintLift;        // SIGNED lightness offset: bottom darker, middle and top up
uniform vec3 uGlintSat;         // saturation multiplier per stop
uniform vec3 uGlintLiftVar;     // per-mark spread on the lift, so the field is not one tone
uniform float uGlintMaxLight;   // ceiling, or pale shallows turn into white confetti

// The glitter road.
uniform float uGlintPathHighSun; // half-angle in radians with the sun overhead
uniform float uGlintPathLowSun;  // half-angle in radians with the sun on the horizon
uniform float uGlintPathSoft;    // 0..1, how much of the half-angle is edge rather than core

// The patches.
uniform float uGlintPatchScale;
uniform float uGlintPatchContrast;
uniform float uGlintPatchMean;
uniform float uGlintNearLayers;   // metres: all three stops inside this, top only beyond
uniform float uGlintFlickerFrom;  // metres: speckle starts here
uniform float uGlintFlickerRate;  // radians/second
uniform float uGlintFlickerDepth; // 0 = steady, 1 = marks blink fully out

uniform vec2 uGlintDepthFade;   // depth01 range over which sparkle fades in
uniform float uGlintFacingMean; // mean of the sun-facing gate, so coverage stays honest
uniform float uGlintCrestMean;  // mean of the crest gate, same purpose

const float GLINT_PI = 3.14159265;
const float GLINT_TAU = 6.28318531;

/** Marks per cell before any gating. Radius is solved against this to hit a coverage. */
const float GLINT_DENSITY = 0.5;

// Per-mark size spread, and the mean of its SQUARE — which is what it does to area, and so
// what has to come back out of the radius solve. E[s^2] for s uniform on [a,b] is
// (a^2 + ab + b^2)/3. Without it the field renders consistently over its authored coverage,
// because the marks that run large contribute area as the square of their size.
const float GLINT_SIZE_MIN = 0.45;
const float GLINT_SIZE_MAX = 1.75;
const float GLINT_SIZE_AREA =
  (GLINT_SIZE_MIN * GLINT_SIZE_MIN + GLINT_SIZE_MIN * GLINT_SIZE_MAX + GLINT_SIZE_MAX * GLINT_SIZE_MAX) / 3.0;

// The two lobes of the puddle warp, and the area the pair adds. The warp multiplies a radius,
// so its effect on area is E[(1 + w*g)^2] = 1 + w^2 * E[g^2], and for a sum of sinusoids at
// distinct frequencies E[g^2] is half the sum of the squared amplitudes.
const float GLINT_WOBBLE_A = 0.62;
const float GLINT_WOBBLE_B = 0.38;
const float GLINT_WOBBLE_AREA = 0.5 * (GLINT_WOBBLE_A * GLINT_WOBBLE_A + GLINT_WOBBLE_B * GLINT_WOBBLE_B);

// Fraction of the time a speckling mark is lit: step(0.38, 0.5 + 0.5*sin(phase)) passes for
// sin(phase) > -0.24, which is (pi + 2*asin(0.24)) / tau of the cycle.
const float GLINT_SPECKLE_DUTY = 0.577;

/**
 * World XZ -> crest-local cell space for one stop.
 *
 * The cell is RECTANGULAR in world space — long along the crest, short across it — and square
 * in the space this returns, so a round threshold in cell space comes back as a lozenge lying
 * along the crest, tapered ends included, with no shape code at all.
 *
 * `lod` is what keeps marks visible at every range: it scales a cell's world size with view
 * distance so the cell subtends a constant angle. Everything downstream is in cell units, so
 * coverage and marks-per-pixel come out distance-invariant for free.
 */
vec2 glintCellUV(vec2 worldXZ, float cellMetres, float aspect, float lod, float salt, float drift) {
  vec2 d = normalize(uSwellDir);
  vec2 crestAxis = vec2(-d.y, d.x);
  float alongCrest = dot(worldXZ, crestAxis);
  // The drift rides the PROPAGATION axis, because the pattern travels the way the waves
  // travel — across the marks rather than along them. Sliding it along the crest instead
  // makes the field crawl sideways under a swell running straight at you.
  //
  // NOTE THE SIGN, and note that `uSwellDir` is the bearing the swell comes FROM. gerstner.glsl
  // writes its phase as `k*dot(d, worldXZ) + omega*t`, so holding a crest means `dot(d, x)`
  // must DECREASE as time runs: crests travel along -d, not +d (art/seaStates.ts spells this
  // out at `swellTravelDirection`, where getting it backwards once put every island's foam on
  // its sheltered side). A feature held at a constant cell coordinate here satisfies
  // `dot(x, d) = const - t*drift`, so it travels along -d too. Positive drift therefore runs
  // WITH the waves. Subtracting instead — which is what this did — walks the whole glint field
  // upwind through the crests.
  float acrossCrest = dot(worldXZ, d) + uWaveTime * drift;
  float shortAxis = max(cellMetres * lod, 0.001);
  // `salt` puts each stop on its own lattice. Without it all three share cell boundaries and
  // stack into obvious clusters instead of overlapping at random.
  return vec2(alongCrest / (shortAxis * max(aspect, 0.001)), acrossCrest / shortAxis) + salt;
}

/**
 * One stop of the ladder, taken off the water underneath the mark.
 *
 * Measured in sRGB because that is the space the lightness offsets were authored in; doing it
 * on linear values would silently change what they mean.
 */
vec3 glintStop(vec3 waterLinear, float lift, float sat, float spread, float brightRand) {
  vec3 hsl = rgb2hsl(linearToApproxSrgb(waterLinear));
  hsl.y *= sat;
  // The spread runs AWAY from the water in whichever direction this stop goes, so a dark
  // mark's variation makes it darker still rather than dragging it back toward the sea.
  float z = hsl.z + lift + brightRand * spread * sign(lift);
  // The ceiling guards the lifted stops only; a dark mark cannot run away upward.
  float ceiling = lift > 0.0 ? uGlintMaxLight : 1.0;
  hsl.z = clamp(z, 0.0, ceiling);
  return approxSrgbToLinear(hsl2rgb(hsl));
}

/**
 * One stop's coverage, as (mask, per-mark random).
 *
 * The random returned is the winning MARK's own hash, not the pixel's. It drives the
 * lightness spread, and taken per pixel it would dapple each mark inside its own outline.
 *
 * TWO GATES DECIDE WHETHER A MARK EXISTS, and neither touches its size. `facing` is how
 * squarely this piece of water throws the sun at the eye; `crest` is how near the top of a
 * wave it sits. Both are compared against the mark's own hash, so a mark is either there at
 * its full authored size or not there at all. An earlier pass multiplied the RADIUS by these
 * instead, and every mark then swelled and shrank as the wave under it rose and fell — the
 * whole field breathed, which no reference frame does. What the gates do still give is
 * trimming: a mark straddling the edge of a crest band is cut off along it, which is exactly
 * what light does at the top of a wave.
 */
vec2 glintLayer(
  vec2 worldXZ, float facing, float crest, float lod,
  float cellMul, float coverage, float aspectMul,
  float facingFloor, float crestGate, float density, float speckle, float salt, float drift
) {
  vec2 uv = glintCellUV(worldXZ, uGlintCellMetres * cellMul, uGlintAspect * aspectMul, lod, salt, drift);

  // How much of this stop survives the two gates HERE, and how much survives them ON AVERAGE
  // over open water. Every gate that thins the field also thins its coverage, so the mean is
  // divided back out of the radius solve or `uGlintCoverage` stops meaning coverage.
  float gate = mix(facing, 1.0, facingFloor) * mix(1.0, crest, crestGate);
  float gateMean = max(mix(uGlintFacingMean, 1.0, facingFloor) * mix(1.0, uGlintCrestMean, crestGate), 0.02);
  // A speckling mark is dark part of the time, which thins coverage the same way.
  float duty = 1.0 - (1.0 - GLINT_SPECKLE_DUTY) * clamp(speckle, 0.0, 1.0);
  // ...as does the mark's shape: the size spread and the puddle warp both scale a radius.
  float shapeArea = GLINT_SIZE_AREA * (1.0 + GLINT_WOBBLE_AREA * uGlintWobble * uGlintWobble);

  float live = max(GLINT_DENSITY * gateMean * duty * shapeArea, 0.001);
  float baseRadius = sqrt(max(coverage, 0.0) / (GLINT_PI * live));

  vec2 cellBase = floor(uv);
  vec2 f = uv - cellBase;
  float mask = 0.0;
  float brightRand = 0.0;

  // A 3x3 sweep, so a mark whose centre sits anywhere in its own cell still draws where it
  // overhangs the edge. Evaluating a single cell forces every centre to the middle of its
  // cell, and the leftover regularity reads as faint diagonal rows across open water.
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 offset = vec2(float(ox), float(oy));
      vec2 cell = cellBase + offset;

      // Does this mark exist at all: density first, then the sun-facing and crest gates.
      if (hash12(cell) > density * gate) continue;

      // SPECKLE. Water at range does not hold a steady mark, it winks — and a little of that
      // close in is what stops the field looking printed. Each mark carries its own phase, so
      // the field shimmers rather than pulsing all together.
      if (speckle > 0.0) {
        float tw = 0.5 + 0.5 * sin(uWaveTime * uGlintFlickerRate + hash12(cell + 3.7) * GLINT_TAU);
        if (mix(1.0, step(0.38, tw), speckle) < 0.5) continue;
      }

      vec2 jitter = hash22(cell + 7.31);
      float sizeRand = hash12(cell + 19.7);
      float aspectRand = hash12(cell + 61.3);

      // Per-mark aspect, biased square so the median stays near the authored figure while a
      // minority run much longer. A tight distribution reads as one stamp repeated.
      float stretch = mix(0.7, 1.9, aspectRand * aspectRand);

      // inversesqrt(stretch) holds a mark's AREA constant as it lengthens, so stretching the
      // field changes the shape of the marks without changing how much sea they cover.
      float radius = min(baseRadius * mix(GLINT_SIZE_MIN, GLINT_SIZE_MAX, sizeRand) * inversesqrt(stretch), 1.0);

      vec2 delta = f - (offset + jitter);
      delta.x /= stretch;

      // THE PUDDLE. Two sinusoids in the mark's own local angle, at its own phase, pushing the
      // outline in and out: the 2-lobe term flattens one pair of sides and swells the other,
      // the 3-lobe term stops the result being symmetric. Because this happens in the ROUND
      // space, before the stretch is undone, the warp lengthens with the mark rather than
      // sitting on it as separate decoration. The epsilon keeps atan off (0,0), which is
      // undefined and would put a NaN through the step at the exact centre of every mark.
      float ang = atan(delta.y, delta.x + 1e-6);
      float ph = hash12(cell + 91.1) * GLINT_TAU;
      float warp = 1.0 + uGlintWobble *
        (GLINT_WOBBLE_A * sin(2.0 * ang + ph) + GLINT_WOBBLE_B * sin(3.0 * ang - 1.7 * ph));

      float hit = step(length(delta), radius * max(warp, 0.05));

      if (hit > mask) {
        mask = hit;
        // Its own hash: deriving brightness from sizeRand correlates the two, so every pale
        // mark would also be the largest — a tell the reference frames do not have.
        brightRand = hash12(cell + 43.7);
      }
    }
  }
  return vec2(mask, brightRand);
}

/**
 * THE GLITTER ROAD. A wedge on the water, anchored at the camera, pointed at the sun.
 *
 * A constant half-ANGLE about the sun's bearing is what produces the upside-down triangle:
 * the wedge is a point at your feet and spreads as it runs out, so its width on the water
 * grows with distance without anything having to say so. The half-angle then opens up as the
 * sun drops, because a low sun catches a far wider spread of wave faces on the way to the eye
 * — at noon a tight pool, at sunset a road reaching across the horizon.
 */
float sunPathGate(vec2 worldXZ, vec3 sunDir) {
  vec2 sunXZ = sunDir.xz;
  // A sun within a degree of straight up has no bearing to point along. There is no road in
  // that case, only a pool directly beneath it, so the field is simply left ungated.
  if (dot(sunXZ, sunXZ) < 1e-6) return 1.0;
  vec2 toPoint = worldXZ - cameraPosition.xz;
  float r = length(toPoint);
  if (r < 0.001) return 1.0;
  float ang = acos(clamp(dot(toPoint / r, normalize(sunXZ)), -1.0, 1.0));
  // sunDir.y is the sine of the elevation: 1 overhead, 0 on the horizon.
  float halfAngle = mix(uGlintPathLowSun, uGlintPathHighSun, clamp(sunDir.y, 0.0, 1.0));
  return 1.0 - smoothstep(halfAngle * (1.0 - uGlintPathSoft), halfAngle, ang);
}

/**
 * Which behaviours are live, as (patches, sun path, wave tips).
 *
 * DEBUG ONLY, and zero — all three together — is the real sea. The three phenomena coexist on
 * the same water; this exists so the probe can confirm each of them independently puts marks
 * down, and so a tuning pass can look at one without the other two on top of it. Compared as
 * floats because WebGL1 has no integer uniform branching worth relying on; the constants live
 * in art/seaRamp.ts as GLINT_SOLO and the two sides have to be changed together.
 */
vec3 glintSoloMask() {
  if (uGlintSolo < 0.5) return vec3(1.0);
  if (uGlintSolo < 1.5) return vec3(1.0, 0.0, 0.0);
  if (uGlintSolo < 2.5) return vec3(0.0, 1.0, 0.0);
  return vec3(0.0, 0.0, 1.0);
}

/**
 * @param worldXZ  surface position
 * @param sunDir   unit, surface -> sun
 * @param facing   0..1 sun-facing term from the half-vector
 * @param crest    0..1, 1 at the top of a wave
 * @param water    the shaded water colour under this pixel, linear — every stop derives from it
 * @param depth01  sea depth, keeps sparkle off sheltered shallows
 * @param viewDist metres from the eye
 * @return         rgb glint colour, a = 0/1 coverage mask
 */
vec4 glintField(
  vec2 worldXZ, vec3 sunDir, float facing, float crest, vec3 water, float depth01, float viewDist
) {
  // Sparkle belongs to open water. Both cove references are glassy across the whole turquoise
  // shelf with no discrete marks anywhere; the fetch field gates this again at the call site.
  float fade = uGlintFade * smoothstep(uGlintDepthFade.x, uGlintDepthFade.y, depth01);
  if (fade <= 0.001) return vec4(0.0);

  float lod = max(1.0, viewDist / max(uGlintRefDist, 1.0));
  vec3 on = glintSoloMask();

  // ---- 1. PATCHES, over the whole sea ----------------------------------------------------
  // NB `patch` is a reserved word in GLSL ES 3.00, which three upgrades to on WebGL2.
  float patchNoise = fbm2(worldXZ / max(uGlintPatchScale, 1.0) + uWaveTime * 0.004);
  float patchGate = mix(1.0, smoothstep(0.35, 0.62, patchNoise), uGlintPatchContrast);
  // Normalised by the gate's own mean, so patchiness REDISTRIBUTES marks rather than thinning
  // the field: the quiet water between cat's-paws is paid for by denser water inside them, and
  // `uGlintCoverage` keeps meaning coverage averaged over open sea.
  float patchDensity = GLINT_DENSITY * uGlintBehaviour.x * on.x *
    patchGate / mix(1.0, uGlintPatchMean, uGlintPatchContrast);

  // ---- 2. THE GLITTER ROAD, laid over that same water ------------------------------------
  // Density ADDED inside the wedge, never a gate on everything outside it. Off the road this
  // is simply zero and the patches carry the sea on their own.
  float roadDensity = GLINT_DENSITY * uGlintBehaviour.y * on.y * sunPathGate(worldXZ, sunDir);

  // Proximity grading belongs to the PATCHES alone — the road and the tips run to the horizon.
  float near = 1.0 - smoothstep(uGlintNearLayers * 0.6, uGlintNearLayers, viewDist);

  // Speckle is a property of DISTANCE rather than of any one behaviour: past ~100 m a mark is
  // small enough that the wave face carrying it can turn in and out of the light between one
  // frame and the next. So it applies to all three, over the base twinkle that is always on.
  float speckle = max(
    uGlintSpeckle,
    smoothstep(uGlintFlickerFrom, uGlintFlickerFrom + 60.0, viewDist) * uGlintFlickerDepth
  );

  vec3 color = water;
  float mask = 0.0;

  // PATCHES AND ROAD SHARE A LATTICE. They draw the same marks on the same water and differ
  // only in how many, so adding their densities costs one set of samples instead of two — and
  // it is the honest model as well: a cat's-paw inside the glitter road is not two populations
  // of mark overlapping, it is one stretch of water doing both things at once.
  //
  // A stop is thinned out, never shrunk. All of this goes into the DENSITY — how many marks
  // exist — and not into the coverage, which is what solves for their radius. Put it on the
  // coverage instead and the bottom and middle stops do not stop appearing as they pass 50 m,
  // they dwindle: every mark still draws, each one smaller than the last, until the field is a
  // haze of specks. Same argument for the depth fade and for the master `uGlintFade`.
  vec3 stopDensity = vec3(
    patchDensity * near + roadDensity,
    patchDensity * near + roadDensity,
    patchDensity + roadDensity
  );
  stopDensity = clamp(stopDensity * fade, 0.0, 1.0);

  // Bottom, then middle, then top: the later stop wins the pixel OUTRIGHT rather than
  // blending, because two painted marks overlapping do not average — one is over the other.
  if (stopDensity.x > 0.001) {
    vec2 r = glintLayer(worldXZ, facing, crest, lod, uGlintLayerCell.x,
      uGlintCoverage * uGlintLayerShare.x, uGlintLayerAspect.x,
      uGlintLayerFacing.x, uGlintLayerCrest.x, stopDensity.x, speckle, 0.0, uGlintDrift);
    if (r.x > 0.0) {
      color = glintStop(water, uGlintLift.x, uGlintSat.x, uGlintLiftVar.x, r.y);
      mask = 1.0;
    }
  }
  if (stopDensity.y > 0.001) {
    vec2 r = glintLayer(worldXZ, facing, crest, lod, uGlintLayerCell.y,
      uGlintCoverage * uGlintLayerShare.y, uGlintLayerAspect.y,
      uGlintLayerFacing.y, uGlintLayerCrest.y, stopDensity.y, speckle, 137.4, uGlintDrift);
    if (r.x > 0.0) {
      color = glintStop(water, uGlintLift.y, uGlintSat.y, uGlintLiftVar.y, r.y);
      mask = 1.0;
    }
  }
  if (stopDensity.z > 0.001) {
    vec2 r = glintLayer(worldXZ, facing, crest, lod, uGlintLayerCell.z,
      uGlintCoverage * uGlintLayerShare.z, uGlintLayerAspect.z,
      uGlintLayerFacing.z, uGlintLayerCrest.z, stopDensity.z, speckle, 311.9, uGlintDrift);
    if (r.x > 0.0) {
      color = glintStop(water, uGlintLift.z, uGlintSat.z, uGlintLiftVar.z, r.y);
      mask = 1.0;
    }
  }

  // ---- 3. WAVE TIPS, over the whole sea, drawn last --------------------------------------
  // ITS OWN LATTICE, and it has to be: this one rides at the crest speed while everything
  // above it slides at 0.6 m/s, and one lattice cannot travel at two speeds. Drawn last
  // because it is the brightest thing on the water — light on the very top of a wave sits over
  // whatever the patches put underneath it. The crest gate is hard 1.0 here rather than the
  // top stop's authored pull: being ON the tip is the whole of what this behaviour is.
  float tipDensity = clamp(GLINT_DENSITY * uGlintBehaviour.z * on.z * fade, 0.0, 1.0);
  if (tipDensity > 0.001) {
    vec2 r = glintLayer(worldXZ, facing, crest, lod, uGlintLayerCell.z,
      uGlintCoverage * uGlintLayerShare.z, uGlintLayerAspect.z,
      uGlintLayerFacing.z, 1.0, tipDensity, speckle, 523.1, uGlintCrestSpeed);
    if (r.x > 0.0) {
      color = glintStop(water, uGlintLift.z, uGlintSat.z, uGlintLiftVar.z, r.y);
      mask = 1.0;
    }
  }

  return vec4(color, mask);
}
