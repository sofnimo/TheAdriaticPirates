import * as THREE from 'three';
import { COAST, SEA } from '../../art/palette';
import { GLINT_RULE, GLINT_SOLO } from '../../art/seaRamp';
import { SURFACES } from '../../art/surfaces';
import { DEFAULT_SEA_STATE, SEA_STATES, waveDirection, type SeaStateName } from '../../art/seaStates';
import { OCEAN } from '../../art/budgets';
import { globalUniforms, shadowUniforms } from '../../render/shading/ShadingUniforms';
import { DepthField } from '../depth/DepthField';
import { buildOceanRings, DEFAULT_RING_LEVELS, type OceanRings } from './RingMesh';
import { buildSeaRampTexture } from './SeaRampTexture';
import type { ShoreUniforms } from '../shore/shoreUniforms';
import type { ShelterField } from './ShelterField';

import OCEAN_VERT from './ocean.vert.glsl';
import OCEAN_FRAG from './ocean.frag.glsl';

/**
 * THE OPEN SEA — `02 — Water.md`.
 *
 * A custom ShaderMaterial rather than three's `Water`/`Water2` addons: those are built for
 * photoreal specular water and output exactly the Blinn-Phong sheen 00 §3 rule 4 forbids
 * (02 §0). But the SHADING still comes from the shared gouache chunk — the depth ramp picks
 * the base colour, the chunk bands it. No forked ramp.
 *
 * Fragment order: depth -> continuous colour -> gouache ramp -> glints -> sky fresnel -> haze.
 *
 * Note which half is banded. The depth->colour mapping is CONTINUOUS, because the reference
 * frames show a smooth painted gradient wherever depth varies. The stepping lives entirely
 * in the light response, where the gouache ramp puts it.
 */

export interface OceanUniforms {
  [key: string]: THREE.IUniform;
}

/**
 * Phase speed of a deep-water wave, metres per second — how fast its CRESTS travel.
 *
 * The dispersion relation the wave stack already uses: omega = sqrt(g*k) with k = 2*pi/L, so
 * the crest speed omega/k is sqrt(g*L/2*pi). It comes out at 16.3 m/s for the default swell's
 * 170 m wavelength, which is the figure the wave-tip glints have to match to ride along
 * instead of blinking on and off underneath the crests.
 *
 * Deliberately NOT a second copy of the constant: `dominantWavePeriod` below solves the same
 * relation for the period, and gerstner.glsl for the phase. Same g, same k, three uses.
 */
function crestSpeed(wavelengthMetres: number): number {
  return Math.sqrt((9.8 * Math.max(wavelengthMetres, 0.001)) / (Math.PI * 2));
}

/**
 * Mean of the wave-tip gate BEFORE the crest bias was introduced, over one wave.
 *
 * The tips used to gate on `smoothstep(-0.1, 0.75, sin(phase))`, whose mean over a uniform
 * phase is this. It is the count the field is held to: "keep the current amount of glints"
 * means keep this number, whatever shape the marks are then arranged in.
 */
const TIP_GATE_MEAN = 0.3922;

/**
 * Normaliser that turns the tip crest bias into a REDISTRIBUTION rather than a cull.
 *
 * The bias crowds marks toward the peak by raising the gate to a power, and any power above 1
 * lowers the gate's mean — which does not merely rearrange the marks, it deletes them. At bias
 * 4 the mean falls from 0.392 to 0.273 and 30% of the field quietly disappears, which would
 * look exactly like "the bias also thinned it" and would be almost impossible to tell apart
 * from a tuning problem by eye.
 *
 * So the mean is measured and divided back out. E[(0.5 + 0.5*sin)^bias] has a closed form for
 * integer powers, but the slider is continuous, so it is integrated instead — 4096 samples of
 * one period, which is exact to well past the precision a float uniform carries, and it runs
 * once when the value changes rather than per frame.
 */
