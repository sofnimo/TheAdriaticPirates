import * as THREE from 'three';

/**
 * TOON SHADING — one switch that puts the whole world on a banded light ramp.
 *
 * `THREE.MeshToonMaterial` is, underneath, a Lambert material whose N·L term is
 * quantised through a gradient texture instead of used directly. That single
 * sentence is what this module implements, and it has to implement it TWICE,
 * because the grass world is built out of two very different kinds of material:
 *
 *   · PLAIN materials — the rocks (`MeshStandardMaterial`), the aircraft's
 *     imported Phong/Standard materials. Nothing custom is riding on them, so
 *     these are genuinely SWAPPED for a real `MeshToonMaterial` that copies the
 *     original's colour, maps and transparency across. The paint job survives;
 *     only the lighting model changes.
 *
 *   · SHADER-INJECTED Lambert materials — every blade, the ground, the bark, the
 *     pine canopies, the flowers. These are `MeshLambertMaterial` carrying the
 *     vendored scene's own GLSL: the wind that bends each blade, the dirt mask
 *     the ground and the blade bases share, the ring-averaged soft shadow. Swap
 *     one of those for a `MeshToonMaterial` and the grass stops moving, the dirt
 *     disappears and the field flattens into unbent quads. So these are BANDED IN
 *     PLACE instead — `RE_Direct` is redefined to run the same quantisation
 *     `MeshToonMaterial` would, and everything the vendored shader does is left
 *     exactly where it was.
 *
 * Both paths band against the same function at the same thresholds (see
 * `TOON_BAND_GLSL` and `makeToonGradient`, which is that function baked into a
 * texture), so a rock and the grass it sits in step at the same N·L. If they ever
 * drift apart, it is because those two stopped agreeing.
 *
 * The grass materials also apply their soft shadow as a straight multiply on
 * `gl_FragColor` — outside three's lighting entirely, so redefining `RE_Direct`
 * never reaches it. That multiply is banded separately, which is what turns the
 * blurred shadow under a tree into a hard cel edge.
 *
 * Toggling costs no recompile: the injection is permanent once applied and rides
 * on a `uToon` uniform, so the switch is a uniform write. Only the material swap
 * has a cost, and it is bounded by the handful of plain materials in the scene.
 */

export const TOON_DEFAULT_STEPS = 3;
export const TOON_MIN_STEPS = 2;
export const TOON_MAX_STEPS = 6;

export interface ToonUniforms {
  /** 0 = untouched lighting, 1 = fully banded. Blended, so it can be eased. */
  uToon: { value: number };
  /** How many tones the light ramp is cut into. */
  uToonSteps: { value: number };
}

export function createToonUniforms(steps = TOON_DEFAULT_STEPS): ToonUniforms {
  return { uToon: { value: 0 }, uToonSteps: { value: steps } };
}

/**
 * The band function, shared by both paths.
 *
 * `floor` alone would be enough to make the bands, but a hard floor of a value
 * that varies smoothly across the screen aliases badly — the band edge crawls
 * with a jagged staircase on any curved surface. The `fwidth` term widens the
 * edge to exactly one pixel of the underlying gradient, which is the smallest
 * smoothing that removes the staircase without softening the look back into a
 * gradient.
 */
const TOON_BAND_GLSL = /* glsl */ `
uniform float uToon;
uniform float uToonSteps;

float adriaticToonBand( float x, float steps ) {
  float s = max( steps, 2.0 );
  float scaled = clamp( x, 0.0, 1.0 ) * s;
  float band = floor( scaled );
  float frac = scaled - band;
  // Half a pixel either side of the edge. Clamped: on a surface seen edge-on the
  // derivative explodes and an unclamped width dissolves every band at once.
  float w = clamp( fwidth( scaled ) * 0.5, 0.0001, 0.5 );
  band += smoothstep( 1.0 - w, 1.0, frac );
  return clamp( band, 0.0, s - 1.0 ) / ( s - 1.0 );
}

float adriaticToonMix( float x ) {
  return mix( x, adriaticToonBand( x, uToonSteps ), uToon );
}
`;

/**
 * The banded replacement for Lambert's direct-light term.
 *
 * Written as `#undef` + `#define` over three's own chunk rather than as a
 * string-surgery replacement INSIDE it. The chunk's body is whitespace-sensitive
 * upstream source that moves between three releases; the two names this depends
 * on — `LambertMaterial` and `RE_Direct` — have not moved in years. `RE_Direct`
 * is not called until `lights_fragment_begin`, well below this point, so the
 * redefinition is in force everywhere it matters.
 */
const TOON_LAMBERT_PARS = /* glsl */ `
#include <lights_lambert_pars_fragment>

void RE_Direct_AdriaticToon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {

  float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
  vec3 irradiance = adriaticToonMix( dotNL ) * directLight.color;

  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );

}

#undef RE_Direct
#define RE_Direct RE_Direct_AdriaticToon
`;

