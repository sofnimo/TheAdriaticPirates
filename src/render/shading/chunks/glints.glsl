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
// THE MARKS LIE ALONG THE CRESTS. `uSwellDir` is the bearing the swell comes from. A crest is
// a line of constant phase, so it runs at right angles to it, and the marks are laid out
// along it. The rotation is DERIVED here rather than authored, so turning the swell heading
// turns every mark with it and the two cannot drift out of step.
//
// PUDDLE SHAPES, NOT ELLIPSES. A clean ellipse reads as one stamp repeated once there are
// thousands on screen. Each mark's outline is pushed in and out by a pair of sinusoids in its
// own local angle, at its own phase, so the silhouette is a warped, elongated blob — closer
// to a puddle than to a lozenge — and no two are quite the same shape.
//
// A MARK'S SIZE DEPENDS ON NOTHING BUT THE WORLD. Not on distance from the camera, not on the
// camera's height, not on anything the viewer does. Marks are metres of sea, and perspective
// shrinks them with range exactly as it shrinks everything else in the frame.
//
// The rule earns its own paragraph because it has been broken twice, in both available ways,
// each time in pursuit of holding marks at a constant apparent size out to the horizon. Scaling
// by view DISTANCE is the destructive one: that factor is constant on circles around the eye
// and varies along every view ray, so it stretched cells radially and bent the lattice into
// arcs centred on the viewer — a cartwheel of streaks that turned as the camera turned. Scaling
// by ALTITUDE has no direction to radiate along and so looks fine, but it means glints grow as
// you climb, which no sea does.
//
// `uGlintLod` survives as a global size multiplier, but nothing drives it per frame; it is a
// constant unless a human moves it. The consequence is deliberate: the field thins with height
// and is effectively gone from high altitude, which is what the reference frames show.
//
// THREE BEHAVIOURS, ALL THREE AT ONCE, ALL THREE OVER THE WHOLE OCEAN. They are three
// different phenomena, not three tunings of one and NOT a choice of one — a real sea carries
// all of them simultaneously, and each covers the entire surface. Only their DENSITY varies
// from place to place, and only one of them is shaped like a triangle:
//
//   PATCHES     Cat's-paws of wind touching down: discrete CLUSTERS of a countable number of
//               marks, grouped but dispersed, with bare water between them. Not a noise field
//               — see glintPatches for why that had to change and how the spacing is
//               guaranteed. FIXED IN PLACE: a patch is pinned to its piece of sea and does not
//               drift, which makes the whole construction a pure function of world position.
//               This is the one behaviour graded by proximity: close in, a cluster is drawn
//               from all three stops; past `uGlintNearLayers` (~50 m) its members are all top
//               stop, because that is all that resolves at range.
//
//   SUN PATH    The glitter road: a wedge anchored AT THE CAMERA and pointed along the sun's
//               bearing, a point at your feet widening as it runs out — the upside-down
//               triangle you actually see on water, with sides that wander rather than rule.
//               It opens further as the sun drops, because a low sun catches a far wider
//               spread of wave faces on the way to the eye: a tight pool at noon, a road to
//               the horizon at sunset. The wedge ADDS marks on open water, it does not confine
//               them. TOP STOP ONLY, and drawn large: every mark in a glitter path is the sun
//               coming back at you, so they are all highlights and none of them are texture.
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
uniform vec3 uGlintBehaviour;   // weight of (patches, sun path, wave tips)
uniform float uGlintFade;       // master multiplier, 1 = on
uniform float uGlintDrift;      // metres/second the ROAD lattice rides WITH the crests
uniform float uGlintCrestSpeed; // metres/second the crests travel — the wave tips ride this