export function tipCrestNorm(bias: number): number {
  const samples = 4096;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const phase = ((i + 0.5) / samples) * Math.PI * 2;
    sum += Math.pow(0.5 + 0.5 * Math.sin(phase), Math.max(bias, 0));
  }
  return TIP_GATE_MEAN / Math.max(sum / samples, 1e-4);
}

export class Ocean {
  readonly material: THREE.ShaderMaterial;
  readonly rings: OceanRings;
  readonly depthField: DepthField;
  readonly uniforms: OceanUniforms;
  /** The sampled depth LUT, baked from art/seaRamp.ts. Owned here; released by dispose(). */
  readonly rampTexture: THREE.DataTexture;
  private seaState: SeaStateName;
  /** Degrees the whole wave stack is rotated off its authored bearing. See waveHeadingDeg. */
  private headingOffset = 0;

  constructor(
    scene: THREE.Scene,
    depthField: DepthField,
    seaState: SeaStateName = DEFAULT_SEA_STATE,
    shore?: ShoreUniforms,
  ) {
    this.depthField = depthField;
    this.seaState = seaState;
    this.rampTexture = buildSeaRampTexture();

    const surface = SURFACES.openSea;

    this.uniforms = {
      // --- surface uniforms for the shared gouache chunk (04 §2.3 openSea row) ---
      uRampSteps: { value: surface.rampSteps },
      uShadowTint: { value: new THREE.Color(surface.shadowTint) },
      uShadowTintMix: { value: surface.shadowTintMix },
      uRimColor: { value: new THREE.Color(surface.rimColor) },
      uRimPower: { value: surface.rimPower },
      uRimStrength: { value: surface.rimStrength },

      // --- waves ---
      uWaves: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uSteepness: { value: [0, 0, 0, 0] },
      uWaveTime: { value: 0 },
      // Displacement must reach zero BEFORE the first ring boundary (50 m), or the finer
      // ring's displaced vertices leave T-junction cracks against the coarser ring's
      // straight edge — which shows as a bright hairline of sky along the seam. Proper
      // skirts or edge stitching would let this extend further out; the near field is all
      // that needs real displacement anyway (02 §1.1), so that work waits for the
      // landing/taxi camera.
      uDisplaceFadeStart: { value: 25 },
      uDisplaceFadeEnd: { value: 45 },

      // --- shelter (ShelterField) ---
      // Attached by the scene once the islands exist, the same way the shore block is. Until
      // then `uShelterEnable` is 0 and every lookup answers "open sea", so the sea is simply
      // the sea state it was given.
      uShelterMap: { value: null },
      uShelterOrigin: { value: new THREE.Vector2() },
      uShelterSize: { value: 1 },
      /** Amplitude left in the deepest lee. Zero: the calm side is flat, not merely quieter. */
      uShelterMin: { value: 0 },
      uShelterEnable: { value: 0 },

      // --- depth signal (sea_depth.glsl) ---
      uBathymetry: { value: depthField.texture },
      uBathyOrigin: { value: depthField.origin.clone() },
      uBathyScale: { value: depthField.worldSize },

      // --- continuous depth colour (sea_color.glsl) ---
      // A sampled 256-entry LUT, not a set of band hexes. See art/seaRamp.ts for the
      // per-stop citations and for why this stopped being a 5-band quantiser.
      uSeaRamp: { value: this.rampTexture },
      cLagoonEdge: { value: new THREE.Color(COAST.lagoonEdge.hex) },
      cSeaShadow: { value: new THREE.Color(SEA.shadow.hex) },
      uEdgeNoiseScale: { value: 46 },
      uEdgeNoiseAmount: { value: 0.055 },
      // Negative control for the smoothness gate; 0 everywhere except `?bands=N`.
      uBandSabotage: { value: 0 },

      // --- glints (glints.glsl) ---
      // Three stops taken off the water beneath each mark, on independent scatters, lying
      // along the wave crests. THREE BEHAVIOURS RUN AT ONCE over the whole sea — patches, the
      // glitter road, and light on the wave tips; see the chunk's header.
      uSwellDir: { value: new THREE.Vector2(1, 0) },
      // Debug isolation only. `all` is the sea; the other values exist for the probe and for
      // looking at one behaviour without the other two on top of it.
      uGlintSolo: { value: GLINT_SOLO.all },
      // How much sea each behaviour covers, relative to `uGlintCoverage`, as
      // (patches, sun path, wave tips).
      //
      // The patches carry the sea away from the road. The road lays its own marks on top
      // inside the wedge, which is why the glitter path reads as a concentration rather than
      // as the only lit water.
      //
      // (An older note here said the road at 1.0 "doubles the density" inside the wedge. That
      // stopped being true when the patches became discrete clusters: the two no longer share
      // a lattice, so the road's weight is not a multiple of the patches' any more. The three
      // entries in this vector are only loosely comparable now — patches set how often a
      // CLUSTER occurs, the other two set marks per cell on their own lattices.)
      //
      // THE ROAD IS DOWN 96%, 1.0 -> 0.04, in an 80% cut on top of an earlier one. Inside the
      // wedge that is roughly one road mark per 11 m square at the top stop, thinning to
      // nothing at the wavy edges. The wedge is also a quarter of its original width, so the
      // sun path is now a genuinely faint feature — quite possibly below the point where you
      // would notice it at all. `uGlintBehaviour.y` is the one number that brings it back.
      //
      // THE WAVE TIPS ARE A THREE-HUNDRED-AND-TWENTIETH OF WHAT THEY WERE, 0.6 -> 0.001875,
      // in five halvings. They are the one behaviour that draws on every crest across the whole
      // sea, so at any weight comparable to the other two they stop being an accent and become
      // the sea's texture — a bright dashed line along every wave. Down here they are the
      // occasional tip catching the light. The crest gate then thins them again, and the crest
      // bias crowds what survives into the top quarter of the wave.
      //
      // For a sense of scale at this setting: about one tip mark per 2850 square metres of sea,
      // or one per 53 m square, each mark about 1.1 x 3.7 m. Halvings buy less and less now —
      // the spacing has gone 27, 38, 53 m across the last three — so if these still read as too
      // present it is more likely their SIZE than their number. `uGlintLayerCell.z` shrinks the
      // tip marks alone; the global size control would take the other two behaviours with it.
      //
      // Note this is a weight, not a count: `lodCount` in the shader multiplies it by the
      // square of the mark-size control, so at the shipped size of 2 the density actually
      // reaching the lattice is four times this. That is what keeps marks per square metre
      // fixed when the size changes, and it means this number is only comparable against the
      // other two entries here — never read as an absolute.
      uGlintBehaviour: { value: new THREE.Vector3(1.0, 0.04, 0.001875) },
      uGlintCoverage: { value: SEA_STATES[seaState].glintCoverage },
      // Across-crest world size of a cell. image-4's marks work out at 1.2-2.4 m of actual
      // sea, so a cell a little under a metre across carries one at the authored aspect.
      uGlintCellMetres: { value: 0.7 },
      // WORLD long:short, not screen. The figures in art/seaRamp.ts are screen measurements
      // off a low pass, where the short axis runs into the frame and compresses;
      // GLINT_RULE.screenToWorldAspect is the correction and 6.9 * 0.57 is where this comes
      // from. Matching screen-to-screen at comparable framing is the only comparison that
      // means anything.
      uGlintAspect: { value: GLINT_RULE.light.aspect * GLINT_RULE.screenToWorldAspect },
      // ONE global size multiplier for every mark on the sea, and NOTHING DRIVES IT. Not view
      // distance, which bent the lattice into arcs radiating from the camera, and not altitude
      // either — a glint is a patch of water a couple of metres across and it should shrink
      // with height like anything else in the frame. Marks are world-scale; perspective does
      // the rest. See Ocean.update() for the full account of both attempts.
      //
      // Left as a uniform because "how big is a mark" is worth having one knob for, and having
      // it here means the answer is a constant in one place rather than arithmetic spread over
      // a frame callback.
      uGlintLod: { value: 2 },
      // How fast the ROAD lattice rides with the crests — and it is ZERO, so the glitter road
      // is still. Its marks are pinned to the water exactly as the patches are, which leaves
      // the wave tips as the only behaviour that moves at all.
      //
      // Kept as a live uniform rather than deleted along with the code that reads it. The
      // machinery is a few lines in glintCellUV and it is where the sign convention is
      // written down: positive is downwave, which is -uSwellDir, because gerstner phases as
      // `k*dot(d,x) + omega*t` (see `swellTravelDirection` in art/seaStates.ts, and the class
      // of bug it documents). Deleting that would mean rediscovering it to put the drift back.
      uGlintDrift: { value: 0 },
      uGlintCrestSpeed: { value: crestSpeed(SEA_STATES[seaState].waves[0].wavelength) },
      uGlintFade: { value: 1 },
      // How far the outline wanders off a clean ellipse. At 0 the marks are perfect lozenges
      // and, in their thousands, read as one shape stamped over and over; up here they are
      // warped, puddle-shaped blobs, still elongated along the crest.
      uGlintWobble: { value: 0.28 },
      // Base twinkle for the patches and the road, before the distance speckle is added on
      // top. The wave tips are excluded outright — they are the marks that move, and motion
      // plus blinking reads as noise.
      //
      // SHIPPED AT ZERO, AND THE ZERO IS NEW ONLY IN NAME. This sat at 0.12 and did nothing at
      // all: the old test was `mix(1.0, step(...), speckle) >= 0.5`, which with the step at 0
      // is `1 - speckle`, so any value at or under 0.5 could never fail and any value above it
      // blinked every mark in the field. It was a switch at 0.5 wearing the costume of an
      // amount. It now draws per mark — `speckle` is the fraction of marks that twinkle — so
      // the number finally means what it says, and 0 keeps the near field exactly as steady as
      // it has actually been rendering all along. Dial it up for a little life close in.
      uGlintSpeckle: { value: 0 },
      // The wave tips get their own amount, and get it on purpose. Their own, because they are
      // the only marks that are also travelling, so what reads as a lively twinkle on still
      // water can read as a busy one on a mark already crossing the frame — the two want to be
      // tuned apart. On purpose, because these marks USED to flicker for a reason that was not
      // this: the gate deciding whether they existed was the four-wave sum sweeping underneath
      // them, which is noise, and it is now gated on the dominant wave alone and is exactly
      // steady. A quarter of the marks winking is an effect chosen on top of that.
      // The glitter road does not twinkle at all, and it skips the distance speckle too — see
      // the note in glintField. The road reaches the horizon, so almost all of it sits beyond
      // where that term starts, and leaving it in would have made the road the one behaviour
      // shimmering nearly everywhere while the other two sat quiet.
      uGlintRoadSpeckle: { value: 0 },
      uGlintTipSpeckle: { value: 0.25 },
      // How hard tip marks crowd toward the very peak of the wave. 1 is the old even spread
      // across the crest band; 4 puts 88% of them in the top quarter and, unlike the smoothstep
      // this replaced, keeps them getting denser all the way up rather than levelling off over
      // the top 30% of the wave. The norm below holds the COUNT fixed while they move.
      uGlintTipCrestBias: { value: 4 },
      uGlintTipCrestNorm: { value: tipCrestNorm(4) },

      // Per layer, ordered (bottom, middle, top).
      //
      // The top stop is deliberately the most prevalent — it is the highlight, and the two
      // below it exist to give it something to sit against. The bottom stop is the largest
      // and longest and the least fussy about where it appears; the top is the smallest,
      // held hardest to sun-facing water at the tops of waves.
      uGlintLayerShare: { value: new THREE.Vector3(0.18, 0.27, 0.55) },
      uGlintLayerCell: { value: new THREE.Vector3(1.35, 1.0, 0.8) },
      // Dark marks run longer: image-4 measures 8.5:1 against the light population's 6.9:1.
      uGlintLayerAspect: { value: new THREE.Vector3(1.23, 1.0, 0.85) },
      uGlintLayerFacing: { value: new THREE.Vector3(0.85, 0.45, 0.12) },
      // How hard each stop is pulled onto the crests, for the patch/road lattice ONLY. Lower
      // than it was: the wave-tip behaviour now owns "on the very top of the wave" and pins
      // itself there at 1.0, so leaving the top stop at 0.85 as well made the patches
      // crest-locked too and there was nothing left on the water BETWEEN the crests — which is
      // most of what a patch of cat's-paw actually is.
      uGlintLayerCrest: { value: new THREE.Vector3(0.0, 0.3, 0.5) },

      // The colour ladder, all SIGNED against the water underneath: bottom darker, middle
      // lighter, top lightest, with saturation dropping as it brightens. Sampled from
      // art/seaRamp.ts GLINT_RULE, whose light and dark stops were read off image-4 — the
      // middle stop is interpolated between them, which is what it looks like in the frame.
      uGlintLift: { value: new THREE.Vector3(-0.12, 0.15, 0.29) },
      uGlintSat: { value: new THREE.Vector3(0.7, 0.45, 0.3) },
      uGlintLiftVar: { value: new THREE.Vector3(0.06, 0.11, 0.17) },
      uGlintMaxLight: { value: GLINT_RULE.maxLightness },

      // The glitter road. A half-angle, so the wedge is a point at the camera and widens as it
      // runs out — the upside-down triangle.
      //
      // Narrowed twice. First both ends halved, 8/34 deg to 4/17. Then the WIDE end halved
      // again on width rather than on angle: the road's width goes as tan(half-angle), so
      // 17 deg does not halve to 8.5 but to atan(tan(17)/2) = 8.69, which is a width ratio of
      // exactly 0.5000 against 0.4888 for the naive halving. A tenth of a degree hardly shows
      // on the water, but the two are different operations and it costs nothing to do the one
      // that was asked for.
      //
      // 4 deg with the sun overhead, opening to 8.69 on the horizon. The low-sun figure is
      // still the larger of the two, so the road still widens as the sun drops — just over a
      // much shorter range than it did.
      uGlintPathHighSun: { value: THREE.MathUtils.degToRad(4) },
      uGlintPathLowSun: { value: THREE.MathUtils.degToRad(8.69) },
      uGlintPathSoft: { value: 0.55 },
      // Road marks are drawn 3x the size of the same stop elsewhere. The shader multiplies the
      // road's density by the square of this so the COUNT does not move with it — a cell holds
      // one mark, so growing the cell to grow the mark would otherwise spread the lattice and
      // thin the road ninefold just as its marks got fat.
      //
      // Only the top stop draws in the road now, so this is the size of a highlight and there
      // is nothing underneath it to stay in proportion with.
      uGlintRoadScale: { value: 3 },
      // WAVY SIDES, so the road reads as a triangle rather than as one. A ruled edge is the
      // tell that gives a glitter path away as a stencil laid over the sea — nothing on water
      // has a straight side — so the half-angle is perturbed by world-space noise and the
      // boundary wanders in and out around the wedge it is still built from.
      //
      // 0.35 lets the edge move about a third of the half-angle either way, which at the
      // shipped 4-8.7 deg wedge is a wander of a couple of degrees: clearly not ruled, still
      // clearly a triangle. Past ~0.6 the sides start pinching in far enough to break the road
      // into separate pools, which is a different look and probably not this one.
      uGlintPathWaviness: { value: 0.35 },
      // Length of one undulation, metres. Sized well above a glint cell and well below the
      // road's own length, so it shapes the EDGE rather than either roughening it into noise
      // or bending the whole road into a curve.
      uGlintPathWaveScale: { value: 45 },

      // The patches: countable clusters on a slot lattice, not a noise threshold.
      //
      // THE SLOT SIZE AND THE JITTER TOGETHER ARE THE MINIMUM GAP, and that is the whole
      // reason the construction looks like this. Two patch centres in neighbouring slots can
      // approach each other by at most half the jitter each, so the closest they ever come is
      // cell * (1 - jitter) = 60 * 0.5 = 30 m. It is arithmetic rather than a rejection test,
      // so no patch can ever violate it — which is what an fBM threshold could not promise at
      // all, since noise has no notion of one patch ending and the next beginning.
      uGlintPatchCell: { value: 60 },
      uGlintPatchJitter: { value: 0.5 },
      // "Sparingly": roughly a third of the slots carry a patch, and the sea state scales this
      // (see GLINT_COVERAGE_REF) so calm water gets fewer cat's-paws rather than smaller ones.
      uGlintPatchChance: { value: 0.32 },
      // How far a cluster's members spread from its centre. Well under half the 30 m gap, so
      // neighbouring clusters read as separate groups with open water between.
      uGlintPatchRadius: { value: 7 },
      // A cluster is elongated along the crest line, like the marks inside it — wind lays its
      // paw prints down the wave, not across them.
      uGlintPatchStretch: { value: 1.6 },
      // The four allowed populations. A patch picks one and scatters exactly that many marks.
      uGlintPatchCounts: { value: new THREE.Vector4(3, 5, 10, 15) },
      // Inside this a cluster is drawn from all three stops; beyond it every member is the top
      // stop. Graded on the PATCH's distance, not the pixel's, so a cluster changes character
      // as one thing rather than across its own width.
      uGlintNearLayers: { value: 50 },
      uGlintFlickerFrom: { value: 100 },
      uGlintFlickerRate: { value: 5.5 },
      uGlintFlickerDepth: { value: 0.75 },

      // Sparkle fades in with depth, standing in for shelter; the fetch field gates it again
      // at the call site.
      uGlintDepthFade: { value: new THREE.Vector2(...GLINT_RULE.depthFade) },
      // BOTH OF THESE ARE THE MEAN OF A GATE, and both are divided back out of the radius
      // solve so that `uGlintCoverage` keeps meaning coverage however hard the gates bite.
      //
      // THEY ARE MEANS OF THE LINEAR TERM NOW, NOT OF ITS SQUARE. The gates used to multiply
      // a mark's RADIUS, so what mattered was their effect on AREA and the constants were
      // means of the squared term. They now decide whether a mark EXISTS, which is linear in
      // the gate, so the right normaliser is the plain mean — a larger number, and using the
      // old one would have solved for marks about a third too big.
      //
      // Mean of the sun-facing term. Not solvable on paper: `facing` is pow(dot(n, h), 6) and
      // on a swell this long the normal barely leaves vertical, so the field is set by the
      // view and sun geometry rather than by the water. What IS known is the bracket — for a
      // term bounded by 1, E[x] lies between E[x^2] and sqrt(E[x^2]), which puts it in
      // [0.61, 0.78] against the 0.61 the old area solve measured. Held at the bottom of that
      // bracket, which errs toward slightly under-covering rather than over. OceanProbe's
      // glint-coverage gate is the instrument for pinning it down; re-check it there whenever
      // the cell size or the facing exponent moves, since neither is scale-invariant.
      uGlintFacingMean: { value: 0.61 },
      // Mean of the crest term, and this one IS solvable. `crest` is
      // smoothstep(-0.1, 0.75, gerstnerCrest), and gerstnerCrest is a sum of four sinusoids
      // over its own summed amplitude — so across open water the four phases are independent
      // and uniform and the distribution follows from the amplitude ratios alone. Sampled at
      // 4M points it gives E[crest] = 0.245 flat / 0.270 wavey / 0.266 choppy, near enough
      // sea-state independent that one constant covers all three. (E[crest^2] is 0.19, which
      // is what this used to want.)
      //
      // A STANDING CAVEAT ON uGlintCoverage. The authored figure is not the rendered one, and
      // the relationship is not the 1/x the area maths predicts — it flattens off, because
      // `glintLayer` sweeps a 3x3 neighbourhood and a mark much larger than its own cell
      // cannot be found from a cell away. Past roughly one cell of radius the solve stops
      // turning radius into coverage and saturates; the radius clamp in the chunk is where
      // that ceiling actually lives. The slider stays monotonic, which is what it is for.
      uGlintCrestMean: { value: 0.27 },

      // 1 = sea behaviour for aerial perspective: lightens with distance, keeps saturation.
      uSeaSatHold: { value: 1 },
      // 04 §3.3 negative control. 0 samples the aircraft shadow against the flat base plane,
      // which is correct; 1 samples it against the displaced surface, which makes it swim.
      uShadowSampleDisplaced: { value: 0 },
      // The sea, unlike land, really does merge into the horizon band, so it lifts the
      // ceiling the shared chunk applies to land. Declared after the global uniforms are
      // merged in, below, or it would be overwritten by the shared value.
      uHazeCeiling: { value: 1 },
    };

    // Merge globals FIRST, then the shoreline block, then let the ocean's own entries win —
    // otherwise the shared uHazeCeiling (land's 0.62) would clobber the sea's 1.0.
    const merged = Object.assign(
      {},
      globalUniforms as unknown as OceanUniforms,
      shadowUniforms as OceanUniforms,
      shore ?? {},
      this.uniforms,
    );
    this.material = new THREE.ShaderMaterial({
      uniforms: merged,
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      side: THREE.FrontSide,
      toneMapped: false, // colour is authored end-to-end; see RendererConfig
    });

    this.rings = buildOceanRings(this.material, DEFAULT_RING_LEVELS);
    scene.add(this.rings.group);

    this.applySeaState(seaState);
  }

