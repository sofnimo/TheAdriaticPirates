# 02 — Open-Sea Water
### Implementation research for the Adriatic seaplane world · obeys `00_ART_DIRECTION.md`

This doc covers the **open sea seen from 200–1500 m** (coastal shoreline foam/break waves are `02b_COASTAL_WAVES.md`). Every colour, edge-hardness, and highlight rule below is inherited from the art bible: **hard-edged painted dashes for highlights, hue-shifted shadows, and a visible band-edge (not a blur) at the shelf transition** (`00_ART_DIRECTION.md`, §2–3).

---

## 0. What three.js gives you vs what you must build

| Capability | Stock three.js | Custom work needed |
|---|---|---|
| Basic animated water plane with reflection/refraction RTTs, Sun specular | [`Water`](https://threejs.org/docs/pages/Water.html) addon ([source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/objects/Water.js), used in [`webgl_shaders_ocean`](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_shaders_ocean.html)) | Everything about the Ghibli look — it outputs a Blinn-Phong specular sheen and smooth normal-map ripples, exactly the "specular blob" the art bible forbids (§3.4) |
| Still, non-repeating water with box-projected local reflections | [`Water2`](https://threejs.org/docs/pages/Water2.html) — good for pools/harbours, [documented as unsuited to ocean scale](https://github.com/mrdoob/three.js/issues/17251) | Not usable at horizon scale |
| GPU heightfield ripple simulation via ping-pong render targets | [`GPUComputationRenderer`](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_water.html) (WebGL) and its WebGPU/TSL successor [`webgpu_compute_water`](https://fossies.org/linux/three.js/examples/webgpu_compute_water.html) | Reusable directly for the **taxi-ripple / wake buffer** (§5), not for the open-sea macro swell |
| Shader injection into a built-in material | `Material.onBeforeCompile` ([added in #11475](https://github.com/mrdoob/three.js/issues/11475), [chunk list](https://github.com/mrdoob/three.js/tree/dev/src/renderers/shaders/ShaderChunk)) | This is the mechanism you use for almost everything below — depth-band colour ramp, Gerstner displacement, glint field |
| Sky + Fresnel-only cheap environment | [`Sky`](https://threejs.org/docs/) addon (procedural Preetham sky, used alongside `Water` in the ocean example) | Re-tint to the bible's cyan zenith (`#1ca6c7`) instead of physical Rayleigh blue |
| Fast Fourier ocean spectrum, tessellation, LOD terrain quadtree | **Nothing built in** | All bespoke: Gerstner sum (below), a hand-rolled projected-grid or CDLOD mesh, and the colour/glint/foam shaders |

**Takeaway:** three.js's own `Water`/`Water2` are the wrong base — they're built for photoreal specular water. Use a **custom `ShaderMaterial`** (or `onBeforeCompile` on `MeshBasicMaterial`, keeping lighting fully authored rather than PBR), reusing three.js's own GPU-displacement and shader-injection patterns.

---

## 1. Geometry & displacement

### 1.1 Flat plane + shader vs. displaced grid

A **flat, undisplaced plane with all wave motion baked into the fragment shader (normal only, no vertex displacement)** is the classic cheap-ocean trick and is right for most of this game's view range. At 200–1500 m looking down at 20–45°, wave silhouettes are sub-pixel; what reads is **colour banding and glint placement**, both fragment jobs. Reserve real vertex displacement for the **near field around the plane** (floats, wake, taxi ripples — §5), and use the Gerstner analytic normal purely to feed the stepped diffuse ramp (art bible §3.1) even where geometry stays flat.

### 1.2 Mesh strategy for an open sea to the horizon

Three approaches, in order of how well they suit this project:

| Technique | Idea | Fit here |
|---|---|---|
| **Projected grid** ([Johanson 2004 thesis via TU Wien writeup](https://repositum.tuwien.at/bitstream/20.500.12708/7037/2/Gamper%20Thomas%20-%202018%20-%20Ocean%20surface%20generation%20and%20rendering.pdf), [classic write-up](http://habib.wikidot.com/projected-grid-ocean)) | A uniform grid is built in post-perspective (screen) space, unprojected onto the water plane, then displaced. Density is automatically high near the camera and thins toward the horizon because that's how perspective distorts a screen-space grid. | **Best fit for a flight game.** The camera is always high and looking down/forward at a wide range of pitches — exactly the case projected grids were designed for. No quadtree bookkeeping. |
| **CDLOD-style quadtree of nested rings** ([Strugar 2010, "Continuous Distance-Dependent LOD for Rendering Heightmaps"](https://aggrobird.com/files/cdlod_latest.pdf), [source & demos](https://github.com/fstrugar/CDLOD)) | Concentric, doubling-resolution square rings around the camera XZ position, morphed by 3D camera distance to hide LOD pops. | Good, well-documented alternative; more code (quadtree selection, vertex morphing) than a projected grid needs for water specifically, but is the standard choice if you already have a CDLOD terrain system for islands (`03_ISLANDS.md`) and want to reuse the same rig for the sea plane. |
| **Simple concentric ring meshes recentred each frame** (cheapest) | 3–5 flat annuli of decreasing density, `PlaneGeometry`-derived, snapped to camera XZ every frame so they never need re-tessellation. | Cheapest to implement in three.js with stock `BufferGeometry`; acceptable given that at altitude the mesh silhouette barely matters (see §1.1) — **recommended starting point**, upgrade to projected grid only if geometry popping becomes visible during descent/landing. |

**Recommendation:** ship the concentric-ring approach first; keep projected-grid math in reserve for the landing/taxi camera where horizon-to-near-field density gradients matter more.

### 1.3 Gerstner wave stack

Gerstner (trochoidal) waves displace vertices laterally toward the crest as well as vertically, giving the peaked-trough asymmetry real seas have; the canonical reference is **GPU Gems 1, Chapter 1, "Effective Water Simulation from Physical Models"** ([NVIDIA](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models)). Per-wave steepness \(Q_i\) is bounded by \(\sum Q_i w_i A_i \le 1\) to avoid the crest "looping over" — GPU Gems recommends artist steepness \(Q\in[0,1]\) distributed as \(Q_i = Q / (w_i A_i \cdot \text{numWaves})\). Dispersion (`ω = √(g·k)`, `g = 9.8 m/s²`) ties speed to wavelength. A compact reference implementation (`dir, wavelength, amplitude` uniforms) is this public [Gerstner Shadertoy port](https://oneshader.net/shader/c5d53c66fc). Since silhouette barely shows at altitude, **4 waves is enough** (vs. FFT's dozens) — a deliberate downgrade from "physically complete" to "reads correctly from a plane."

Concrete per-sea-state tables (world units in metres, angles in degrees clockwise from north, wavelengths chosen so wave 1 dominates silhouette and waves 3–4 only perturb the normal for glint sparkle):

**Calm (harbour mornings, art-bible "negative space" shots):**

| Wave | Amplitude (m) | Wavelength (m) | Direction (°) | Steepness Q |
|---|---|---|---|---|
| 1 | 0.06 | 40 | 200 | 0.35 |
| 2 | 0.03 | 22 | 235 | 0.30 |
| 3 | 0.015 | 9 | 170 | 0.25 |
| 4 | 0.008 | 4 | 260 | 0.20 |

**Breeze (typical patrol / cruise state):**

| Wave | Amplitude (m) | Wavelength (m) | Direction (°) | Steepness Q |
|---|---|---|---|---|
| 1 | 0.35 | 70 | 210 | 0.55 |
| 2 | 0.18 | 38 | 240 | 0.50 |
| 3 | 0.08 | 16 | 190 | 0.40 |
| 4 | 0.04 | 7 | 260 | 0.30 |

**Bora wind (storm set-piece, torn cloud per art bible §4):**

| Wave | Amplitude (m) | Wavelength (m) | Direction (°) | Steepness Q |
|---|---|---|---|---|
| 1 | 1.1 | 120 | 20 | 0.75 |
| 2 | 0.55 | 65 | 40 | 0.65 |
| 3 | 0.25 | 28 | 5 | 0.55 |
| 4 | 0.12 | 12 | 55 | 0.45 |

Interpolate all four rows linearly (amplitude, wavelength, Q) by a single `uSeaState` uniform ∈ [0,1,2] so wind gusts can drive a smooth transition; direction should rotate toward true wind heading rather than lerp naively (use shortest-angle interpolation).

### 1.4 FFT/Tessendorf — noted, not chosen

The physically-correct alternative is **Tessendorf's statistical ocean spectrum with inverse FFT** ("Simulating Ocean Water," summarized in the [ARM GPU FFT ocean writeup](https://arm-software.github.io/opengl-es-sdk-for-android/ocean_f_f_t.html) and [NVIDIA's DirectX Compute ocean slides](https://developer.download.nvidia.com/assets/gamedev/files/sdk/11/OceanCS_Slides.pdf)). **Sea of Thieves ships exactly this** (§Prior art) and layers hand-authored stylisation on top. For our game FFT is the "more budget" path: it buys broadband natural chop, but our chop is already sub-pixel from altitude and highlights are hand-authored dashes, not a normal map. **Gerstner-only is the right call**; keep FFT as the upgrade path if a ground-level mode is ever added.

---

## 2. Depth-driven colour

### 2.1 Driving signal

Sample a **baked bathymetry/depth texture** (grayscale height-below-sea-level, authored alongside the island heightmaps in `03_ISLANDS.md`, or generated once from the terrain SDF) rather than the live GPU depth buffer — a baked map is stable at any camera angle/altitude and doesn't shimmer as the camera pitches, which the live scene depth buffer would (its precision and edge behaviour changes with view frustum). Store bathymetry as a top-down orthographic depth render of the terrain, sampled by the water fragment shader with the same world-space UV as the terrain tile grid.

```glsl
uniform sampler2D uBathymetry;   // R channel: 0 = shoreline, 1 = abyssal
uniform vec2 uBathyOrigin;       // world-space UV origin
uniform float uBathyScale;       // world units per UV unit
float depth01 = texture2D(uBathymetry, (vWorldPos.xz - uBathyOrigin) / uBathyScale).r;
```

### 2.2 Stepped ramp, not a lerp

Art bible §1 and §3.1 are explicit: **stepped tonal bands, not Lambert-style smooth falloff**, and the shelf transition (§2, "the most important colour event in the game") crosses from teal to turquoise to sand-cream in ~40 px as a **hard band edge**. A smooth `mix()` across depth reads as generic PBR water; a quantised ramp reads as gouache. Use 3–5 discrete bands with a **noise-perturbed threshold** so the edge is a lively hand-drawn line rather than a mathematically perfect contour (a perfect contour is the opposite failure mode — it reads as a level-set diagram, not a painting).

```glsl
// palette from 00_ART_DIRECTION.md §2, exact hexes
uniform vec3 cAbyssal;   // #0c3273
uniform vec3 cDeep;      // #024892
uniform vec3 cMidChop;   // #014575
uniform vec3 cShelf;     // #14707c
uniform vec3 cShallow;   // #309dac
uniform sampler2D uEdgeNoise;   // low-freq tileable value noise, ~2 octaves

float bandedDepth(float depth01, vec2 uv){
  float n = (texture2D(uEdgeNoise, uv * 0.08).r - 0.5) * 0.06; // +/-6% jitter on the threshold only
  float d = clamp(depth01 + n, 0.0, 1.0);
  // 4 hard steps: shallow / shelf / mid / deep-abyssal
  float band = floor(d * 4.0) / 4.0;
  return band;
}

vec3 seaColor(float band){
  if (band < 0.26) return cShallow;
  else if (band < 0.51) return cShelf;
  else if (band < 0.76) return cMidChop;
  else return mix(cDeep, cAbyssal, smoothstep(0.76, 1.0, band)); // deepest 2 bands may keep one soft internal lerp, edge itself stays hard
}
```

The important trick is that **the noise perturbs the threshold field, not the output colour** — the edge stays a crisp 1–2 px transition (`floor()` guarantees this) but its path wobbles with the noise so it doesn't look vector-traced. This is the standard "noise-before-step" technique used across stylised-water shaders, e.g. the flow-mapped, `Step`-thresholded foam/depth blends documented in [Daniel Ilett's Wind-Waker-style Shader-Graph breakdown](https://danielilett.com/2020-04-05-tut5-3-urp-stylised-water/) — same idea, GLSL instead of Shader Graph nodes.

### 2.3 Sea-in-shadow as a hard patch

Per art-bible §2, cloud-shadowed sea (`#012438`/`#02365b`) is **a hard-edged patch overlay**, not a soft darkening — implement it as a second, independent step function driven by the cloud-shadow mask (see `01_SKY_AND_CLOUDS.md`/`04_LIGHT.md`) multiplying in *after* the depth bands, using `step()` against the shadow mask, never `mix()`.

### 2.4 Caustic-free shallow read-through

Real shallow water shows dancing caustic light on the sand; the art bible's flat gouache style forbids that kind of high-frequency texture (§3.7, "no visible noise... variation at the shape scale"). Fake the "sandy shallow" read by:
1. Blending the **shallow band colour** (`#309dac`/`#62afb4`) toward the sand hue itself (`#cbc5ad`→`#ddd0a8` from land palette) only in the very shallowest 1 band, using the same hard step — this reads as "you can see the bottom" without simulating light transport.
2. **No caustic texture at all.** Real-time caustics (projected light-grid textures, refraction caustics) are a photoreal cue the reference frames never show; omitting them is a deliberate, art-directed simplification, not a shortcut.

---

## 3. The painted glints (procedural dash/streak highlights)

Art bible §2/§3.4: highlights are **discrete dashes/ovals/slashes, hard-edged, elongated along swell direction, only 3–6% of sea pixels** — never a Blinn-Phong specular lobe.

### 3.1 Generation

1. Compute a **swell-aligned UV**: rotate world-space `vWorldPos.xz` into the dominant wave's direction (`uSwellDir` from §1.3's wave 1) so noise cells stretch along the swell axis rather than being isotropic.
2. Feed that into a **cellular/Worley or blue-noise field**, thresholded hard (`step`, not `smoothstep`) against a coverage uniform tuned to the 3–6% target.
3. **Stretch each cell** anisotropically along swell direction before thresholding (scale UV.x by ~4–6× relative to UV.y in swell-local space) so the surviving blobs are elongated ovals, not round dots — this single step is what turns "noise blob" into "painted glint."
4. Modulate coverage/threshold by the **Gerstner analytic slope** (dot of the perturbed normal with view+light half-vector) so glints cluster on wave faces tilted toward the sun, not uniformly — cheap Fresnel-esque gating without ever evaluating a specular lobe.

```glsl
uniform vec2 uSwellDir;      // normalized, from wave 1
uniform float uGlintCoverage; // ~0.045
uniform float uTime;

vec2 swellUV(vec2 worldXZ){
  vec2 d = normalize(uSwellDir);
  vec2 perp = vec2(-d.y, d.x);
  float along = dot(worldXZ, d) * 0.14;      // compress along swell = long ovals
  float across = dot(worldXZ, perp) * 0.9;   // keep tight across swell
  return vec2(along, across) + uTime * 0.02 * d; // drift with swell, slow
}

float glintMask(vec2 worldXZ, float facing /*0..1 toward-sun term*/){
  vec2 uv = swellUV(worldXZ);
  float cell = hash2(floor(uv * 6.0)); // cheap value-noise cell id, or Worley F1
  float threshold = 1.0 - uGlintCoverage * mix(0.4, 1.6, facing);
  return step(threshold, cell); // hard 0/1 — no smoothstep, per art bible §3.4
}
```

### 3.2 Screen-space stability at altitude & anti-aliasing

At 200–1500 m, world-space glint cells are far smaller than a screen pixel — this is exactly the aliasing regime that makes point-sampled noise fields sparkle/boil frame to frame. Mitigations, cheapest first:
- **Mip-bias the noise texture lookup** (or use a pre-filtered/mipped Worley texture) and bias its LOD by camera altitude so distant/high-altitude glints fade into a flat coverage-density colour instead of flickering — this is the standard "detail fade" also used for terrain texture at distance (see §6).
- **Screen-space-derivative clamp**: compute `fwidth(uv)` and skip (return 0) any glint cell whose footprint is smaller than ~0.75 px, rather than letting it alias in and out. This keeps the *coverage percentage* honest while removing sub-pixel flicker.
- Because glints are meant to be static "painted marks" rather than physically accurate specular sparkle, it's acceptable (and cheaper) to **fade the whole glint layer out above a tuned altitude threshold** (e.g. >900 m) and replace it with a flat "wave-crest tint" band added to the colour ramp in §2 — this matches how the reference frames at high altitude (frame 1, "70% uninterrupted flat sea") show almost no discrete sparkle, only the deep colour and a few soft streaks.
- Keep the glint layer **out of TAA's jitter path** if TAA is enabled (see §6) — hard-edged single-frame-stable procedural marks fight temporal jitter, which will visibly soften their edges.

---

## 4. Reflection & sky

### 4.1 Cheap sky-cubemap Fresnel (recommended default)

Bake or procedurally generate a **static sky cubemap** matching the art bible's cyan gradient (`#1ca6c7` zenith → `#b1cbd3` horizon haze), and blend it into the sea colour with a **Schlick Fresnel term** raised to a low power so the reflection strengthens only at grazing angles near the horizon line (where the reference frames do show a pale horizon band on the water):

```glsl
uniform samplerCube uSkyCube;
float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
vec3 skyRefl = textureCube(uSkyCube, reflect(-V, N)).rgb;
vec3 seaWithSky = mix(rampColor, skyRefl, fresnel * 0.35); // cap contribution; sea colour must stay dominant per art bible §10 (negative space)
```

This is deliberately the **same family of technique three.js's own `Water` shader uses for its sky term**, minus the dynamic mirror/refraction render targets — see the addon's [documented options](https://threejs.org/docs/pages/Water.html) (`sunColor`, `waterColor`, reflection RTT) for what to strip out.

### 4.2 Why SSR / planar reflection is (probably) wrong here

- **Planar reflection RTT** (what `Water.js` does) renders the whole scene a second time from a mirrored camera — for an aerial flight game with 1.2M-triangle terrain budgets already (art bible §5 perf table), that's roughly doubling draw calls for a payoff (sharp mirror reflections of clouds/islands) that the reference frames don't show: frame 1 and 5 read as flat luminous colour fields, not mirrors.
- **Screen-space reflection** amplifies exactly the wrong thing for this style — SSR is a photoreal technique that produces soft, view-dependent gradients, which directly fights the "hard-edged dash, not a gradient" rule (§3.4). SSR also fails/streaks at the silhouette edges of thin objects (mast lines, plane floats) typical of this scene.
- The one place a **real mirror reflection is worth its cost** is the **plane's own shadow and a tight cloud-glow patch near the sun position** — both can be faked far more cheaply as a screen-space sun-glow sprite / bloom-threshold hit (§4.3) than as SSR.

### 4.3 Sun glitter path

Reserve "real" specular for a **single, tight sun-glitter hotspot**: compute the classic Blinn-Phong half-vector term but pipe it through a **hard step + bloom threshold** instead of outputting the lobe directly, so it resolves as one or two bright dashes near the sun's reflection point rather than a soft highlight disc — consistent with §3.4's "never a Blinn-Phong lobe" rule (the lobe is only used as an intermediate mask, the final visible mark is a stepped dash fed into the bloom pass described in the art bible's post-chain, §5).

---

## 5. Seaplane interaction — wakes, spray, taxi ripples

### 5.1 Render-target ripple/wake buffer

Use a **top-down orthographic render target following the plane** (or a fixed-size camera-relative "wake canvas") updated each frame with a ping-pong pair of textures — the same GPU-heightfield-simulation pattern three.js's own GPGPU examples use ([`webgl_gpgpu_water`](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_water.html), TSL/WebGPU version in [`webgpu_compute_water`](https://fossies.org/linux/three.js/examples/webgpu_compute_water.html)) or the raycast-driven displacement approach in [this GLTF water-trail writeup](https://www.thefrontdev.co.uk/creating-water-trails-with-vertex-displacement-on-a-gltf-model/):

1. Each frame, splat a soft circular/oval impulse at the float-water contact point(s) (2 floats + tail step for a seaplane) into an **accumulation buffer A** (RG: displacement, foam-intensity).
2. Advect/decay buffer A into buffer B with a damping factor (`viscosity` uniform, ~0.96–0.98 per frame as used in the official example) and a slight directional bias along the plane's velocity to stretch impulses into a wake trail rather than circular ripples.
3. Sample buffer B in the main water fragment shader (same UV-remap trick as bathymetry in §2.1) to (a) displace the near-field vertices slightly and (b) inject a **hard-edged white foam step** wherever accumulated intensity exceeds a threshold — again `step()`, never `smoothstep()`, to match the painted-dash rule.

### 5.2 Foam accumulation

Keep foam **in the same buffer's alpha/second channel** rather than a separate simulation: intensity increases on splat, decays exponentially, and is read back as a **quantised 2-step foam mask** (present / absent, maybe one "fading" mid-step) rather than a continuous alpha gradient, again for stylistic consistency with §3.1's "at most one rim/highlight tone" rule.

### 5.3 Floats-touching-water & taxi ripples

- Drive the splat position/strength from the **plane's physics floats' Y-penetration below the analytic Gerstner surface height** — sample the same wave-height function used for §1.3 at the float's XZ position (CPU-side or a 1×1 render-target readback) to know exactly how deep each float sits, which also feeds the flight model's buoyancy.
- Emit **taxi ripples** (concentric, high-frequency, fast-decaying) at low speed / idle, and **V-shaped wake + spray dashes** at speed — the transition can just be a velocity-thresholded lerp of splat radius/shape, no separate system needed.
- Spray droplets (the "kicked up water" during takeoff run) are best done as a tiny **GPU-instanced billboard particle burst** (`InstancedMesh` with a point-sprite shader) rather than trying to extend the height-field shader to represent airborne droplets — keep the two systems (surface buffer vs. particles) decoupled.

---

## 6. Performance

### 6.1 LOD & triangle budget

- Concentric-ring or CDLOD water mesh should sit well inside the art bible's **"ocean + sky + 3 visible islands ≤ 1.2M triangles, ≤ 40 draw calls for terrain"** ceiling (§5) — budget roughly **150–300k triangles for the entire visible sea** (it's mostly flat and far away; don't compete with island/terrain budget). A 5-ring setup at radii ~50/150/400/1000/2500 m with halving density per ring is a reasonable starting point.
- Because vertex displacement barely matters above ~150 m altitude (§1.1), consider **disabling Gerstner vertex displacement entirely on the outer 2–3 rings** and letting only the fragment shader (normal-only Gerstner + colour ramp + glints) do the work there — this is a nearly free LOD win since it's a shader permutation, not a geometry swap.

### 6.2 Aliasing mitigation

| Technique | Use for |
|---|---|
| **Mip-biased detail fade / distance fade** | Bathymetry noise, glint noise, and the edge-jitter noise (§2.2, §3.2) should all fade their contribution amplitude toward zero past a tuned distance, collapsing to flat band colours — prevents shimmer without needing per-pixel supersampling |
| **`fwidth()`-based footprint clamp** | Suppresses sub-pixel glints from ever rendering rather than letting them flicker (§3.2) |
| **TAA vs FXAA for a hard-edged style** | **FXAA (or no AA + supersampled render target) is the safer default.** TAA's temporal jitter + history blending will *soften the deliberately hard band edges and dash silhouettes* that are this style's whole point — the art bible explicitly wants "hard shadow edges" and "hard-edged painted dashes" (§3.3–3.4), which is in tension with TAA's reconstruction blur. If TAA is required for other systems (foliage, thin geometry) in the wider game, consider **excluding the water pass from the TAA history blend** (render it in a separate pass composited post-TAA) so its edges stay crisp. |
| **Grain + chroma wobble (art bible §3.8)** | Applied in the shared post-chain, not per-material — keep the water shader itself grain-free and let the global post pass add it uniformly, so grain intensity stays centrally tunable |

### 6.3 Uniform & draw-call budget

Target **one shared water `ShaderMaterial`** (a handful of `#define` permutations for near/mid/far ring LOD) rather than per-ring bespoke materials, so the whole ocean is 3–5 draw calls. Representative uniform list:

```js
{
  uTime:            { value: 0 },
  uSeaState:        { value: 1.0 },      // 0 calm .. 2 bora, drives §1.3 table lerp
  uWaves:           { value: /* vec4[4]: dir.xy, wavelength, amplitude */ },
  uSteepness:       { value: /* float[4] */ },
  uBathymetry:      { value: bathymetryTexture },
  uBathyOrigin:     { value: new THREE.Vector2() },
  uBathyScale:      { value: 4096.0 },
  uEdgeNoise:       { value: tileableNoiseTexture },
  uSwellDir:        { value: new THREE.Vector2(0.87, -0.5) },
  uGlintCoverage:   { value: 0.045 },
  uSkyCube:         { value: skyCubeRenderTarget.texture },
  uSunDirection:    { value: new THREE.Vector3() },
  uCloudShadowMask: { value: cloudShadowTexture },
  uWakeBuffer:      { value: wakePingPongTexture },
  uWakeOrigin:      { value: new THREE.Vector2() },
}
```

**60 fps target checklist:** ring mesh ≤300k tris total; wake/ripple sim resolution capped at 256×256 (matches the official GPGPU water example's default scale — plenty for a single plane's near field); glint noise textures ≤512² tiled; bathymetry texture can be low-res (512²–1024²) since it only drives band selection, not fine detail; sky cubemap 6×256² is sufficient since it's blurred by the low Fresnel weight in §4.1.

---

## 7. Code sketch — putting it together

```js
import * as THREE from 'three';

const waterMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
waterMat.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, waterUniforms); // the list in §6.3

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', /* glsl */ `
      #include <common>
      uniform float uTime;
      uniform vec4 uWaves[4];      // dir.xy, wavelength, amplitude
      uniform float uSteepness[4];
      varying vec3 vWorldPos;
      varying vec3 vGerstnerNormal;

      vec3 gerstner(vec3 p) {
        vec3 offset = vec3(0.0);
        vec3 normal = vec3(0.0, 1.0, 0.0);
        for (int i = 0; i < 4; i++) {
          vec2 d = normalize(uWaves[i].xy);
          float wLen = uWaves[i].z, A = uWaves[i].w, Q = uSteepness[i];
          float k = 6.28318 / wLen;
          float w = sqrt(9.8 * k);
          float phase = k * dot(d, p.xz) + w * uTime;
          float Qi = Q / (k * A * 4.0);
          offset.x += Qi * A * d.x * cos(phase);
          offset.z += Qi * A * d.y * cos(phase);
          offset.y += A * sin(phase);
          normal.xz -= d * k * A * cos(phase);
        }
        vGerstnerNormal = normalize(normal);
        return offset;
      }
    `)
    .replace('#include <begin_vertex>', /* glsl */ `
      vec3 transformed = vec3(position);
      vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      transformed += gerstner(vWorldPos);
    `);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */ `
      #include <common>
      uniform sampler2D uBathymetry, uEdgeNoise, uWakeBuffer;
      uniform samplerCube uSkyCube;
      uniform vec3 uSunDirection;
      varying vec3 vWorldPos;
      varying vec3 vGerstnerNormal;
      // bandedDepth(), seaColor(), glintMask() from §2.2 / §3.1
    `)
    .replace('#include <dithering_fragment>', /* glsl */ `
      #include <dithering_fragment>
      // colour ramp, glint dash, sky fresnel, wake foam composited here (§2-5)
    `);
};
```

This mirrors the exact `onBeforeCompile` pattern documented by three.js core (`#include <begin_vertex>` swap, per the [original feature PR](https://github.com/mrdoob/three.js/issues/11475)) and demonstrated for wave displacement specifically in [Josh Marinacci's vertex-shader ripple tutorial](https://medium.com/@joshmarinacci/water-ripples-with-vertex-shaders-6a9ecbdf091f) and the community [Gerstner + `CustomShaderMaterial` composition thread](https://discourse.threejs.org/t/ocean-shader-shader-composition-variations-on-a-theme/82592) on the three.js forum.

### Authoring checklist

- [ ] Bathymetry bake covers every visible island's coastline at ≥512² resolution, aligned to the same world-UV grid as terrain.
- [ ] Palette hexes pulled verbatim from `00_ART_DIRECTION.md` §2 — no re-sampling from screenshots.
- [ ] Band edge visibly wobbles (noise-perturbed threshold, §2.2) but stays 1–2 px hard — check at both 200 m and 1500 m altitude.
- [ ] Glint coverage measured in a screenshot histogram lands in the 3–6% pixel-count target (§3, art bible §2).
- [ ] No `smoothstep`/`mix` anywhere on an edge that the art bible calls hard (band edge, foam mask, cloud-shadow patch) — audit every step function.
- [ ] Sky reflection contribution capped low enough that sea colour still dominates in wide shots (art bible §10 "negative space").
- [ ] Wake/ripple buffer decay tuned so trails persist ~4–8 s behind the plane, matching reference-frame wake lengths.
- [ ] Sea-state table (§1.3) wired to a wind/weather system, not left static.
- [ ] Confirm 60 fps with all 3 sea states active plus 3 visible islands, per art bible §5 budget.
- [ ] Water pass excluded from TAA history blend if TAA is enabled elsewhere (§6.2).

---

## Prior art referenced

- Three.js `Water` addon docs & source — <https://threejs.org/docs/pages/Water.html>, <https://github.com/mrdoob/three.js/blob/dev/examples/jsm/objects/Water.js>
- Three.js official ocean example — <https://github.com/mrdoob/three.js/blob/dev/examples/webgl_shaders_ocean.html>
- `Water2` ocean-unsuitability discussion — <https://github.com/mrdoob/three.js/issues/17251>
- Three.js GPGPU water (heightfield ping-pong) — <https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_water.html>
- Three.js WebGPU/TSL compute water — <https://fossies.org/linux/three.js/examples/webgpu_compute_water.html>
- `onBeforeCompile` feature origin — <https://github.com/mrdoob/three.js/issues/11475>
- Three.js forum, Gerstner + shader composition — <https://discourse.threejs.org/t/ocean-shader-shader-composition-variations-on-a-theme/82592>
- Vertex-shader ripple tutorial (`onBeforeCompile` pattern) — <https://medium.com/@joshmarinacci/water-ripples-with-vertex-shaders-6a9ecbdf091f>
- GLTF water-trail vertex displacement — <https://www.thefrontdev.co.uk/creating-water-trails-with-vertex-displacement-on-a-gltf-model/>
- GPU Gems 1, Ch. 1, Gerstner/sum-of-sines — <https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models>
- GPU Gems 2, Ch. 18, vertex-texture displacement (*Pacific Fighters*) — <https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-18-using-vertex-texture-displacement>
- Tessendorf FFT ocean, ARM implementation notes — <https://arm-software.github.io/opengl-es-sdk-for-android/ocean_f_f_t.html>
- NVIDIA DirectX Compute ocean (Tessendorf/Phillips spectrum) — <https://developer.download.nvidia.com/assets/gamedev/files/sdk/11/OceanCS_Slides.pdf>
- Projected grid ocean (Johanson 2004 discussion) — <https://repositum.tuwien.at/bitstream/20.500.12708/7037/2/Gamper%20Thomas%20-%202018%20-%20Ocean%20surface%20generation%20and%20rendering.pdf>, <http://habib.wikidot.com/projected-grid-ocean>
- CDLOD terrain LOD paper & source — <https://aggrobird.com/files/cdlod_latest.pdf>, <https://github.com/fstrugar/CDLOD>
- **Sea of Thieves**, "The Technical Art of Sea of Thieves," SIGGRAPH 2018 Talks (official FFT + stylised foam/colour breakdown) — <https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf>
- Wind Waker–style stylised water in Shader Graph/URP — <https://danielilett.com/2020-04-05-tut5-3-urp-stylised-water/>
- Gerstner Shadertoy reference port — <https://oneshader.net/shader/c5d53c66fc>