uniform float uGlintCoverage;   // fraction of open water carrying a mark, all stops together
uniform float uGlintCellMetres; // across-crest world size of one cell / one mark's short axis
uniform float uGlintAspect;     // world long:short of a mark, before per-stop and per-mark
uniform float uGlintLod;        // global mark SIZE. Count is compensated — see lodCount below.
uniform float uGlintWobble;     // 0 = clean ellipse, 1 = strongly puddled outline
uniform float uGlintSpeckle;    // base twinkle for the patches
uniform float uGlintRoadSpeckle; // twinkle for the sun path — 0 keeps the road perfectly still
uniform float uGlintTipSpeckle; // base twinkle for the wave tips, which want their own amount
uniform float uGlintTipCrestBias; // how hard tip marks crowd toward the peak, 1 = not at all
uniform float uGlintTipCrestNorm; // solved on the CPU so that bias redistributes, never culls

// Per stop, ordered (bottom, middle, top).
uniform vec3 uGlintLayerShare;  // share of marks. The top stop is the most prevalent.
uniform vec3 uGlintLayerCell;   // cell/mark-size multiplier: bigger = fewer, larger marks
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
uniform float uGlintRoadScale;   // road mark size multiplier — count is held, see roadScaleCount
uniform float uGlintPathWaviness;  // 0 = ruled straight sides, 1 = the edge wanders wildly
uniform float uGlintPathWaveScale; // metres — length of one undulation along the edge

// The patches.
uniform float uGlintPatchCell;    // metres — one patch SLOT. Sets the minimum gap, see below.
uniform float uGlintPatchJitter;  // 0..1 of a slot. Minimum gap is uGlintPatchCell * (1 - this)
uniform float uGlintPatchChance;  // fraction of slots carrying a patch at all — "sparingly"
uniform float uGlintPatchRadius;  // metres a cluster's members disperse from its centre
uniform float uGlintPatchStretch; // cluster elongation along the crest line
uniform vec4 uGlintPatchCounts;   // the four allowed member counts, one picked per patch
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
 * The sea state whose `glintCoverage` the patch chance was authored against.
 *
 * A cluster's population is COUNTED now rather than solved from a coverage figure, so the sea
 * state would otherwise stop reaching the patches at all — flat water and a gale would carry
 * the same number of cat's-paws. Scaling the chance by the state's coverage against this
 * reference puts that back: the count per patch is fixed, how OFTEN a patch occurs is not.
 */
const float GLINT_COVERAGE_REF = 0.16;