  get triangles(): number {
    return this.rings.triangles;
  }

  get seaStateName(): SeaStateName {
    return this.seaState;
  }

  /** Budget check against 02 §6.1's 150-300k triangle allowance for the whole visible sea. */
  get withinTriangleBudget(): boolean {
    return this.rings.triangles <= OCEAN.maxTriangles;
  }

  /**
   * Compass heading of the dominant swell, degrees clockwise from north.
   *
   * Read and written as an ABSOLUTE bearing, but stored as an offset from whatever the current
   * sea state authored, so the four waves keep the spread between them. A stack whose
   * components could be aimed independently would stop being a swell and become four unrelated
   * waves crossing, which is a different sea entirely.
   */
  get waveHeadingDeg(): number {
    return SEA_STATES[this.seaState].waves[0].directionDeg + this.headingOffset;
  }

  /** Seconds for one full cycle of the dominant swell. What foam on the crests moves on. */
  get dominantWavePeriod(): number {
    const w = SEA_STATES[this.seaState].waves[0];
    const k = (Math.PI * 2) / w.wavelength;
    return (Math.PI * 2) / Math.sqrt(9.8 * k);
  }

  /** Degrees the stack is rotated off the authored bearing. The hull needs the same number. */
  get headingOffsetDeg(): number {
    return this.headingOffset;
  }

