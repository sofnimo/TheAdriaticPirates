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
      // The patches carry the authored figure on their own, so open water away from the road
      // measures what the slider says. The road ADDS its weight on top inside the wedge, which
      // is why the glitter path reads as a concentration rather than as the only lit water —
      // at 1.0 it doubles the density there. The tips are weaker than either because the crest
      // gate then thins them to the ~27% of the surface that is near a crest at any moment.
      uGlintBehaviour: { value: new THREE.Vector3(1.0, 1.0, 0.6) },
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
      // Past this range the lattice grows with distance so marks hold their apparent size.
      // At the authored cell size a mark subtends about 1.5 px at 160 m on this projection,
      // and below roughly a pixel a stochastic field boils frame to frame.
      uGlintRefDist: { value: 160 },
      // How fast the mark lattice rides WITH the crests. Positive is downwave — see the sign
      // note in glintCellUV, and `swellTravelDirection` in art/seaStates.ts for why the swell
      // vector points the other way. Modes 0 and 1 want the slow slide; mode 2 wants the
      // crests' own speed, below, or its marks strobe instead of travelling.
      uGlintDrift: { value: 0.6 },
      uGlintCrestSpeed: { value: crestSpeed(SEA_STATES[seaState].waves[0].wavelength) },
      uGlintFade: { value: 1 },
      // How far the outline wanders off a clean ellipse. At 0 the marks are perfect lozenges
      // and, in their thousands, read as one shape stamped over and over; up here they are
      // warped, puddle-shaped blobs, still elongated along the crest.
      uGlintWobble: { value: 0.28 },
      // A little twinkle in EVERY mode, before mode 1's distance speckle is added on top.
      // Real sparkle is never quite still even close in — the face that catches the sun this
      // frame is not the one that catches it next — and a perfectly steady field reads as
      // printed on the water. Kept low: past about 0.3 it starts to look like noise.
      uGlintSpeckle: { value: 0.12 },

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

      // Mode 0, the glitter road. A half-angle, so the wedge is a point at the camera and
      // widens as it runs out — the upside-down triangle. 8 deg with the sun overhead opening
      // to 34 deg on the horizon, which is roughly what a low sun does to a real glitter path.
      uGlintPathHighSun: { value: THREE.MathUtils.degToRad(8) },
      uGlintPathLowSun: { value: THREE.MathUtils.degToRad(34) },
      uGlintPathSoft: { value: 0.55 },

      // Mode 1, patches. Scale ~90 m: cat's-paw sized, well above a glint cell, so it gates
      // groups of marks rather than individuals.
      uGlintPatchScale: { value: 90 },
      uGlintPatchContrast: { value: 0.85 },
      // Mean of smoothstep(0.35, 0.62, fbm2) over open water, taken as 0.5 and then checked
      // by rendering: with it in place, patched coverage returns to the unpatched figure.
      uGlintPatchMean: { value: 0.5 },
      // Inside this the patch carries all three stops; beyond it only the top one resolves.
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

    // NO ALTITUDE FADE. This used to run `1 - smoothstep(700, 1100, altitude)`, which put the
    // glint field at exactly zero from 1100 m up — and it was the real reason the sea went
    // bare from the air, not the density taper it was usually blamed on. The field now holds
    // its apparent mark size with distance instead (see uGlintRefDist), so height costs it
    // nothing; the sun-facing and crest gates still thin it wherever the water tilts away,
    // which is the only thinning that should happen.
  }

  dispose(): void {
    this.rampTexture.dispose();
    this.material.dispose();
    for (const mesh of this.rings.meshes) mesh.geometry.dispose();
  }
}
