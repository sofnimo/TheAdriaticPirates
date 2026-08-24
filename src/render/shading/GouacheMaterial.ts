import * as THREE from 'three';
import { SURFACES, type SurfaceName, type SurfacePreset } from '../../art/surfaces';
import { globalUniforms } from './ShadingUniforms';

import GOUACHE_RAMP_GLSL from './chunks/gouache_ramp.glsl';
import AERIAL_PERSPECTIVE_GLSL from './chunks/aerial_perspective.glsl';

/**
 * THE ONE PLACE `onBeforeCompile` IS ALLOWED.
 *
 * Terrain, cliffs, foliage, buildings, clouds and the aircraft all get their shading from
 * this factory. `surface` picks a row out of art/surfaces.ts (04 §2.3) and nothing else
 * varies — same GLSL, many uniform sets, exactly as the art bible requires.
 *
 * Base material is MeshStandardMaterial: 04 §2.1 picks `onBeforeCompile` injection over a
 * hand-rolled ShaderMaterial precisely so three's shadow sampling, light uniforms and
 * attribute plumbing keep working. We overwrite `outgoingLight` at the end rather than
 * replacing the lighting chunks, which keeps the splice small and version-robust: it
 * depends on two anchors (`<common>`, `<opaque_fragment>`) instead of the internals of
 * the lighting model.
 *
 * The PBR lighting three computes is then discarded. That is wasted ALU on a handful of
 * test spheres and worth revisiting for terrain in Step 3 (MeshLambertMaterial is the
 * cheaper base), but correctness first.
 */

export interface GouacheOptions {
  surface: SurfaceName;
  /** Per-instance colour override; defaults to the surface's authored lit tone. */
  color?: number;
  /** Reads a per-vertex `aAOBias` attribute into the ramp threshold (04 §6). */
  useAOBias?: boolean;
  side?: THREE.Side;
  flatShading?: boolean;
}

export interface GouacheMaterial extends THREE.MeshStandardMaterial {
  /** Per-surface uniforms. Global ones are shared by reference and live elsewhere. */
  gouacheUniforms: {
    uRampSteps: { value: number };
    uShadowTint: { value: THREE.Color };
    uShadowTintMix: { value: number };
    uRimColor: { value: THREE.Color };
    uRimPower: { value: number };
    uRimStrength: { value: number };
  };
  surfacePreset: SurfacePreset;
}

const VERTEX_VARYINGS = /* glsl */ `
varying vec3 vGouacheWorldPos;
varying vec3 vGouacheWorldNormal;
`;

const FRAGMENT_VARYINGS = /* glsl */ `
varying vec3 vGouacheWorldPos;
varying vec3 vGouacheWorldNormal;
`;

const AO_VERTEX = /* glsl */ `
attribute float aAOBias;
varying float vGouacheAOBias;
`;

const AO_FRAGMENT = /* glsl */ `
varying float vGouacheAOBias;
`;

export function createGouacheMaterial(options: GouacheOptions): GouacheMaterial {
  const preset = SURFACES[options.surface];
  const useAOBias = options.useAOBias ?? false;

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(options.color ?? preset.baseColor),
    roughness: 1,
    metalness: 0,
    ...(options.side !== undefined ? { side: options.side } : {}),
    ...(options.flatShading !== undefined ? { flatShading: options.flatShading } : {}),
  }) as GouacheMaterial;

  material.gouacheUniforms = {
    uRampSteps: { value: preset.rampSteps },
    uShadowTint: { value: new THREE.Color(preset.shadowTint) },
    uShadowTintMix: { value: preset.shadowTintMix },
    uRimColor: { value: new THREE.Color(preset.rimColor) },
    uRimPower: { value: preset.rimPower },
    uRimStrength: { value: preset.rimStrength },
  };
  material.surfacePreset = preset;

  material.onBeforeCompile = (shader) => {
    // Shared globals are assigned BY REFERENCE — same object, every material.
    Object.assign(shader.uniforms, globalUniforms, material.gouacheUniforms);

    // ---- vertex: world position + world normal varyings ----------------------
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERTEX_VARYINGS + (useAOBias ? AO_VERTEX : ''))
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n' +
          // `transformed` and `objectNormal` are both in scope by this point.
          // NOTE: modelMatrix only — instanced meshes need instanceMatrix folded in here
          // when Step 3 brings InstancedMesh foliage.
          'vGouacheWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n' +
          'vGouacheWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );\n' +
          (useAOBias ? 'vGouacheAOBias = aAOBias;\n' : ''),
      );

    // ---- fragment: the shared chunks, then overwrite outgoingLight ------------
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' +
          FRAGMENT_VARYINGS +
          (useAOBias ? AO_FRAGMENT : '') +
          // aerial_perspective.glsl #includes sky_gradient.glsl, so the sky model
          // arrives with it — one definition, not a copy.
          GOUACHE_RAMP_GLSL +
          '\n' +
          AERIAL_PERSPECTIVE_GLSL,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
{
  vec3 gouacheN = normalize( vGouacheWorldNormal );
  vec3 gouacheV = normalize( cameraPosition - vGouacheWorldPos );
  float gouacheNdotL = dot( gouacheN, normalize( uSunDirection ) );

  // Shadow read straight from three's own shadow map. getShadowMask() is not available
  // in the physical shader (it ships only in ShaderLib/shadow), so sample directly —
  // one directional light, which is exactly the rig 04 §1 specifies.
  float gouacheShadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow gouacheDirShadow = directionalLightShadows[ 0 ];
    gouacheShadow = receiveShadow ? getShadow(
      directionalShadowMap[ 0 ],
      gouacheDirShadow.shadowMapSize,
      gouacheDirShadow.shadowIntensity,
      gouacheDirShadow.shadowBias,
      gouacheDirShadow.shadowRadius,
      vDirectionalShadowCoord[ 0 ]
    ) : 1.0;
  #endif

  vec3 gouacheShaded = applyGouacheRamp(
    diffuseColor.rgb,
    gouacheNdotL,
    gouacheShadow,
    gouacheN,
    gouacheV,
    ${useAOBias ? 'vGouacheAOBias' : '0.0'}
  );

  // Haze is applied here, once, for every gouache surface in the world.
  outgoingLight = applyAerialPerspective( gouacheShaded, vGouacheWorldPos, cameraPosition );
}
#include <opaque_fragment>`,
      );
  };

  // Variant-aware: a constant key across genuinely different programs would collide.
  material.customProgramCacheKey = () => 'gouache-v1|ao:' + (useAOBias ? '1' : '0');

  return material;
}

/** Live-update a material's per-surface uniforms from a (possibly edited) preset. */
export function applySurfacePreset(material: GouacheMaterial, preset: SurfacePreset): void {
  material.gouacheUniforms.uRampSteps.value = preset.rampSteps;
  material.gouacheUniforms.uShadowTint.value.set(preset.shadowTint);
  material.gouacheUniforms.uShadowTintMix.value = preset.shadowTintMix;
  material.gouacheUniforms.uRimColor.value.set(preset.rimColor);
  material.gouacheUniforms.uRimPower.value = preset.rimPower;
  material.gouacheUniforms.uRimStrength.value = preset.rimStrength;
  material.color.set(preset.baseColor);
  material.surfacePreset = preset;
}
