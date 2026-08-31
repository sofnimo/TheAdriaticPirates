/**
 * The Leva panel, flattened.
 *
 * Upstream every one of these was a slider in `grassField/utils/controls.ts`, and
 * the DEFAULTS there are the authored look — the values the scene was tuned to,
 * not placeholders. They are transcribed here verbatim so the port starts from the
 * same picture, and so a difference between the two scenes is always traceable to
 * a value rather than to a missing one.
 *
 * DATA ONLY. `GrassField` reads this bag every frame and writes it into the
 * uniforms; nothing here rebuilds geometry except the fields marked `(rebuilds)`,
 * which is exactly the split upstream had.
 */

export interface GrassParams {
  // ── Blades: scatter (rebuilds) ──────────────────────────────────────────────
  /** Blades per world unit² of ground surface. */
  grDensity: number;
  grMaxCount: number;
  grMinWidth: number;
  grMaxWidth: number;
  grMinLength: number;
  grMaxLength: number;
  grTiltMax: number;
  grSegments: number;

  // ── Blades: colour ──────────────────────────────────────────────────────────
  grColorBottom: string;
  grColorTop: string;
  grGradStart: number;
  grGradEnd: number;
  grGradPower: number;
  grBrightness: number;

  // ── Shadow ──────────────────────────────────────────────────────────────────
  grShadowStrength: number;
  grShadowRadius: number;
  grShadowSamples: number;
  grShadowSampleY: number;

  // ── Ground ──────────────────────────────────────────────────────────────────
  grTintFloor: boolean;
  grFlatFloorNormal: number;
  grGndVarColor: string;
  grGndVarStrength: number;
  grGndVarScale: number;
  grGndGrainStrength: number;
  grGndGrainScale: number;
  grGndReliefStrength: number;
  grGndReliefScale: number;

  // ── Environmental patches ───────────────────────────────────────────────────
  grPatchStrength: number;
  grPatchLinkColors: boolean;
  grPatchDry: string;
  grPatchLush: string;
  grPatchScale: number;
  grPatchBias: number;

  // ── Dirt ────────────────────────────────────────────────────────────────────
  grDirtColor: string;
  grDirtCoverage: number;
  grDirtScale: number;
  grDirtSoftness: number;
  grDirtWarp: number;
  grDirtCut: number;
  grDirtBlend: number;

  // ── Rock trampling ──────────────────────────────────────────────────────────
  grRockFlatten: number;
  grRockBend: number;
  grRockRadiusMul: number;
  grRockFalloff: number;

  // ── Translucency ────────────────────────────────────────────────────────────
  grTransColor: string;
  grTransStrength: number;
  grTransPower: number;
  grTransTip: number;
  grTransShadow: number;

  // ── Wind (shared by blades, flowers and canopies) ───────────────────────────
  grWindStrength: number;
  grWindSpeed: number;
  grWindFreq: number;
  /** Degrees. Converted to a unit XZ vector on the way into the uniform. */
  grWindDir: number;
  grWindTurb: number;
  grWindLean: number;

  // ── Bark ────────────────────────────────────────────────────────────────────
  grBarkScale: number;
  grBarkTint: string;
  grBarkTintStrength: number;
  grBarkSaturation: number;
  grBarkBrightness: number;
  grBarkAOStrength: number;
  grBarkRelief: number;

  // ── Pine needles ────────────────────────────────────────────────────────────
  grLeafBottom: string;
  grLeafTop: string;
  grLeafGradPower: number;
  grLeafBrightness: number;
  grLeafVarColor: string;
  grLeafVarStrength: number;
  grLeafVarScale: number;
  grLeafWindStrength: number;
  grLeafFlutterAmp: number;
  grLeafFlutterSpeed: number;
  grLeafDip: number;

  // ── Breakdown switches ──────────────────────────────────────────────────────
  grDebugChannel: number;
  grWindFixLocal: boolean;
}