/** Distance in the swell frame from a point to the crest-aligned axes. */
vec2 glintCrestLocal(vec2 v, vec2 d, vec2 crestAxis) {
  return vec2(dot(v, crestAxis), dot(v, d));
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
 * Is this pixel inside one mark? `local` is (along crest, across crest) in metres from the
 * mark's centre, `semi` its two semi-axes, `seed` its own hash.
 *
 * THE PUDDLE. Two sinusoids in the mark's own local angle, at its own phase, pushing the
 * outline in and out: the 2-lobe term flattens one pair of sides and swells the other, the
 * 3-lobe term stops the result being symmetric. It is applied in the NORMALISED space, where
 * the mark is round, so the warp lengthens with the mark rather than sitting on it as separate
 * decoration. The epsilon keeps atan off (0,0), which is undefined and would put a NaN through
 * the compare at the exact centre of every mark.
 */
bool glintMarkHit(vec2 local, vec2 semi, float seed) {
  vec2 q = local / max(semi, vec2(1e-4));
  float qd = length(q);
  // Cheap reject before the trig: the warp cannot push the outline past this.
  if (qd > 1.0 + uGlintWobble * (GLINT_WOBBLE_A + GLINT_WOBBLE_B)) return false;
  float ang = atan(q.y, q.x + 1e-6);
  float ph = hash11(seed) * GLINT_TAU;
  float warp = 1.0 + uGlintWobble *
    (GLINT_WOBBLE_A * sin(2.0 * ang + ph) + GLINT_WOBBLE_B * sin(3.0 * ang - 1.7 * ph));
  return qd <= max(warp, 0.05);
}

/**
 * Does a mark with this hash survive the speckle this instant?
 *
 * `rateScale` is how fast THIS behaviour twinkles against the master rate. It exists because
 * the wave tips are already moving: those marks travel with the crests at 16 m/s, and
 * flickering them as fast as marks sitting still on the water reads as a buzz rather than as
 * light catching a tip. Slowing their twinkle lets the motion be the thing you see.
 */
bool glintSpeckleLit(float seed, float speckle) {
  if (speckle <= 0.0) return true;
  // Which marks take part at all: a per-mark draw, so the amount is an AMOUNT.
  if (hash11(seed + 617.0) > speckle) return true;
  float tw = 0.5 + 0.5 * sin(uWaveTime * uGlintFlickerRate + hash11(seed) * GLINT_TAU);
  return tw >= 0.38;
}

// =====================================================================
// THE PATCHES — countable clusters, not a noise field.
//
// This was an fBM gate: a smooth blob of "more marks here" laid over a uniform lattice. It
// could not express any of what a patch actually is. A noise threshold has no members to
// count, no centre, and above all no minimum separation — two patches can touch, merge, or
// grow into one continent of sparkle, because nothing in the construction knows that a patch
// is a THING rather than a region. So a cluster is now built explicitly:
//
//   THE SLOT LATTICE guarantees the gap. The sea is divided into square slots of
//   `uGlintPatchCell` metres; each slot may hold at most one patch, whose centre is jittered
//   within the middle `uGlintPatchJitter` of the slot. Two centres in neighbouring slots are
//   therefore never closer than cell * (1 - jitter) — 60 m slots with 0.5 jitter give a
//   guaranteed 30 m between patch centres, and diagonal neighbours are further still. It is a
//   property of the construction rather than a rejection test, so it cannot fail.
//
//   `uGlintPatchChance` is the sparingly. Most slots are empty water.
//
//   THE MEMBERS ARE COUNTED. Each patch picks one of the four populations in
//   `uGlintPatchCounts` and scatters exactly that many marks in a disc around its centre,
//   stretched along the crest line — grouped, but dispersed, and every mark placed
//   individually rather than carved out of a threshold.
// =====================================================================

/**
 * @param worldXZ  surface position
 * @param facing   0..1 sun-facing term
 * @param crest    0..1, 1 at the top of a wave
 * @param water    shaded water colour under this pixel, linear
 * @param speckle  0..1 twinkle amount
 * @param weight   overall strength — behaviour weight * solo * depth fade
 * @return         rgb, a = 0/1 coverage mask
 */
vec4 glintPatches(
  vec2 worldXZ, float facing, float crest, vec3 water, float speckle, float weight
) {
  if (weight <= 0.001) return vec4(water, 0.0);

  vec2 d = normalize(uSwellDir);
  vec2 crestAxis = vec2(-d.y, d.x);
  // PATCHES ARE FIXED IN PLACE. `worldXZ` goes in raw: no drift term, no `uWaveTime` anywhere
  // in the placement, so a cluster is pinned to its piece of sea and stays there. Everything
  // downstream is derived from the slot's integer coordinates, which means the whole
  // construction is a pure function of world position — the same patch, in the same spot, with
  // the same members, on every frame and from every camera.
  //
  // The other two behaviours do travel: the road slides at `uGlintDrift` and the wave tips ride
  // the crests at 16 m/s. This one deliberately does not, and it is the reason `uGlintDrift`
  // is no longer read in this function.
  //
  // Note what is still alive inside a fixed patch. Its members speckle, and the sun-facing and
  // crest gates blink them in and out as the swell rolls underneath — so the cluster shimmers
  // where it sits rather than sitting there frozen. What does not happen is drift.
  vec2 p = worldXZ;

  float slot = max(uGlintPatchCell, 1.0);
  // Sea state reaches the patches through how OFTEN one occurs, never through how many marks
  // it holds — that figure is authored.
  float chance = clamp(uGlintPatchChance * weight * uGlintCoverage / GLINT_COVERAGE_REF, 0.0, 1.0);
  float jitter = clamp(uGlintPatchJitter, 0.0, 1.0);
  float reach = uGlintPatchRadius * max(uGlintPatchStretch, 1.0)
    + uGlintCellMetres * uGlintLod * uGlintAspect * GLINT_SIZE_MAX;

  vec3 color = water;
  float mask = 0.0;
  float bestStop = -1.0;

  vec2 slotBase = floor(p / slot);

  // 3x3 over the slot lattice: a patch centred in a neighbouring slot can still reach in here.
  for (int sy = -1; sy <= 1; sy++) {
    for (int sx = -1; sx <= 1; sx++) {
      vec2 cell = slotBase + vec2(float(sx), float(sy));
      if (hash12(cell + 3.31) > chance) continue;

      // Jitter confined to the middle of the slot — this is what makes the gap a guarantee.
      vec2 centre = (cell + 0.5 + (hash22(cell + 8.87) - 0.5) * jitter) * slot;
      vec2 rel = p - centre;

      // The cluster is an ellipse lying along the crest, like the marks inside it.
      vec2 cl = glintCrestLocal(rel, d, crestAxis);
      vec2 clNorm = vec2(cl.x / max(uGlintPatchStretch, 0.01), cl.y);
      if (dot(clNorm, clNorm) > reach * reach) continue;

      // How far the PATCH is from the eye, not this pixel — so a cluster grades as one thing
      // instead of changing character across its own width.
      float patchDist = distance(centre, cameraPosition.xz);
      float near = 1.0 - smoothstep(uGlintNearLayers * 0.6, uGlintNearLayers, patchDist);

      // One of the four authored populations.
      float pick = hash12(cell + 21.7);
      float count = pick < 0.25 ? uGlintPatchCounts.x
        : pick < 0.5 ? uGlintPatchCounts.y
        : pick < 0.75 ? uGlintPatchCounts.z
        : uGlintPatchCounts.w;

      for (int i = 0; i < 15; i++) {
        if (float(i) >= count) break;
        float member = float(i);
        float seed = dot(cell, vec2(37.1, 91.7)) + member * 13.77;

        // Where in the cluster. sqrt() spreads the members evenly over the disc instead of
        // piling them at the centre, which is the difference between a group and a blob.
        vec2 h = hash22(cell + member * 13.7 + 41.0);
        float ang = h.x * GLINT_TAU;
        float rad = sqrt(h.y) * uGlintPatchRadius;
        vec2 offset = crestAxis * (cos(ang) * rad * uGlintPatchStretch) + d * (sin(ang) * rad);
        vec2 local = glintCrestLocal(rel - offset, d, crestAxis);

        // Which stop this member is drawn from. Beyond `uGlintNearLayers` every member is the
        // top stop — the cluster keeps its population, it just stops being a three-tone thing,
        // because a few percent of lightness is the first thing distance takes away.
        float stopPick = hash11(seed + 5.0);
        float stopF = 2.0;
        if (hash11(seed + 71.0) < near) {
          float total = max(uGlintLayerShare.x + uGlintLayerShare.y + uGlintLayerShare.z, 1e-4);
          if (stopPick < uGlintLayerShare.x / total) stopF = 0.0;
          else if (stopPick < (uGlintLayerShare.x + uGlintLayerShare.y) / total) stopF = 1.0;
        }

        float cellMul, aspectMul, facingFloor, crestGate, lift, sat, liftVar;
        if (stopF < 0.5) {
          cellMul = uGlintLayerCell.x; aspectMul = uGlintLayerAspect.x;
          facingFloor = uGlintLayerFacing.x; crestGate = uGlintLayerCrest.x;
          lift = uGlintLift.x; sat = uGlintSat.x; liftVar = uGlintLiftVar.x;
        } else if (stopF < 1.5) {
          cellMul = uGlintLayerCell.y; aspectMul = uGlintLayerAspect.y;
          facingFloor = uGlintLayerFacing.y; crestGate = uGlintLayerCrest.y;
          lift = uGlintLift.y; sat = uGlintSat.y; liftVar = uGlintLiftVar.y;
        } else {
          cellMul = uGlintLayerCell.z; aspectMul = uGlintLayerAspect.z;
          facingFloor = uGlintLayerFacing.z; crestGate = uGlintLayerCrest.z;
          lift = uGlintLift.z; sat = uGlintSat.z; liftVar = uGlintLiftVar.z;
        }

        // The sun-facing and crest gates decide whether a member is THERE, never how big it
        // is — a mark that swelled and shrank with the wave under it would make the whole
        // cluster breathe.
        float gate = mix(facing, 1.0, facingFloor) * mix(1.0, crest, crestGate);
        if (hash11(seed + 133.0) > gate) continue;
        if (!glintSpeckleLit(seed + 211.0, speckle)) continue;

        float sizeRand = hash11(seed + 29.3);
        float aspectRand = hash11(seed + 53.9);
        float stretch = mix(0.7, 1.9, aspectRand * aspectRand);
        float shortSemi = 0.5 * uGlintCellMetres * cellMul * uGlintLod
          * mix(GLINT_SIZE_MIN, GLINT_SIZE_MAX, sizeRand);
        vec2 semi = vec2(shortSemi * uGlintAspect * aspectMul * stretch, shortSemi);

        if (!glintMarkHit(local, semi, seed + 303.0)) continue;

        // The later stop wins the pixel OUTRIGHT rather than blending, because two painted
        // marks overlapping do not average — one is over the other.
        if (stopF >= bestStop) {
          bestStop = stopF;
          color = glintStop(water, lift, sat, liftVar, hash11(seed + 43.7));
          mask = 1.0;
        }
      }
    }
  }

  return vec4(color, mask);
}

// =====================================================================
// THE LATTICE — what the glitter road and the wave tips are drawn on.
//
// A scatter with one mark per cell, solved against a coverage figure. Unlike the patches these
// two are continuous fields with no notion of a cluster: the road is "more marks over here"
// and the tips are "a mark wherever a crest is", and both want an even scatter underneath.
// =====================================================================

/**
 * World XZ -> crest-local cell space.
 *
 * The cell is RECTANGULAR in world space — long along the crest, short across it — and square
 * in the space this returns, so a round threshold in cell space comes back as a lozenge lying
 * along the crest, tapered ends included, with no shape code at all.
 */
vec2 glintCellUV(vec2 worldXZ, float cellMetres, float aspect, float salt, float drift) {
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
  // WITH the waves.
  float acrossCrest = dot(worldXZ, d) + uWaveTime * drift;
  float shortAxis = max(cellMetres * uGlintLod, 0.001);
  // `salt` puts each stop on its own lattice. Without it they share cell boundaries and stack
  // into obvious clusters instead of overlapping at random.
  return vec2(alongCrest / (shortAxis * max(aspect, 0.001)), acrossCrest / shortAxis) + salt;
}

/**
 * One stop's coverage on the lattice, as (mask, per-mark random).
 *
 * The random returned is the winning MARK's own hash, not the pixel's. It drives the
 * lightness spread, and taken per pixel it would dapple each mark inside its own outline.
 */
vec2 glintLayer(
  vec2 worldXZ, float facing, float crest,
  float cellMul, float coverage, float aspectMul,
  float facingFloor, float crestGate, float density, float speckle,
  float salt, float drift
) {
  vec2 uv = glintCellUV(worldXZ, uGlintCellMetres * cellMul, uGlintAspect * aspectMul, salt, drift);

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
      // Neither gate touches the mark's SIZE — that would make the field breathe with the
      // swell. What they do give is trimming: a mark straddling the edge of a crest band is
      // cut off along it, which is what light does at the top of a wave.
      if (hash12(cell) > density * gate) continue;
      if (!glintSpeckleLit(dot(cell, vec2(37.1, 91.7)) + 3.7, speckle)) continue;

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

      if (!glintMarkHit(delta, vec2(radius), dot(cell, vec2(11.3, 47.9)) + 91.1)) continue;

      mask = 1.0;
      // Its own hash: deriving brightness from sizeRand correlates the two, so every pale
      // mark would also be the largest — a tell the reference frames do not have.
      brightRand = hash12(cell + 43.7);
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
 *
 * This is the ONE place a camera-relative term belongs, because the glitter path genuinely is
 * a property of where you stand. Nothing else in the file may depend on the view.
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

  // WAVY SIDES. A wedge with two ruled edges reads as a cone of light — a stencil laid over
  // the sea — because nothing on water has a straight edge. The half-angle is therefore
  // perturbed, so the boundary wanders in and out around the triangle it is still fundamentally
  // built from: a shape you would call a triangle, but not one you could draw with a ruler.
  //
  // SAMPLED IN WORLD SPACE, and that choice does two things at once.
  //
  // It decorrelates the two sides for free. Sampling on the ANGLE instead would give both
  // edges the same value at the same distance, so they would bulge and pinch in step and the
  // road would pulse in width rather than waver. The left and right edges are at different
  // world positions, so they read different noise, and each wanders on its own.
  //
  // And it keeps the edge still, in the sense that everything else here is still: the wobble
  // belongs to the water, not to the viewer. Anchored to the road's own frame it would slide
  // along with the camera and the edges would writhe as you flew — motion generated by the
  // observer, which is the same mistake the radial LOD term was making.
  //
  // The mean of the noise is ~0.5, so the perturbation averages to zero and the road's mean
  // width is unchanged: this reshapes the edge without widening or narrowing the wedge.
  float wobble = fbm2(worldXZ / max(uGlintPathWaveScale, 1.0)) * 2.0 - 1.0;
  halfAngle *= 1.0 + wobble * uGlintPathWaviness;

  return 1.0 - smoothstep(halfAngle * (1.0 - uGlintPathSoft), max(halfAngle, 1e-4), ang);
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
 * @param crest    0..1, 1 at the top of a wave — the full four-wave sum
 * @param crestRide 0..1 on the DOMINANT wave alone. What the travelling marks gate on, so that
 *                 riding at that wave's speed holds a mark's gate exactly constant.
 * @param water    the shaded water colour under this pixel, linear — every stop derives from it
 * @param depth01  sea depth, keeps sparkle off shallows
 * @param exposure 0..1 fetch-field exposure: 0 is the deepest lee, 1 is open sea. Thins the
 *                 field by COUNT, never by colour — a mark in the lee is a full-strength mark.
 * @param viewDist metres from the eye
 * @return         rgb glint colour, a = 0/1 coverage mask
 */
vec4 glintField(
  vec2 worldXZ, vec3 sunDir, float facing, float crest, float crestRide,
  vec3 water, float depth01, float exposure, float viewDist
) {
  // Sparkle belongs to open water, and two things say so: depth, and the fetch field's
  // exposure. Both are folded in HERE, into a term that every behaviour multiplies into its
  // DENSITY — so sheltered or shallow water carries fewer marks, and each mark it does carry
  // is drawn at its own full colour.
  //
  // The exposure used to be applied by the caller as `mix(water, glint, mask * exposure)`,
  // which is a different thing wearing the same clothes: at half exposure it drew every mark
  // halfway between its colour and the water, so a top-stop highlight in the lee came out as a
  // pale smudge instead of a highlight. Marks do not have a partial colour. They are hard
  // edges — present at full strength or absent — and everything that varies their prevalence
  // does it by count.
  float fade = uGlintFade * smoothstep(uGlintDepthFade.x, uGlintDepthFade.y, depth01)
    * clamp(exposure, 0.0, 1.0);
  if (fade <= 0.001) return vec4(0.0);

  vec3 on = glintSoloMask();

  // SPECKLE, and it is worth being clear that this is not the same thing as the flicker the
  // wave tips had. That was STRUCTURAL: marks switching on and off because the gate deciding
  // whether they existed kept moving underneath them, which is noise and is now gone for good
  // (see the tips below). This is DELIBERATE: a chosen fraction of marks winking, because
  // light on water does wink. One is a defect, the other is the effect.
  //
  // The far term is a property of DISTANCE rather than of any behaviour — past ~100 m a mark
  // is small enough that the face carrying it turns in and out of the light between frames —
  // so it applies to all three. The near term is per behaviour, because the tips want a
  // different amount from marks that are sitting still.
  float farSpeckle =
    smoothstep(uGlintFlickerFrom, uGlintFlickerFrom + 60.0, viewDist) * uGlintFlickerDepth;
  float patchSpeckle = max(uGlintSpeckle, farSpeckle);
  float tipSpeckle = max(uGlintTipSpeckle, farSpeckle);
  // THE ROAD IS STILL, and it opts out of the distance term as well as the base one. Not an
  // oversight: the glitter road runs from your feet to the horizon, so nearly all of it lies
  // past the ~100 m where the far speckle starts, and leaving it in would mean the road was
  // the one behaviour that twinkled almost everywhere. Its marks are pinned to the water by
  // `uGlintDrift = 0` and lit steadily; `uGlintRoadSpeckle` is the way back if some shimmer
  // is wanted out at range.
  float roadSpeckle = uGlintRoadSpeckle;

  vec3 color = water;
  float mask = 0.0;

  // ---- 1. PATCHES, over the whole sea ----------------------------------------------------
  vec4 patches = glintPatches(worldXZ, facing, crest, water, patchSpeckle, uGlintBehaviour.x * on.x * fade);
  if (patches.a > 0.0) {
    color = patches.rgb;
    mask = 1.0;
  }

  // MARK SIZE MUST NOT CHANGE THE MARK COUNT, and on the lattice it otherwise would.
  //
  // `uGlintLod` scales a CELL, and a mark's radius is measured in cell units — so growing it
  // grows the marks and spreads the lattice by the same factor at once. Coverage comes out
  // unchanged, which sounds harmless and is not what anyone means by "make the glints bigger":
  // doubling the size would quarter the number of marks per square metre and thin the sea out
  // just as the marks got fatter. Cells per unit area go as 1/lod^2, so marks per cell are
  // multiplied by lod^2 to cancel it exactly. Coverage then rises as lod^2, which is the
  // honest arithmetic of the same marks at four times the area.
  //
  // The patches need none of this: their slot lattice is in metres and never saw `uGlintLod`,
  // so a cluster keeps its authored 3, 5, 10 or 15 members whatever size they are drawn at.
  float lodCount = uGlintLod * uGlintLod;

  // ---- 2. THE GLITTER ROAD, laid over that same water ------------------------------------
  // Density ADDED inside the wedge, never a gate on everything outside it. Off the road this
  // is simply zero and the patches carry the sea on their own.
  //
  // TOP STOP ONLY. The road used to draw all three, bottom then middle then top, on three
  // salted lattices. It draws one now: the glitter path is the sun coming back at you off a
  // wave face, so every mark in it is a highlight, and the darker two stops were describing
  // texture the road does not have. This is the same shape the wave tips already take, and it
  // leaves the patches as the only behaviour carrying the full three-stop ladder — which is
  // where the ladder was always doing its work, close in on open water.
  //
  // `uGlintRoadScale` then makes those marks bigger, and the square of it goes into the
  // density for the reason `lodCount` exists a few lines up: a cell carries one mark, so
  // scaling the cell to grow the mark also spreads the lattice and would thin the road by the
  // square of the scale. At 3x that is nine times fewer marks — the road would nearly empty
  // just as its marks got fat. Multiplying the density back by the same square holds marks per
  // square metre where it was, so the control does what it says and only changes size.
  float roadScaleCount = uGlintRoadScale * uGlintRoadScale;
  float roadDensity = clamp(
    GLINT_DENSITY * lodCount * roadScaleCount * uGlintBehaviour.y * on.y * fade
      * sunPathGate(worldXZ, sunDir),
    0.0, 1.0
  );
  if (roadDensity > 0.001) {
    vec2 rt = glintLayer(worldXZ, facing, crest, uGlintLayerCell.z * uGlintRoadScale,
      uGlintCoverage * uGlintLayerShare.z, uGlintLayerAspect.z,
      uGlintLayerFacing.z, uGlintLayerCrest.z, roadDensity, roadSpeckle, 311.9, uGlintDrift);
    if (rt.x > 0.0) {
      color = glintStop(water, uGlintLift.z, uGlintSat.z, uGlintLiftVar.z, rt.y);
      mask = 1.0;
    }
  }

  // ---- 3. WAVE TIPS, over the whole sea, drawn last --------------------------------------
  // ITS OWN LATTICE, and it has to be: this one rides at the crest speed while everything
  // above it slides at 0.6 m/s, and one lattice cannot travel at two speeds. Drawn last
  // because it is the brightest thing on the water — light on the very top of a wave sits over
  // whatever the patches put underneath it. The crest gate is hard 1.0 here rather than the
  // top stop's authored pull: being ON the tip is the whole of what this behaviour is.
  // THESE MARKS DO NOT FLICKER. Everything that could switch one on and off between frames is
  // deliberately taken out, because this is the one behaviour whose whole point is that it
  // MOVES — and a travelling mark that also blinks reads as noise rather than as motion:
  //
  //   `crestRide` instead of `crest`  the four-wave sum has no single velocity, so a mark
  //                                   riding wave 1 kept being swept over by waves 2-4 and
  //                                   blinking as they passed. On wave 1's phase alone a mark
  //                                   travelling at wave 1's speed holds an EXACTLY constant
  //                                   gate: the lattice moves it by -c*t, the phase term
  //                                   advances by +omega*t, and with c = omega/k the two
  //                                   cancel. Not approximately steady — algebraically steady.
  //   facing floor 1.0                the sun term no longer decides existence. It is computed
  //                                   from the wave normal, which is the four-wave sum again,
  //                                   so it flickered for the same reason one layer down.
  //
  // What is left is a mark that appears where a crest is and travels with it. `uGlintTipSpeckle`
  // then puts a twinkle back on top, and the difference matters: that is a chosen fraction of
  // marks winking at a chosen rate, not a mark being strobed by a gate it happens to be
  // sliding through. The structural flicker is gone; the effect is a dial.
  //
  // DENSITY CLIMBS TO THE TIP, and the count does not change. `crestRide` arrives raw, so
  // (0.5 + 0.5*phase) runs 0 in the trough to exactly 1 at the peak, and the power concentrates
  // marks up the wave face — at bias 4, 88% of them land in the top quarter, and, unlike the
  // smoothstep this replaced, they keep getting denser all the way up instead of levelling off
  // over the top 30% of the wave.
  //
  // `uGlintTipCrestNorm` is what keeps that a REDISTRIBUTION rather than a cull. Biasing the
  // gate lowers its mean, which would quietly delete marks — at bias 4 the mean falls from
  // 0.392 to 0.273, losing 30% of them. The norm is solved on the CPU as the ratio of the two
  // (see tipCrestNorm in Ocean.ts) so the expected count per cell comes out exactly where it
  // was. The marks move up the wave; none of them go missing, and none of them change size.
  float tipRamp = pow(clamp(0.5 + 0.5 * crestRide, 0.0, 1.0), uGlintTipCrestBias)
    * uGlintTipCrestNorm;
  float tipDensity = clamp(GLINT_DENSITY * lodCount * uGlintBehaviour.z * on.z * fade, 0.0, 1.0);
  if (tipDensity > 0.001) {
    vec2 r = glintLayer(worldXZ, facing, tipRamp, uGlintLayerCell.z,
      uGlintCoverage * uGlintLayerShare.z, uGlintLayerAspect.z,
      1.0, 1.0, tipDensity, tipSpeckle, 523.1, uGlintCrestSpeed);
    if (r.x > 0.0) {
      color = glintStop(water, uGlintLift.z, uGlintSat.z, uGlintLiftVar.z, r.y);
      mask = 1.0;
    }
  }

  return vec4(color, mask);
}
