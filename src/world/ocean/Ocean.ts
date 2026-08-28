import * as THREE from 'three';
import { COAST, SEA } from '../../art/palette';
import { GLINT_RULE } from '../../art/seaRamp';
import { SURFACES } from '../../art/surfaces';
import { SEA_STATES, swellDirection, waveDirection, type SeaStateName } from '../../art/seaStates';
import { OCEAN } from '../../art/budgets';
import { globalUniforms, shadowUniforms } from '../../render/shading/ShadingUniforms';
import { DepthField } from '../depth/DepthField';
import { buildOceanRings, DEFAULT_RING_LEVELS, type OceanRings } from './RingMesh';
import { buildSeaRampTexture } from './SeaRampTexture';
import type { ShoreUniforms } from '../shore/shoreUniforms';

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

export class Ocean {
  readonly material: THREE.ShaderMaterial;
  readonly rings: OceanRings;
  readonly depthField: DepthField;
  readonly uniforms: OceanUniforms;
  /** The sampled depth LUT, baked from art/seaRamp.ts. Owned here; released by dispose(). */
  readonly rampTexture: THREE.DataTexture;
  private seaState: SeaStateName;

  constructor(
    scene: THREE.Scene,
    depthField: DepthField,
    seaState: SeaStateName = 'breeze',
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
      uSwellDir: { value: new THREE.Vector2(1, 0) },
      uGlintCoverage: { value: SEA_STATES[seaState].glintCoverage },
      // Cells per metre across the swell. This sets the WORLD size of a mark; coverage is
      // scale-invariant and does not.
      //
      // Solved rather than eyeballed. On the skim view the frame spans ~74 m at 60 m out, so
      // a 1024 px frame runs ~0.073 m/px; image-4's marks measure 17-33 px, which is 1.2-2.4 m
      // of actual sea. Earlier values (0.16, then 0.36) put marks at 16-27 m and rendered the
      // near field as overlapping blobs — that scale came from the top-down MOTION frame,
      // where the world-size conversion was never anchored to anything.
      uGlintScale: { value: 1.6 },
      // Along-swell compression sets the dash aspect, from the LIGHT population's median.
      // Was 1/4.6 off the harbour frame; image-4.jpg — near, lively, sunlit open sea, the
      // densest glint reference — puts it at 6.9:1, with dark marks longer again at 8.5:1.
      uGlintStretch: { value: 1 / (GLINT_RULE.light.aspect * GLINT_RULE.screenToWorldAspect) },
      uGlintDarkAspectMul: { value: GLINT_RULE.dark.aspect / GLINT_RULE.light.aspect },
      uGlintDrift: { value: 0.6 },
      uGlintFade: { value: 1 },
      // Glint colour is derived from the water beneath, not from fixed hexes (art/seaRamp.ts
      // GLINT_RULE). SEA.crestLow / crestMid stay in the palette for foam in Step 4.
      // Two populations: x = light marks, y = dark. The lightness term is SIGNED — marks go
      // both ways off the water, roughly 4:1, and the dark ones are what make the surface
      // read as textured rather than as flat colour with highlights printed on it.
      uGlintSatScale: { value: new THREE.Vector2(GLINT_RULE.light.saturationScale, GLINT_RULE.dark.saturationScale) },
      uGlintLift: { value: new THREE.Vector2(GLINT_RULE.light.lightnessLift, GLINT_RULE.dark.lightnessLift) },
      uGlintLiftVar: { value: new THREE.Vector2(GLINT_RULE.light.lightnessLiftVariation, GLINT_RULE.dark.lightnessLiftVariation) },
      uGlintDarkFrac: { value: GLINT_RULE.darkFraction },
      uGlintMaxLight: { value: GLINT_RULE.maxLightness },
      // Sparkle fades in with depth, standing in for shelter until Step 4 has a wind field.
      uGlintDepthFade: { value: new THREE.Vector2(...GLINT_RULE.depthFade) },
      // Patch scale ~90 m: cat's-paw sized, well above the ~6 m glint cell so it gates
      // groups of marks rather than individuals (02 §3, "patches with real empty water").
      uGlintPatchScale: { value: 90 },
      uGlintPatchContrast: { value: 0.85 },
      // Mean of smoothstep(0.35, 0.62, fbm2) over open water. Taken as 0.5 and then checked:
      // with it in place, patched coverage returns to 3.6%, the same figure the unpatched
      // field measured. If the patch thresholds move, re-check that number rather than
      // assuming it still holds.
      uGlintPatchMean: { value: 0.5 },
      // Mean of the sun-facing radius term, squared (it scales area). Calibrated the same way
      // as uGlintPatchMean, by rendering and solving: at 1.0 the topdown view measured 7.8%
      // against an authored 0.16. It is NOT scale-invariant — finer cells sample the wave
      // normals differently, so it moved from 0.49 to 0.61 when uGlintScale went 0.16 -> 0.36.
      // Re-check it whenever uGlintScale or the facing exponent changes.
      uGlintFacingMean: { value: 0.61 },
      // Density taper with viewing distance. image-4's 16% is NEAR water on a low pass; the
      // mid-altitude and high-altitude frames show 1.6% and essentially zero. Without this
      // the same world-space field blankets the frame from any camera.
      uGlintRangeFade: { value: new THREE.Vector2(40, 150) },

      uSkyReflectStrength: { value: 0.35 },
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

  applySeaState(name: SeaStateName): void {
    this.seaState = name;
    const state = SEA_STATES[name];

    const waves = this.uniforms.uWaves!.value as THREE.Vector4[];
    const steepness = this.uniforms.uSteepness!.value as number[];

    state.waves.forEach((w, i) => {
      const [dx, dz] = waveDirection(w.directionDeg);
      waves[i]!.set(dx, dz, w.wavelength, w.amplitude);
      steepness[i] = w.steepness;
    });

    const [sx, sz] = swellDirection(state);
    (this.uniforms.uSwellDir!.value as THREE.Vector2).set(sx, sz);
    this.uniforms.uGlintCoverage!.value = state.glintCoverage;
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

    // Glints fade out with altitude: above ~900 m the reference frames show almost no
    // discrete sparkle, only deep colour (02 §3.2).
    const altitude = Math.max(camPos.y, 0);
    this.uniforms.uGlintFade!.value = 1 - smoothstep(700, 1100, altitude);
  }

  dispose(): void {
    this.rampTexture.dispose();
    this.material.dispose();
    for (const mesh of this.rings.meshes) mesh.geometry.dispose();
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