  setWaveHeading(deg: number): void {
    this.headingOffset = deg - SEA_STATES[this.seaState].waves[0].directionDeg;
    this.applySeaState(this.seaState, true);
  }

  /**
   * Attach the baked fetch field. Late, because it is baked FROM the island land mask.
   *
   * Same shape as `attachShore`: the sea cannot know about shelter until there is something to
   * be sheltered by, so the block is built empty and filled once the archipelago exists.
   */
  attachShelter(field: ShelterField): void {
    this.uniforms.uShelterMap!.value = field.texture;
    (this.uniforms.uShelterOrigin!.value as THREE.Vector2).set(field.originX, field.originZ);
    this.uniforms.uShelterSize!.value = field.worldSize;
    this.uniforms.uShelterEnable!.value = 1;
  }

  applySeaState(name: SeaStateName, keepHeading = false): void {
    this.seaState = name;
    // A sea state carries its own bearing, the way a time-of-day preset carries the sun's, so
    // picking one resets the rotation unless the caller is only re-applying to change heading.
    if (!keepHeading) this.headingOffset = 0;
    const state = SEA_STATES[name];

    const waves = this.uniforms.uWaves!.value as THREE.Vector4[];
    const steepness = this.uniforms.uSteepness!.value as number[];

    state.waves.forEach((w, i) => {
      const [dx, dz] = waveDirection(w.directionDeg + this.headingOffset);
      waves[i]!.set(dx, dz, w.wavelength, w.amplitude);
      steepness[i] = w.steepness;
    });

    // The glint field stretches its marks ALONG the swell (02 §3.1), so this has to turn with
    // the waves. Left behind, the marks would lie across the crests instead of down them,
    // which is the one thing the measured 6:1 aspect ratio exists to get right.
    const [sx, sz] = waveDirection(state.waves[0].directionDeg + this.headingOffset);
    (this.uniforms.uSwellDir!.value as THREE.Vector2).set(sx, sz);
    this.uniforms.uGlintCoverage!.value = state.glintCoverage;
    // Wave-tip glints ride the crests, and a sea state changes how fast those move: 108 m of
    // choppy runs at 13 m/s against wavey's 16.3. Left behind, the marks would drift off the
    // tips they are gated to at a couple of metres a second.
    this.uniforms.uGlintCrestSpeed!.value = crestSpeed(state.waves[0].wavelength);
  }

