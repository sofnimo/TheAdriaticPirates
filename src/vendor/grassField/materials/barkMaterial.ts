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
import type { BarkUniforms } from "../uniforms";

// ─────────────────────────────────────────────────────────────────────────────
// Bark material — replaces a trunk's baked texture with a bark set
// (color + AO + height).
//
// The three maps are sampled BY HAND in the fragment shader rather than bound
// through Three's `map` / `aoMap` slots. That buys two things:
//
//   · The UV scale becomes a uniform. Going through `map` would mean tiling via
//     texture.repeat — a property of the texture, which is shared by every trunk,
//     so every change would re-upload it.
//   · The AO map needs no second UV set, which the `aoMap` slot would require.
//
// The tint is applied AFTER desaturating toward luminance. Tinting the raw
// photographic color directly would drown the tint in the photo's own brown
// variance and barely register; pulling the saturation out first is what lets
// the tint actually decide the trunk's color.
// ─────────────────────────────────────────────────────────────────────────────

export function makeBarkMaterial(u: BarkUniforms): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.FrontSide });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = `varying vec2 vBarkUv;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>\n      vBarkUv = uv;`,
    );

    shader.fragmentShader =
      `varying vec2 vBarkUv;
      uniform sampler2D uBarkColorMap;
      uniform sampler2D uBarkAOMap;
      uniform sampler2D uBarkHeightMap;
      uniform float uBarkScale;
      uniform vec3  uBarkTint;
      uniform float uBarkTintStrength;
      uniform float uBarkSaturation;
      uniform float uBarkBrightness;
      uniform float uBarkAOStrength;
      uniform float uBarkRelief;\n` + shader.fragmentShader;

    // Fake relief: tilt the shading normal by the screen-space slope of the
    // height map. No tangents needed — the derivatives give the bump direction
    // directly in view space, which is where `normal` already lives.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      `#include <normal_fragment_begin>
      if ( uBarkRelief > 0.001 ) {
        float _bh = texture2D( uBarkHeightMap, vBarkUv * uBarkScale ).r;
        normal = normalize( normal - uBarkRelief * vec3( dFdx( _bh ), dFdy( _bh ), 0.0 ) );
      }`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      {
        vec2 _buv  = vBarkUv * uBarkScale;
        vec3 _bark = texture2D( uBarkColorMap, _buv ).rgb;

        float _luma = dot( _bark, vec3( 0.2126, 0.7152, 0.0722 ) );
        _bark = mix( vec3( _luma ), _bark, uBarkSaturation );
        _bark = mix( _bark, _bark * uBarkTint, uBarkTintStrength );

        float _ao = texture2D( uBarkAOMap, _buv ).r;
        _bark *= mix( 1.0, _ao, uBarkAOStrength );

        diffuseColor.rgb = _bark * uBarkBrightness;
      }`,
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
  mat.customProgramCacheKey = () => 'grass-bark-v1';

  return mat;
}
