// ─────────────────────────────────────────────────────────────────────────────
// VENDORED — stylized-components / grassField
//   Christian Ortiz (Cortiz) · https://cortiz.dev · MIT (see ./LICENSE)
//
// Ported from the React-Three-Fiber original into this project's plain three.js
// runtime. The GLSL, the materials and the scatter maths are the author's, kept
// byte-for-byte wherever possible so upstream fixes stay easy to follow; only the
// framework seams were rewritten (React hooks -> GrassField, Leva panels ->
// grassControls). Edits carry an "ADRIATIC:" comment.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from "three";
import type { FlowerUniforms, FlowerTextures, DirtUniforms } from "../uniforms";
import { GROUND_MASK_UNIFORMS, GROUND_MASK_GLSL } from "../shaders/groundMask";
import {
  FLOWER_WIND_UNIFORMS,
  FLOWER_WIND_VERTEX,
  FLOWER_UNIFORMS,
  FLOWER_DIFFUSE,
} from "../shaders/flower";

// ─────────────────────────────────────────────────────────────────────────────
// Flower materials.
//
// A flower is a cross-billboard: two 1×1 quads 90° apart, with the petal shape
// cut out of them by an alpha mask. Two materials are needed, and they must stay
// in lockstep:
//
//   makeFlowerMaterial()      — what you see. Lambert, so the flowers receive the
//                               scene's light and shadows for free.
//   makeFlowerDepthMaterial() — what the SHADOW MAP sees. Three renders shadows
//                               with its own depth material, which knows nothing
//                               about our mask or our wind. Left alone, every
//                               flower would cast the shadow of a static, solid
//                               RECTANGLE — the quad it is drawn on. So the depth
//                               pass repeats both: the same discard (or the shadow
//                               has no flower shape) and the same wind (or the
//                               shadow stands still while the flower sways out of
//                               it). Assign it to InstancedMesh.customDepthMaterial.
//
// The cut-out is a `discard`, not alpha blending, so the flowers depth-sort
// correctly against the blades without a transparent pass.
// ─────────────────────────────────────────────────────────────────────────────

function bindUniforms(
  shader: { uniforms: Record<string, THREE.IUniform> },
  tex: FlowerTextures,
  flu: FlowerUniforms,
  dirt: DirtUniforms,
) {
  Object.assign(shader.uniforms, tex, flu, dirt);
}

/** The vertex stage needs the dirt mask to cull flowers off bare earth, so both
 *  materials prepend the same declarations. */
const FLOWER_VERTEX_HEADER =
  FLOWER_WIND_UNIFORMS + GROUND_MASK_UNIFORMS + GROUND_MASK_GLSL;

export function makeFlowerMaterial(
  tex: FlowerTextures,
  flu: FlowerUniforms,
  dirt: DirtUniforms,
): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
  });

  mat.onBeforeCompile = (shader) => {
    bindUniforms(shader, tex, flu, dirt);

    shader.vertexShader = FLOWER_VERTEX_HEADER + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      FLOWER_WIND_VERTEX,
    );

    shader.fragmentShader = FLOWER_UNIFORMS + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec4 diffuseColor = vec4( diffuse, opacity );",
      FLOWER_DIFFUSE,
    );
  };

  // ADRIATIC: a distinct program-cache key.
  //
  // Every material in this folder is a stock MeshLambertMaterial with different
  // GLSL spliced in by onBeforeCompile, and three keys its program cache on the
  // material's PARAMETERS — which do not include anything onBeforeCompile did.
  // Two of these that happen to be constructed with the same flags therefore get
  // handed the same compiled program, and whichever compiled first wins.
  //
  // Ground and bark are exactly that pair: both `MeshLambertMaterial({ side:
  // FrontSide })`, byte-identical as far as the cache is concerned. The ground
  // ended up running the bark shader, sampling the bark map at uv x uBarkScale
  // with RepeatWrapping — a tiled photograph of tree bark stamped across the
  // terrain. Blades and flowers are the same hazard (both DoubleSide, no map).
  //
  // The key is a CONSTANT per family, not per instance: every blade must still
  // share one program with every other blade, which is what upstream's note about
  // omitting the key was protecting. This separates the families without
  // splitting them internally.
  mat.customProgramCacheKey = () => 'grass-flower-v1';

  return mat;
}

export function makeFlowerDepthMaterial(
  tex: FlowerTextures,
  flu: FlowerUniforms,
  dirt: DirtUniforms,
): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    bindUniforms(shader, tex, flu, dirt);

    shader.vertexShader = FLOWER_VERTEX_HEADER + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      FLOWER_WIND_VERTEX,
    );

    shader.fragmentShader =
      `varying vec2 vFlUv;\nuniform sampler2D uFlowerMask;\n` +
      shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <clipping_planes_fragment>",
      `#include <clipping_planes_fragment>
      if ( texture2D( uFlowerMask, vFlUv ).r < 0.5 ) discard;`,
    );
  };

  // ADRIATIC: see makeFlowerMaterial. Depth materials collide just as readily.
  mat.customProgramCacheKey = () => 'grass-flower-depth-v1';

  return mat;
}