  /**
   * Recentre the rings on the camera and update time-driven uniforms.
   *
   * The rings snap to whole cells of the innermost level so the wave field does not appear
   * to crawl across the mesh as the camera moves.
   */
  update(camera: THREE.Camera, elapsed: number): void {
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const snap = (DEFAULT_RING_LEVELS[0]!.extent * 2) / DEFAULT_RING_LEVELS[0]!.cells;
    this.rings.group.position.set(Math.round(camPos.x / snap) * snap, 0, Math.round(camPos.z / snap) * snap);

    this.uniforms.uWaveTime!.value = elapsed;

    // NOTHING HERE TOUCHES THE GLINT SIZE. Worth saying explicitly, because two different
    // attempts to make marks hold their apparent size have now been taken out of this file and
    // a third would be easy to add by reflex.
    //
    // The first scaled a mark by its DISTANCE from the eye. That factor is constant on circles
    // around the camera and varies along every view ray, so it bent the lattice into arcs and
    // the far sea read as a cartwheel radiating from the viewer. That one was a defect.
    //
    // The second scaled by camera ALTITUDE — no direction to radiate along, so it had none of
    // that trouble, and it kept the sea lit from 1500 m. It is gone because glints growing as
    // you climb is not what the sea does: a mark is a piece of water a couple of metres across
    // and it should shrink with height like everything else in the frame. The references agree
    // more than the old brief did — image-4 measures 16.1% coverage on near water, the
    // mid-altitude frame 1.6%, and the two high-altitude frames show no discrete marks at all.
    //
    // So mark size is now a world-space constant and perspective does the whole job. Expect
    // the field to thin out with height and to be effectively gone from high altitude, which
    // is the reference behaviour. `uGlintLod` remains as a manual global size multiplier;
    // nothing drives it per frame.
    //
    // NO ALTITUDE FADE either, and that is a separate thing. This used to run
    // `1 - smoothstep(700, 1100, altitude)`, which put the field at exactly zero from 1100 m
    // up — a hard cutoff rather than a natural thinning, and the real reason the sea went bare
    // from the air.
  }

  dispose(): void {
    this.rampTexture.dispose();
    this.material.dispose();
    for (const mesh of this.rings.meshes) mesh.geometry.dispose();
  }
}