/**
 * The vendored grass materials darken by their own soft shadow with this exact
 * multiply, after three's lighting has finished. `_shadow` is the blades',
 * `_gShadow` the ground's; both are a ring average in 0..1.
 *
 * Guarded by an `includes` check on purpose — this is the one place that matches
 * vendored source text, so if upstream rewrites the line the toggle quietly loses
 * its cel shadows rather than producing a shader that will not compile.
 */
const GRASS_SHADOW_TERMS = ['_shadow', '_gShadow'] as const;

/** Materials already carrying the injection, so a rescan is idempotent. */
const injected = new WeakSet<THREE.Material>();

type LambertLike = THREE.MeshLambertMaterial;

function isInjectable(material: THREE.Material): material is LambertLike {
  return (material as THREE.MeshLambertMaterial).isMeshLambertMaterial === true;
}

/**
 * Give one Lambert material the banded light ramp, permanently, behind `uToon`.
 *
 * The existing `onBeforeCompile` is CALLED, not replaced: everything in this
 * scene that matters is in there, and the whole point of banding in place rather
 * than swapping is to keep it. Ours runs after, so the shadow replacements below
 * see the vendored GLSL they are looking for.
 */
export function injectToon(material: THREE.Material, u: ToonUniforms): boolean {
  if (injected.has(material) || !isInjectable(material)) return false;
  injected.add(material);

  const prior = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    prior.call(this, shader, renderer);

    shader.uniforms.uToon = u.uToon;
    shader.uniforms.uToonSteps = u.uToonSteps;
    shader.fragmentShader = TOON_BAND_GLSL + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_lambert_pars_fragment>',
      TOON_LAMBERT_PARS,
    );

    for (const term of GRASS_SHADOW_TERMS) {
      const from = `gl_FragColor.rgb *= ( 1.0 - uShadowStrength * ( 1.0 - ${term} ) );`;
      if (!shader.fragmentShader.includes(from)) continue;
      shader.fragmentShader = shader.fragmentShader.split(from).join(
        `gl_FragColor.rgb *= ( 1.0 - uShadowStrength * ( 1.0 - adriaticToonMix( ${term} ) ) );`,
      );
    }
  };

  // The material may already have compiled — nothing recompiles on its own just
  // because onBeforeCompile changed.
  material.needsUpdate = true;
  return true;
}

/**
 * The band function baked into a 1-D texture, for real `MeshToonMaterial`s.
 *
 * `getGradientIrradiance` samples at `dot( n, l ) * 0.5 + 0.5`, i.e. the texture
 * spans N·L from -1 to +1, while `adriaticToonBand` is fed a saturated 0..1 N·L.
 * The lower half is therefore all darkest-band, and only the upper half carries
 * the ramp — which is what makes a swapped rock step at the same angles as the
 * grass around it. Nearest filtering is what keeps the bands hard.
 */
