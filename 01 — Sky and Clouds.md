# 01 — Sky & Clouds

### Implementation research for the Adriatic seaplane world (Porco Rosso lineage)
### Governed by `00_ART_DIRECTION.md` — cyan zenith (`#1ca6c7`→`#169abb`), pale horizon haze (`#b1cbd3`→`#d0dbdf`), stepped/quantised shading, cyan-shaded cloud undersides, near-white lit faces, hard silhouettes, no soft grey mush, 60fps WebGL2 target.

---

## 1. Sky dome / gradient

### 1.1 Custom shader vs three.js `Sky` (Preetham)

Three.js ships a ready-made physical sky add-on, [`Sky`](https://threejs.org/docs/examples/en/objects/Sky.html) ([source](https://github.com/mrdoob/three.js/blob/master/examples/jsm/objects/Sky.js), live [example](https://threejs.org/examples/webgl_shaders_sky.html)), a GLSL port of the Preetham/Nishita atmospheric scattering model with uniforms `turbidity`, `rayleigh`, `mieCoefficient`, `mieDirectionalG`, and `sunPosition`. It is physically parameterised — [Rayleigh scattering](https://en.wikipedia.org/wiki/Rayleigh_scattering) and [Mie scattering](https://en.wikipedia.org/wiki/Mie_scattering) — which is exactly the problem: it wants to converge on a realistic pale-blue atmosphere and fights you if you push it toward a flat, saturated cyan-to-cream gradient. Forum users confirm it "looks so bright" and needs heavy tone-mapping/exposure tuning even for ordinary blue skies ([three.js forum](https://discourse.threejs.org/t/sky-demo-looks-so-bright/33557), [sky shader example thread](https://discourse.threejs.org/t/sky-shader-example/13653)).

**Recommendation: do not use `Sky` as the base.** Write a small custom gradient shader instead — it is ~20 lines, gives exact hex-anchored control, and matches rule #5 of the art bible ("aerial perspective is a colour lerp, not physical fog"). Reserve `Sky`'s *sun-disc* math as reference only if a glare/scattering look is wanted later; the art direction's flat, postcard luminance is opposed to physical scattering anyway.

### 1.2 Gradient construction

Use a large inverted sphere or a full-screen triangle sampling world-space view direction (cheaper — no geometry, no seams, no need to move a dome with the camera). Three bands, each a **hard-ish but anti-aliased** `smoothstep`, not a single `pow()` falloff (the art bible bans smooth painterly blur but a 1–2 px AA edge on the sky itself is fine since the sky has no silhouette to protect):

| Band | Colour | World-space control |
|---|---|---|
| Zenith | `#1ca6c7` → `#169abb` | `viewDir.y` above ~0.55 |
| Mid sky | `#4ba8c6` / `#69b2cb` | `viewDir.y` 0.15–0.55 |
| Horizon haze | `#b1cbd3` → `#d0dbdf` | `viewDir.y` −0.05–0.15, widened near the sun azimuth |
| Sun disc + glow | near-white core, warm rim | small-angle `dot(viewDir, sunDir)` power term |

```glsl
// fragment — sky dome / full-screen triangle
uniform vec3 uZenith;      // #1ca6c7
uniform vec3 uMid;         // #4ba8c6
uniform vec3 uHorizon;     // #d0dbdf
uniform vec3 uSunDir;
uniform float uSunSize;    // ~0.9985 cos-angle threshold
varying vec3 vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);
  float h = dir.y;

  // stepped-ish gradient: two smoothsteps chained, kept fairly wide so it
  // still reads as a gradient, per the postcard reference frames
  vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.28, h));
  col = mix(col, uZenith, smoothstep(0.20, 0.75, h));

  // sun disc — hard-edged core, small painted glow, no physical scattering
  float sunDot = dot(dir, normalize(uSunDir));
  float disc = smoothstep(uSunSize, uSunSize + 0.0006, sunDot);
  float glow = pow(max(sunDot, 0.0), 220.0) * 0.35;
  col += disc * vec3(1.0, 0.98, 0.9) + glow * vec3(1.0, 0.9, 0.7);

  gl_FragColor = vec4(col, 1.0);
}
```

Feed `uSunDir` from the same directional light driving `04_LIGHT.md`'s cel ramp so sky, sun disc, and terrain shading stay locked together. Starting values: `uSunSize = 0.99985` (~1° disc radius), horizon band widened toward the sun azimuth by biasing `h` with `+0.05 * max(sunDot,0)` so the haze "blooms" toward the sun as in reference frames.

Setup in Three.js — attach as `ShaderMaterial` on a `BackSide` sphere or reuse the full-screen-triangle pattern from three.js's own [`webgl_shader.html`](https://github.com/mrdoob/three.js/blob/master/examples/webgl_shader.html) example for the vertex/uniform wiring convention.

---

## 2. Stylised cumulus: four approaches, honest tradeoffs

| Approach | Look quality for this style | Perf (60fps WebGL2) | Authoring cost | Flying-through | Notes |
|---|---|---|---|---|---|
| **(a) Billboard / impostor sprite clusters** | Good — cauliflower silhouettes come straight from painted alpha textures, easiest to get *crisp* edges | Excellent; a handful of draw calls, near-zero fill cost | Low–medium: paint 8–16 cloud sprite variants once | Weak — 2D cards break down at close range/steep angles, camera clipping looks flat | Proven technique: three.js forum explicitly calls billboard clusters "the usual way," equivalent to viewpoint-oriented billboards in *Real-Time Rendering* ch. 10.6 ([discussion](https://discourse.threejs.org/t/how-do-you-use-a-shader-to-create-clouds-in-three-js/8986)) |
| **(b) Volumetric raymarched Worley/curl noise** | Best physical richness, but *hardest* to force into hard cel bands — raymarched density naturally produces soft grey gradients, which the art bible explicitly forbids | Expensive: even optimised versions run 1060-class GPUs near budget; a recent from-scratch three.js implementation reports ~60fps on a GTX 1060 but drops to ~11–20fps on other hardware without careful tuning ([three.js forum "volumetric clouds - game ready"](https://discourse.threejs.org/t/volumetric-clouds-game-ready/86598), [live demo](https://leoawen.github.io/volumetric-clouds/), [GitHub](https://github.com/leoawen/volumetric-clouds)) | High: needs baked 3D Worley textures, depth pre-pass, temporal reprojection to be affordable | Best — this is the technique's whole reason to exist | Origin: [SIGGRAPH 2015 "Real-Time Volumetric Cloudscapes of Horizon Zero Dawn"](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn) (also [80.lv writeup](https://80.lv/articles/creating-clouds-in-horizon-zero-dawn), [SlideShare deck](https://www.slideshare.net/slideshow/the-realtime-volumetric-cloudscapes-of-horizon-zero-dawn/51996465)); Sebastian Lague's [Coding Adventure: Clouds](https://www.youtube.com/watch?v=4QOcCGI6xOU) is the most-cited accessible tutorial, reproduced in a Unity Worley-noise implementation ([GitHub](https://github.com/jushii/WorleyNoise)), a Godot port ([GitHub](https://github.com/Nophlock/Godot-Cloud-Shader-Experiment)), and a detailed devlog with code ([Wedesoft](https://www.wedesoft.de/software/2023/05/03/volumetric-clouds/)) |
| **(c) Mesh / metaball "sculpted" clouds, cel-quantised lighting** | **Best match for the brief.** A real mesh silhouette (cauliflower bumps as actual geometry) plus a stepped diffuse ramp gives exactly the "sculpture, not gas" read the art bible wants | Cheap at runtime — ordinary forward-shaded triangles, shadow-castable, fits the existing gouache shader chunk from `00_ART_DIRECTION.md` §5 | Medium: author via three.js's built-in [`MarchingCubes`](https://threejs.org/docs/pages/MarchingCubes.html) addon (`addBall()` metaballs → isosurface) baked to static meshes, or hand-sculpted low-poly "cloud blobs" | Good — real geometry means real depth intersection, real per-cloud shadow-casting for §5 | This is effectively the technique documented for Ghibli-style clouds in Blender: stacked/sculpted shapes with painted gradients and hard shading, e.g. Lightning Boy Studio's breakdown ([Lesterbanks summary](https://lesterbanks.com/2020/09/2-ways-to-create-ghibli-style-clouds-in-blender/), [Gumroad file](https://lightningboystudio.gumroad.com/l/nPlSL)) and Kristof Dedene's procedural-shader variant ([80.lv writeup](https://80.lv/articles/tutorial-creating-ghibli-style-clouds-in-blender/)) |
| **(d) Hybrid** | Best overall: mesh/metaball hero clouds close to camera + billboard sprite clusters for mid/far fill + flat gradient-plane wisps at the horizon | Scales cost with screen coverage — cheapest clouds get the pixels furthest away | Highest total authoring, but each piece is individually simple | Best practical compromise | Matches how stylised flight/terrain engines actually ship: Cesium's own cloud roadmap explicitly stages billboards first, volumetric later ([GitHub issue](https://github.com/CesiumGS/cesium/issues/5962)) |

### Recommendation

**Primary: (c) mesh/metaball sculpted clouds with the shared cel-ramp shader**, LOD'd to **(a) billboard sprites** as fallback/distant fill. Reasoning:

- The art bible's non-negotiable rule #1 ("quantised diffuse ramp, 2–4 steps") is trivial on a *mesh* (you already have real normals) and unnaturally hard on a raymarched volume (you'd be quantising a continuously-varying accumulated density/transmittance value, which produces ugly banding artifacts rather than deliberate cel steps — this is a known failure mode discussed on the [TouchDesigner forum's port of a Shadertoy cloud shader](https://forum.derivative.ca/t/glsl-clouds-from-shadertoy/11858), where undersampled voxel raymarching without proper smoothing produces exactly the "quantized to a 3D grid" artifact you'd otherwise be fighting to avoid — here you *want* that quantisation, but volumetric only gives it to you by accident, not by design).
- Mesh clouds cast crisp, hard-edged real shadows for free via the standard three.js shadow pipeline — see §5. Raymarched clouds need an entirely separate shadow-mask solution anyway, so meshes remove a whole subsystem.
- Fill-rate budget: raymarching is a *full-screen* per-pixel cost that scales with sky coverage; opaque cel-shaded mesh triangles are nearly free at this game's target resolution/triangle-budget (art bible §5: ≤1.2M tris total).
- Fallback billboard sprites reuse the exact same painted-texture pipeline as trees/foliage (art bible rule #6, "silhouette over detail"), so there's no second content pipeline to build.

**Do not adopt (b) raymarched volumetric as primary.** It is the objectively most realistic technique and the correct choice for a photoreal open-world sky (Horizon Zero Dawn/Forbidden West's Nubis system — see the GDC 2022 talk on [Nubis superstorms](https://www.schneidervfx.com/) and the [Nubis Evolved ArtStation breakdown](https://andrewschneider.artstation.com/projects/RnB8Dy)) but it actively fights this project's art direction and eats the performance budget this game needs for water, islands, and the plane's cockpit-relative rendering.

---

## 3. Getting the painted look

The art bible's cloud palette is explicit: lit face `#ebedea` (near-white, warm/green-grey), shadow face `#8cbdcb`/`#9bb5a8` (shades *toward the sky's cyan*, never toward grey). Concretely:

1. **Quantised light ramp.** Compute `NdotL` per-vertex (mesh) or per-pixel (billboard, using a baked/painted "fake normal" from the sprite's alpha silhouette). Feed through a **3-step ramp texture** (1×N `LinearFilter`-off `Texture`, `magFilter: NearestFilter`) rather than smoothstep math, so art can hand-tune the exact step colours and widths without touching shader code:

```glsl
uniform sampler2D uRamp;       // 1D ramp baked as 1xN texture, nearest-filtered
uniform vec3 uSkyZenith;       // #1ca6c7 — shadow tint target
float ndl = dot(normal, sunDir) * 0.5 + 0.5;
vec3 ramp = texture2D(uRamp, vec2(ndl, 0.5)).rgb;
// bias the shadow band toward sky cyan instead of pure grey/black
vec3 shaded = mix(uSkyZenith, ramp, 0.55);
```

2. **Cyan-tinted shadow, near-white lit face.** Ramp stops (starting values): shadow `#8cbdcb`, mid `#c9dbdb`, lit `#ebedea`, with a 4th optional hot rim stop `#fdfdf5`. Step edges at `ndl` ≈ 0.35 and 0.72 — keep them slightly soft (1–2% falloff) only on this asset class, since clouds are the one surface in the reference frames without a razor silhouette edge on the *lighting* (the geometric silhouette itself must still be crisp).

3. **Crisp cauliflower silhouette, no soft grey mush.** This is a geometry/alpha problem, not a shading problem: sculpt lobed, bumpy mesh silhouettes (metaball union of 6–14 balls per cloud, per §2c) or paint sprite alpha with hard, non-blurred cutouts. Never rely on a soft alpha falloff to "hide" a bad silhouette — that is exactly the "grey mush" the art bible bans.

4. **Powder/sugar edge.** A thin (~2–4 px screen-space) near-white fringe where the silhouette meets sky, mimicking the reference's crystalline cloud edges. Cheapest implementation: fresnel-style rim term added only in the lit hemisphere —

```glsl
float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
rim *= step(0.0, dot(normal, sunDir)); // only on the lit side
shaded += rim * 0.25 * vec3(1.0, 1.0, 0.98);
```

5. **Rim light.** Same fresnel term, but sun-facing side only, pushed further and kept as a *discrete* value (art bible rule #4: "discrete highlights... never a Blinn-Phong lobe") — quantise `rim` through a `step()` rather than leaving it continuous.

---

## 4. Flying through / past clouds

| Device | Technique | Starting values |
|---|---|---|
| Soft depth fade near camera | Sample scene depth, fade cloud alpha where `sceneDepth − cloudDepth < threshold`, exactly the depth-intersection trick documented in the Unity [Cloud Shader Breakdown](https://www.cyanilux.com/tutorials/cloud-shader-breakdown/) (subtract object depth from scene depth, multiply into alpha) | Fade band 2–6 world units |
| Camera intersection (mesh clouds) | Render cloud mesh **double-sided**, disable depth-write only for the innermost few metres so camera can pass through without a hard pop | `polygonOffset` or a small `near`-side alpha ramp on the vertex shader using camera-relative distance |
| Parallax layering | 2–3 discrete altitude bands (e.g. 600m, 900m, 1300m) moving at different scroll/drift speeds; cheap, sells scale without any per-pixel 3D lookup | Speed ratio ~1 : 0.6 : 0.35 back to front |
| Cheap godrays / shafts | Screen-space radial blur from a masked bright-source pass — the classic [GPU Gems 3, Ch.13 "Volumetric Light Scattering as a Post-Process"](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process) technique; the "volumetric clouds - game ready" three.js project implements exactly this as an occlusion-mask + radial-blur composite pass ([forum thread](https://discourse.threejs.org/t/volumetric-clouds-game-ready/86598)) | Sample count 16–32, decay 0.94–0.97, exposure 0.25–0.4 |

For a stepped/cel game this shaft pass should stay **subtle and rare** (only near-sun, only through cloud gaps) — it is a mood accent, not a simulation.

---

## 5. Cloud shadows on the sea and islands

This is called out as a key mood device and it is genuinely cheap. Three independently-verified patterns, in order of recommended simplicity:

1. **Scrolling projected-texture mask (recommended).** Render (or hand-paint) a top-down grayscale/alpha cloud-coverage texture; scroll its UV offset over time in world space; sample it from every terrain/water shader and multiply into the lit-band colour before quantising. This is the exact approach used for cloud shadows on Earth-globe demos and confirmed idiomatic in three.js via `onBeforeCompile` injection:

```glsl
// injected into terrain/water fragment shader
uniform sampler2D uCloudShadowTex;   // scrolling coverage mask, R channel
uniform vec2 uCloudShadowOffset;     // += windDir * time each frame
uniform float uCloudShadowStrength;  // 0.35–0.5 start

vec2 shadowUV = vWorldPos.xz * 0.0025 + uCloudShadowOffset;
float cloudMask = texture2D(uCloudShadowTex, shadowUV).r;
diffuseColor.rgb *= mix(1.0, 1.0 - uCloudShadowStrength, cloudMask);
```
   This mirrors the pattern documented on the three.js forum for planet cloud-shadow shaders (`diffuseColor.rgb *= max(1.0 - texture(tClouds, vUv).a, 0.2)` injected via `onBeforeCompile`) ([three.js forum, "cast shadows from outer sphere to inner sphere"](https://discourse.threejs.org/t/how-to-cast-shadows-from-an-outer-sphere-to-an-inner-sphere/53732)) and a full worked Earth/clouds tutorial using the identical negative-lightmap approach ([Medium — "Make Your Own Earth in Three.js"](https://franky-arkon-digital.medium.com/make-your-own-earth-in-three-js-8b875e281b1e)).

2. **Render-to-texture top-down cloud pass**, if clouds are true 3D meshes rather than a painted mask: a second orthographic camera above the world renders only cloud silhouettes to a small render target (black=shadow, white=clear), which is then sampled exactly as in (1). This is the documented Unity URP pattern ([Unity Discussions, "Cloud Shadows in URP"](https://discussions.unity.com/t/cloud-shadows-in-urp/840459)) and generalises directly to three.js with a `WebGLRenderTarget` + orthographic `Camera`.

3. **Keep it a hard-edged, hue-shifted patch, not a soft multiply.** Per art bible rule #3 ("hard shadow edges, soft shadow interiors") and rule #2 ("shadow tones are hue-shifted, never just darker") — do **not** simply darken the sea/island colour by the cloud mask. Instead **swap toward the existing shadow-ramp step** (sea shadow → `#012438`/`#02365b`, already hue-shifted violet-navy per the art bible) using the cloud mask as the *step selector*, with a sharpened (`smoothstep(0.4, 0.5, cloudMask)`) transition rather than a soft lerp, so a cloud shadow crossing the water reads as a discrete travelling shape — the same storytelling device the art bible calls out for the aircraft's own shadow.

Numeric starting point: shadow-mask scroll speed ≈ wind vector × 0.6 (slower than the visible cloud layer itself, since shadows read as "denser" cloud mass); mask texture resolution 512–1024 px tiled over a ~4–8 km world-space area; strength 0.35–0.5 multiplier so shadowed sea still reads as sea, never black.

---

## 6. Performance

| Technique | Purpose | Notes / starting values |
|---|---|---|
| Resolution scaling | Keep raymarched/fallback elements affordable | Render sky+distant cloud layer at 0.5–0.75× canvas resolution, upsample with a bilinear or edge-aware blit; three.js: separate `WebGLRenderTarget` sized to `renderer.getSize()*scale` |
| Half-res + upsample | Standard for any per-pixel volumetric fallback effect (godrays, distant billboard soft-blend) | Matches the documented Horizon Zero Dawn approach of a quarter-res buffer reconstructed over multiple frames ([SIGGRAPH 2015 talk](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn)) |
| Temporal reprojection / blue noise | Only relevant if any raymarched fallback (godray shafts, optional hero-cloud volumetric accent) is used | Offset raymarch start by blue-noise per-pixel jitter, accumulate via camera-motion-vector reprojection; concretely documented with code in [Maxime Heckel's "Real-time dreamy Cloudscapes with Volumetric Raymarching"](https://blog.maximeheckel.com/posts/real-time-cloudscapes-with-volumetric-raymarching/) and the classic ["Fast High-Quality Cloudscape through Noise and Reprojection"](https://handmade.network/p/75/monter/blog/p/7201-engine_optimization__fast_high-quality_cloudscape_through_noise_and_reprojection) writeup (10× speedup, ~3ms) |
| Draw-call / fill-rate budget | Stay inside the art bible's ≤40 draw calls for terrain-class content | Mesh clouds: instance repeated metaball-blob prefabs via `InstancedMesh`; billboard fallback layer: one merged geometry + one texture atlas = 1 draw call for the entire far cloud field |
| Mobile fallback | WebGL2 required features (3D textures for Worley baking, `EXT_color_buffer_float` for HDR passes) are inconsistent on mobile GPUs | Ship tier: mesh clouds + static painted sky gradient, no godray pass, no temporal reprojection, cloud-shadow mask at 256px. Detect via `renderer.capabilities.isWebGL2` and a simple GPU-tier heuristic (frame-time probe on first 2s) |

Overall budget target inherited from `00_ART_DIRECTION.md`: sky + clouds should be a rounding error against the 1.2M triangle / 40 draw-call terrain budget — clouds are meshes/sprites, not a second renderer.

---

## 7. Three.js code sketches & authoring checklist

### 7.1 Sky dome setup

```js
import * as THREE from 'three';

const skyUniforms = {
  uZenith:  { value: new THREE.Color('#1ca6c7') },
  uMid:     { value: new THREE.Color('#4ba8c6') },
  uHorizon: { value: new THREE.Color('#d0dbdf') },
  uSunDir:  { value: new THREE.Vector3(0.4, 0.6, 0.2).normalize() },
  uSunSize: { value: 0.99985 },
};

const skyMat = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  vertexShader: skyVert,     // passes vWorldDir = normalize(worldPosition - cameraPosition)
  fragmentShader: skyFrag,   // §1.2 above
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 24, 12), skyMat);
scene.add(sky);
```

### 7.2 Cel-ramp cloud material (shared chunk)

```js
const rampTex = new THREE.DataTexture(rampPixels, 4, 1, THREE.RGBAFormat);
rampTex.magFilter = THREE.NearestFilter;
rampTex.needsUpdate = true;

const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
cloudMat.onBeforeCompile = (shader) => {
  shader.uniforms.uRamp = { value: rampTex };
  shader.uniforms.uSkyZenith = { value: new THREE.Color('#1ca6c7') };
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform sampler2D uRamp;\nuniform vec3 uSkyZenith;`)
    .replace('#include <lights_fragment_begin>', /* inject quantised ramp lookup, §3 */ '');
  cloudMat.userData.shader = shader;
};
```

### 7.3 Metaball-sculpted cloud authoring (offline bake)

```js
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';

const mc = new MarchingCubes(48, cloudMat, true, true, 65000);
mc.reset();
// 6–14 lumps per cloud, irregular offsets/strengths for a non-spherical cauliflower silhouette
for (const b of cloudBallLayout) mc.addBall(b.x, b.y, b.z, b.strength, b.subtract);
// bake to static BufferGeometry once, then discard the MarchingCubes instance —
// do NOT keep runtime marching cubes live per-cloud at 60fps.
```

### 7.4 Cloud shadow mask uniform wiring (terrain + water shared)

```js
function updateCloudShadow(dt, windDir) {
  cloudShadowOffset.addScaledVector(windDir, dt * 0.6);
  terrainMat.uniforms.uCloudShadowOffset.value.copy(cloudShadowOffset);
  waterMat.uniforms.uCloudShadowOffset.value.copy(cloudShadowOffset);
}
```

### Starting numeric parameters (single reference table)

| Parameter | Starting value |
|---|---|
| Sun disc angular radius | ~1° (`uSunSize = 0.99985`) |
| Cloud ramp steps | 3 colour stops + 1 optional rim stop |
| Ramp step edges (`ndl`) | 0.35, 0.72 |
| Rim/fresnel power | 3.0, quantised via `step()` |
| Cloud altitude bands (parallax) | 600m / 900m / 1300m |
| Parallax speed ratio | 1 : 0.6 : 0.35 |
| Cloud shadow mask tile scale | 512–1024px over 4–8km |
| Cloud shadow strength | 0.35–0.5 |
| Cloud shadow scroll speed | wind vector × 0.6 |
| Godray sample count | 16–32, decay 0.94–0.97 |
| Half-res buffer scale | 0.5–0.75× |
| Metaballs per cloud cluster | 6–14 |
| Terrain/cloud draw-call budget | ≤40 shared total (art bible §5) |

### Authoring checklist

- [ ] Sky gradient sampled directly against the six reference frames' zenith/horizon hexes — no physically-simulated blue allowed to creep back in.
- [ ] Every cloud asset passes the "silhouette test": screenshot at low res, silhouette alone must read as a lobed cauliflower shape, never an oval blob.
- [ ] Shadow-side colour sampled and confirmed hue-shifted toward sky cyan, never a straight value-multiply of the lit colour.
- [ ] No continuous Blinn-Phong specular anywhere on cloud material — rim/highlight terms pass through a `step()`/ramp texture.
- [ ] Cloud shadow mask tested scrolling across both sea *and* island terrain shaders from the same uniform source, edges sharpened not blurred.
- [ ] Frame-time budget check: sky+clouds+cloud-shadow pass profiled in isolation, confirmed to leave headroom inside the 1.2M tri / 40 draw-call terrain budget.
- [ ] Mobile/low-tier fallback verified: static gradient sky, mesh-only clouds, no godray pass, 256px shadow mask.
- [ ] Camera-through-cloud pass tested at flight speed for popping/hard depth-cut artifacts; soft depth fade band tuned (2–6 units).

---

## 8. Prior art: has anyone shipped Ghibli-style clouds in three.js?

Direct hits are sparse — nobody has published a complete "Porco Rosso sky" three.js project — but the adjacent pieces all exist and are worth studying directly:

- **[craftzdog/ghibli-style-shader](https://github.com/craftzdog/ghibli-style-shader)** — a real, public three.js/React-Three-Fiber repo explicitly building "Ghibli-styled" shading (a stepped-toon tree shader), confirming the cel/gouache approach this doc recommends is both feasible and has working prior code in the three.js ecosystem, though its current published scope is trees, not clouds/sky specifically.
- **[three.js forum: "volumetric clouds - game ready"](https://discourse.threejs.org/t/volumetric-clouds-game-ready/86598)** ([live demo](https://leoawen.github.io/volumetric-clouds/), [GitHub](https://github.com/leoawen/volumetric-clouds)) — a complete, self-contained three.js raymarched Worley-noise cloud implementation with depth occlusion and godrays; realistic rather than stylised, but the single-file structure and uniform layout are directly reusable as the "fallback volumetric accent" mentioned in §2/§4 if the project ever wants a hero-shot volumetric moment.
- **[three.js forum: "Complete Sky System for Three.js"](https://discourse.threejs.org/t/complete-sky-system-for-three-js-skybox-sun-moon-day-night-cycle-clouds-stars-lensflares/88311)** — a day/night skybox system explicitly built around procedural scrolling cloud layers with sun-angle tinting, closer in spirit (performance-first, layered, non-volumetric) to the hybrid recommendation in §2.
- **Ghibli-style cloud *shading logic* (not three.js, but directly portable GLSL/shader-graph logic)**: Lightning Boy Studio's stacked-plane Blender technique ([Lesterbanks](https://lesterbanks.com/2020/09/2-ways-to-create-ghibli-style-clouds-in-blender/), [Gumroad download](https://lightningboystudio.gumroad.com/l/nPlSL)) and Kristof Dedene's procedural node-graph clouds ([80.lv](https://80.lv/articles/tutorial-creating-ghibli-style-clouds-in-blender/)) are the closest published breakdowns of the exact "sculpted, hard-lit, painted-gradient" look this brief wants — both are authoring-side (Blender/EEVEE) rather than runtime WebGL, but their lighting logic (stepped gradients driven by empties/gradient textures rather than Lambert falloff) maps directly onto the ramp-texture approach in §3.

**Conclusion:** the *rendering techniques* (mesh/metaball clouds, cel ramps, projected shadow masks, billboard fallbacks) are all independently well-documented and proven in three.js/WebGL contexts; the *specific fusion* of Ghibli-grade painterly cloud shading with three.js has prior art only in adjacent pieces (toon shading repo + Blender authoring breakdowns + generic volumetric/skybox three.js projects), not as a single shipped reference. This is a genuine (if modest) implementation gap this project would be filling, not reinventing.