export const GRASS_DEFAULTS: GrassParams = {
  grDensity: 300,
  grMaxCount: 53000,
  grMinWidth: 0.06,
  grMaxWidth: 0.06,
  grMinLength: 0.15,
  grMaxLength: 0.25,
  grTiltMax: 0.16,
  grSegments: 3,

  grColorBottom: '#4f7c13',
  grColorTop: '#79a01c',
  grGradStart: 0.15,
  grGradEnd: 1.0,
  grGradPower: 1.6,
  grBrightness: 0.8,

  grShadowStrength: 0.35,
  grShadowRadius: 0,
  grShadowSamples: 1,
  grShadowSampleY: 0.15,

  grTintFloor: true,
  grFlatFloorNormal: 1,
  grGndVarColor: '#c4a77d',
  grGndVarStrength: 0.9,
  grGndVarScale: 1.24,
  grGndGrainStrength: 0.95,
  grGndGrainScale: 6.7,
  grGndReliefStrength: 0.0,
  grGndReliefScale: 0.05,

  grPatchStrength: 0.73,
  grPatchLinkColors: true,
  grPatchDry: '#b8a94e',
  grPatchLush: '#6f9a2a',
  grPatchScale: 0.9,
  grPatchBias: 1.6,

  grDirtColor: '#ac956c',
  grDirtCoverage: 0.41,
  grDirtScale: 0.4,
  grDirtSoftness: 0.06,
  grDirtWarp: 0.2,
  grDirtCut: 1.0,
  grDirtBlend: 0.8,

  grRockFlatten: 1.0,
  grRockBend: 0.41,
  grRockRadiusMul: 0.2,
  grRockFalloff: 0.35,

  grTransColor: '#c1e54d',
  grTransStrength: 2.5,
  grTransPower: 6.4,
  grTransTip: 1.0,
  grTransShadow: 1,

  grWindStrength: 0.1,
  grWindSpeed: 1.3,
  grWindFreq: 0.47,
  grWindDir: 243,
  grWindTurb: 0.04,
  grWindLean: 0.05,

  grBarkScale: 5.6,
  grBarkTint: '#8a6a4a',
  grBarkTintStrength: 0,
  grBarkSaturation: 0.7,
  grBarkBrightness: 1.55,
  grBarkAOStrength: 0.45,
  grBarkRelief: 1.5,

  grLeafBottom: '#1c3b23',
  grLeafTop: '#5c8338',
  grLeafGradPower: 1.1,
  grLeafBrightness: 1.05,
  grLeafVarColor: '#1e4430',
  grLeafVarStrength: 0.6,
  grLeafVarScale: 2.5,
  grLeafWindStrength: 1.5,
  grLeafFlutterAmp: 0.35,
  grLeafFlutterSpeed: 3.2,
  grLeafDip: 1.0,

  grDebugChannel: 0,
  grWindFixLocal: true,
};

export interface FlowerParams {
  flEnabled: boolean;
  flDensity: number;
  flMaxCount: number;
  flSize: number;
  flMixA: number;
  flDirtMax: number;
  flColorR: string;
  flColorG: string;
  flColorB: string;
  flColorStem: string;
  flBrightness: number;
  flWindStrength: number;
  flWindSpeed: number;
  flWindFreq: number;
  flWindTurb: number;
  flWindLean: number;
  flBendAmp: number;
  flBendFreq: number;
}

export const FLOWER_DEFAULTS: FlowerParams = {
  flEnabled: true,
  flDensity: 0.6,
  flMaxCount: 257,
  flSize: 0.6,
  flMixA: 0.4,
  flDirtMax: 0.15,
  flColorR: '#b084c7',
  flColorG: '#cbb36a',
  flColorB: '#9287ff',
  flColorStem: '#648029',
  flBrightness: 1.0,
  flWindStrength: 0.15,
  flWindSpeed: 0.8,
  flWindFreq: 0.3,
  flWindTurb: 0.2,
  flWindLean: 0.25,
  flBendAmp: 0.2,
  flBendFreq: 3.0,
};

/**
 * The lighting rig, from `grass/GrassLighting.tsx`.
 *
 * `shadowCamSize` is the one value that does NOT transcribe: upstream's 9 wraps a
 * single ~7.4-unit tile with almost nothing to spare, which is the point — a texel
 * covers 2·camSize/mapSize world units, so slack around the scene is texels spent
 * shadowing empty space. Eight tiles and a stretch of water are a much larger
 * footprint, so GrassWorldScene computes it from the actual tiled bounds instead.
 */
export interface LightingParams {
  ambientColor: string;
  ambientIntensity: number;
  dirColor: string;
  dirIntensity: number;
  /** Direction the light sits along, from the origin. Scene-owned, not preset-owned. */
  dirX: number;
  dirY: number;
  dirZ: number;
  lightDistance: number;
  shadowMapSize: number;
  shadowCamSize: number;
  shadowNear: number;
  shadowFar: number;
  shadowBias: number;
  shadowNormalBias: number;
}

export const LIGHTING_DEFAULTS: LightingParams = {
  ambientColor: '#f5e7c3',
  ambientIntensity: 1,
  dirColor: '#ffffff',
  dirIntensity: 3,
  dirX: -55.0,
  dirY: 21.5,
  // POSITIVE, and that is the whole point: the sun sits on the seaward side, so it
  // lights the faces that point at the water. Everything built here fronts that
  // way — the town's facades, the beach, the side of the wood the establishing
  // shot looks at — and at the vendored scene's original -11.5 the sun was behind
  // all of it. A street lit from the back is a street of silhouettes.
  dirZ: 42.0,
  lightDistance: 60,
  shadowMapSize: 4096,
  shadowCamSize: 9,
  shadowNear: 1,
  shadowFar: 120,
  shadowBias: 0.0,
  shadowNormalBias: 0.22,
};