export function makeToonGradient(steps: number): THREE.DataTexture {
  const width = 256;
  const s = Math.max(2, Math.round(steps));
  const data = new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    const dotNL = ((i + 0.5) / width) * 2 - 1;
    const band = dotNL <= 0 ? 0 : Math.min(Math.floor(dotNL * s), s - 1) / (s - 1);
    data[i] = Math.round(band * 255);
  }
  const texture = new THREE.DataTexture(data, width, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Cached per step count — one texture per band count for the whole page. */
const gradients = new Map<number, THREE.DataTexture>();

export function toonGradient(steps: number): THREE.DataTexture {
  const key = Math.max(2, Math.round(steps));
  let texture = gradients.get(key);
  if (!texture) {
    texture = makeToonGradient(key);
    gradients.set(key, texture);
  }
  return texture;
}

/**
 * A `MeshToonMaterial` wearing the source material's paint.
 *
 * Everything that describes the SURFACE comes across — base colour, colour map,
 * emissive, alpha, the normal and bump maps, sidedness, vertex colours, flat
 * shading. Everything that describes the LIGHTING RESPONSE is dropped, because
 * dropping it is the entire point: roughness, metalness, specular and shininess
 * have no meaning on a banded ramp.
 */
export function makeToonMaterial(source: THREE.Material, steps: number): THREE.MeshToonMaterial {
  const src = source as THREE.MeshStandardMaterial & THREE.MeshPhongMaterial;
  const toon = new THREE.MeshToonMaterial({ gradientMap: toonGradient(steps) });

  toon.name = source.name ? source.name + ' (toon)' : 'toon';
  if (src.color) toon.color.copy(src.color);
  if (src.emissive) toon.emissive.copy(src.emissive);
  if (src.emissiveIntensity !== undefined) toon.emissiveIntensity = src.emissiveIntensity;
  toon.map = src.map ?? null;
  toon.emissiveMap = src.emissiveMap ?? null;
  toon.alphaMap = src.alphaMap ?? null;
  toon.aoMap = src.aoMap ?? null;
  toon.aoMapIntensity = src.aoMapIntensity ?? 1;
  toon.lightMap = src.lightMap ?? null;
  toon.lightMapIntensity = src.lightMapIntensity ?? 1;
  toon.normalMap = src.normalMap ?? null;
  if (src.normalScale) toon.normalScale.copy(src.normalScale);
  toon.bumpMap = src.bumpMap ?? null;
  toon.bumpScale = src.bumpScale ?? 1;

  toon.side = source.side;
  toon.transparent = source.transparent;
  toon.opacity = source.opacity;
  toon.alphaTest = source.alphaTest;
  toon.depthWrite = source.depthWrite;
  toon.vertexColors = source.vertexColors;
  toon.toneMapped = source.toneMapped;
  // Not a declared field on MeshToonMaterial, but the renderer reads it off any
  // material — and the rocks are authored flat-shaded, which is half their look.
  (toon as unknown as { flatShading: boolean }).flatShading =
    (source as unknown as { flatShading?: boolean }).flatShading === true;

  return toon;
}

/**
 * The toggle itself, over a subtree.
 *
 * Owns two things and keeps them in step: the shared uniform every injected
 * Lambert material reads, and the set of plain materials it has swapped out. The
 * originals are held, never disposed, so turning the toggle off restores exactly
 * what was there — including a material another part of the scene is sharing.
 */
export class ToonShading {
  readonly uniforms: ToonUniforms;

  private enabled = false;
  private stepCount: number;
  /** Meshes whose plain material was swapped, and what to put back. */
  private readonly swapped = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  /** Materials this made, so a step change or a teardown can dispose them. */
  private readonly made: THREE.MeshToonMaterial[] = [];
  /**
   * Every subtree handed to `scan`. Kept so `setEnabled` covers all of them
   * without each caller having to remember the list — the birds arrive minutes
   * after the grass does, and a toggle that only knew about the last root scanned
   * would silently leave them lit.
   */
  private readonly roots: THREE.Object3D[] = [];

  constructor(steps = TOON_DEFAULT_STEPS) {
    this.stepCount = steps;
    this.uniforms = createToonUniforms(steps);
  }

  get on(): boolean {
    return this.enabled;
  }

  get steps(): number {
    return this.stepCount;
  }

  /**
   * Point it at a subtree. Safe to call again after new objects arrive — the
   * injection is tracked per material, and a swap already in place is left alone.
   */
  scan(root: THREE.Object3D): void {
    if (!this.roots.includes(root)) this.roots.push(root);
    const seen = new Set<THREE.Material>();
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const current = this.swapped.get(mesh) ?? mesh.material;
      for (const material of asArray(current)) {
        if (seen.has(material)) continue;
        seen.add(material);
        injectToon(material, this.uniforms);
      }
      if (this.enabled) this.swapMesh(mesh);
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.uniforms.uToon.value = on ? 1 : 0;
    if (!on) {
      this.restore();
      return;
    }
    for (const root of this.roots) {
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) this.swapMesh(mesh);
      });
    }
  }

  setSteps(steps: number): void {
    this.stepCount = Math.max(TOON_MIN_STEPS, Math.round(steps));
    this.uniforms.uToonSteps.value = this.stepCount;
    const gradient = toonGradient(this.stepCount);
    for (const material of this.made) material.gradientMap = gradient;
  }

  /** Put every original material back and drop the ones this made. */
  restore(): void {
    for (const [mesh, original] of this.swapped) mesh.material = original;
    this.swapped.clear();
    for (const material of this.made) material.dispose();
    this.made.length = 0;
  }

  dispose(): void {
    this.restore();
    this.roots.length = 0;
  }

  /**
   * Swap one mesh's plain material(s). Lambert is skipped: it has already been
   * banded in place, and swapping it is exactly the loss this module exists to
   * avoid.
   */
  private swapMesh(mesh: THREE.Mesh): void {
    if (this.swapped.has(mesh)) return;
    const original = mesh.material;
    const list = asArray(original);
    if (list.length === 0 || list.every((m) => isInjectable(m) || !isLit(m))) return;

    const replaced = list.map((material) => {
      if (isInjectable(material) || !isLit(material)) return material;
      const toon = makeToonMaterial(material, this.stepCount);
      this.made.push(toon);
      return toon;
    });

    this.swapped.set(mesh, original);
    mesh.material = Array.isArray(original) ? replaced : replaced[0]!;
  }
}

/** Only materials that actually read lights have a toon equivalent. */
function isLit(material: THREE.Material): boolean {
  const m = material as unknown as Record<string, unknown>;
  return (
    m.isMeshStandardMaterial === true ||
    m.isMeshPhysicalMaterial === true ||
    m.isMeshPhongMaterial === true ||
    m.isMeshLambertMaterial === true ||
    m.isMeshToonMaterial === true
  );
}

function asArray(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}
