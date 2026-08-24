# 04 — Light, Shadow and Atmosphere
### Implementation research for the Adriatic seaplane world (Three.js)
### Binds to `00_ART_DIRECTION.md`. Camera default: 200–1500 m, looking down 20–45°.

This doc is implementation-facing. Every recommendation is checked against the style contract: **stepped diffuse ramps (2–4 bands), hue-shifted shadow colour (never multiply-darken), hard-edged aircraft shadows, painted discrete highlights, strong colour-based aerial perspective toward pale cyan, subtle grain.** Where a common Three.js technique fights that contract (soft PBR shadows, HDR bloom blooms, grey exponential fog, ACES filmic contrast rolloff), it is called out explicitly and replaced.

---

## 1. Light rig: one sun + one hemisphere fill

The art direction is explicit: **one directional sun (shadow-casting) + one hemisphere fill, no area lights, no GI, no reflection probes except a cheap sky cubemap** (`00_ART_DIRECTION.md` §5). Three.js's [`DirectionalLight`](https://threejs.org/docs/pages/DirectionalLight.html) and [`HemisphereLight`](https://threejs.org/docs/api/en/lights/HemisphereLight.html) map directly onto this — `HemisphereLight(skyColor, groundColor, intensity)` blends between a sky tint on upward-facing normals and a ground tint on downward-facing normals with no shadow cost at all, which is exactly the "fake GI" this style wants instead of real bounce light.

Because tone mapping is being kept minimal (`NoToneMapping` or a custom curve — see §7), light intensities here are tuned by eye against the sRGB hex palette in `00_ART_DIRECTION.md`, not physical lux values. Treat "intensity" as a painter's exposure knob, not a photometric unit.

### 1.1 Time-of-day parameter table

All hex values are drawn from or interpolated within the `00_ART_DIRECTION.md` palette (sky, cloud-lit, sea-shadow, limestone-shadow families). Sun colour temperature is expressed loosely in Kelvin for authoring intuition, but what actually ships is the hex.

| Preset | Sun colour (hex / ~K) | Sun intensity | Sun elevation | Hemisphere sky (top) | Hemisphere ground (bottom) | Hemi intensity | Notes |
|---|---|---|---|---|---|---|---|
| **Early morning** | `#ffe0b0` / ~3200K | 1.6 | 8–15° | `#8cbdcb` (cloud-shadow cyan, cooled) | `#a8b19d` (pasture warm-grey) | 0.55 | Long hard shadows; sea shadow tone shifts further violet (`#012438`→`#031c3a`); haze band thick, near-horizon glow bleeds warm into the cyan sky. |
| **Late morning — DEFAULT** | `#fff3dd` / ~5200K | 2.0 | 45–55° | `#1ca6c7` (zenith cyan) | `#c8cdbe` (dry pasture) | 0.65 | The reference-frame condition. Shadows short, hard, near-vertical; sea reads deep workhorse blue `#024892`/`#033a82`. |
| **Golden hour** | `#ffb15e` / ~2600K | 1.75 | 12–20° | `#d0dbdf` (horizon haze, warmed) | `#a42a08`-adjacent terracotta bounce, desaturated to `#8a6a52` | 0.5 | Rim-light term (see §2.3) becomes the dominant read; sun disc bloom widens (§4); shelf-band turquoise (`#14707c`) goes almost gold at the edge. |
| **Dusk** | `#c98cff`→`#5f6fa8` blend / ~9000K equiv. cool | 1.1 | 0–8° | `#5f6fa8` (dusk violet-cyan) | `#2e312b` (limestone deep shadow) | 0.75 (fill dominates) | Sun term fades below hemisphere; this is the one preset where fill light does more storytelling than the sun. Avoid true black — floor at sea-shadow tone `#012438`. |
| **Overcast bora** | `#cfd8dc` / ~6500K flat | 0.9 (diffuse, near shadowless) | n/a (sun disc hidden) | `#9bb5a8` (cloud-shadow sky-green-cyan) | `#726f60` (limestone strata) | 1.1 (fill carries the scene) | Shadow-casting on the directional light can be disabled or its intensity dropped near zero — the bora look is *flat stepped bands with no cast shadow*, sea reads mid-blue `#014575`/`#03547c` with heavy whitecap dashing (see `02_WATER.md`). |

```js
// Preset application — values above, kept as a single lookup table
const TOD_PRESETS = {
  lateMorningDefault: {
    sun:   { color: 0xfff3dd, intensity: 2.0, elevationDeg: 50, azimuthDeg: 135 },
    hemi:  { sky: 0x1ca6c7, ground: 0xc8cdbe, intensity: 0.65 },
  },
  goldenHour: {
    sun:   { color: 0xffb15e, intensity: 1.75, elevationDeg: 16, azimuthDeg: 100 },
    hemi:  { sky: 0xd0dbdf, ground: 0x8a6a52, intensity: 0.5 },
  },
  overcastBora: {
    sun:   { color: 0xcfd8dc, intensity: 0.9, elevationDeg: 40, azimuthDeg: 135, castShadow: false },
    hemi:  { sky: 0x9bb5a8, ground: 0x726f60, intensity: 1.1 },
  },
  // early morning, dusk analogous — see table
};
```

Setup follows the standard [`DirectionalLight` docs](https://threejs.org/docs/pages/DirectionalLight.html) pattern (`light.position` sets *direction*, not location, for directional lights — treat it as a unit vector scaled out).

---

## 2. Cel/gouache shading model

### 2.1 Three implementation paths, and which one wins where

| Approach | How it works | Pros | Cons | Verdict |
|---|---|---|---|---|
| **`MeshToonMaterial` + `gradientMap`** | Built-in Three.js material; samples a small 1D gradient texture by `N·L` instead of smooth Lambert. [Docs](https://threejs.org/docs/pages/MeshToonMaterial.html), [tutorial](https://sbcode.net/threejs/meshtoonmaterial/). | Zero shader authoring; works with existing shadow/light pipeline; cheap. | Gradient is sampled per-fragment from a texture (needs `NearestFilter`, `generateMipmaps=false` to keep hard steps) — no built-in hook for hue-shifted shadow *tint* independent of the base colour, no rim term, one gradient shared globally unless you swap textures per-material. | Good default for **props/background dressing** (buoys, gulls, small boats) where authoring speed matters more than exact colour control. |
| **Custom `ShaderMaterial`** | Full ownership of vertex/fragment shader; roll your own lighting from scratch. | Total control; matches forum patterns for [hand-rolled toon shaders](https://discourse.threejs.org/t/imitating-standardmaterial-lights-in-shadermaterial/12136). | Must manually wire in Three's light uniforms, shadow map sampling, fog, and multi-light plumbing that `onBeforeCompile` gets for free; more maintenance as Three.js versions change internal chunk names. | Use only for truly bespoke surfaces (water, sky) that already need a fully custom shader per the other docs. |
| **`onBeforeCompile` injection into `MeshStandardMaterial`/`MeshLambertMaterial`** | Hook Three's shader *after* it's generated, do string-splice replacements of specific `#include` chunks (e.g. `lights_fragment_begin`) to swap the Lambert term for a stepped ramp + hue shift + rim, while keeping Three's fog, shadow-map sampling, normal handling, and light-uniform plumbing intact. Pattern documented across multiple [three.js forum threads](https://discourse.threejs.org/t/onbeforecompile-madness/10860) and a worked writeup on [injecting custom GLSL into Three.js materials](https://salivity.github.io/three.js/article/inject-custom-glsl-into-three-js-materials). | Keeps built-in shadow receiving, `CSM`-friendliness, fog integration; one shared chunk reusable across terrain/foliage/water/buildings/aircraft as the art direction doc requires ("One shared 'gouache' shader chunk reused by terrain, foliage, cliffs, buildings"); still fast (no chunk re-parsing per material instance if chunk source is cached). | Fragile across Three.js minor versions if chunk names change; string-splicing feels unpleasant vs a "real" shader graph. | **This is the primary path.** It is the only option that satisfies the art-direction mandate of one shared gouache chunk across heterogeneous materials while staying inside Three's standard light/shadow/fog system. |

### 2.2 The shared "gouache ramp" GLSL chunk

Inject this into `lights_fragment_begin` (or the equivalent physical/lambert chunk) via `onBeforeCompile`. It replaces continuous `N·L` falloff with a quantised band count (`uRampSteps`, 2–4 per the contract), shifts the shadow band's *hue* rather than darkening it, and adds a backlight/rim term.

```glsl
// ---- shared gouache ramp chunk -------------------------------------
uniform float uRampSteps;      // 2.0-4.0, per-material override
uniform vec3  uShadowTint;     // hue-shift target, NOT black/grey. e.g. violet-navy for sea,
                                // cyan for cloud, blue-green for forest, warm brown-grey for stone
uniform float uShadowTintMix;  // 0-1, how much shadow band leans into uShadowTint vs base*const
uniform vec3  uRimColor;       // backlight / rim accent, usually sky-cyan or sun-warm
uniform float uRimPower;       // rim falloff exponent, 2.0-6.0
uniform float uRimStrength;    // 0-0.6, kept low — this is a paint accent, not a Fresnel glow

float gouacheStep(float ndotl, float steps) {
    // half-lambert avoids a fully-black terminator, then quantise
    float hl = ndotl * 0.5 + 0.5;
    return floor(hl * steps) / max(steps - 1.0, 1.0);
}

vec3 applyGouacheRamp(vec3 baseColor, float ndotl, vec3 viewDir, vec3 normal) {
    float band = gouacheStep(ndotl, uRampSteps);          // 0 = shadow band, 1 = lit band
    // hue-shift, never multiply-darken: lerp toward a tinted colour, not toward black
    vec3 shadowColor = mix(baseColor * 0.82, uShadowTint, uShadowTintMix);
    vec3 litColor    = baseColor;
    vec3 shaded      = mix(shadowColor, litColor, band);

    // rim / backlight term — cheap Fresnel, clamped to a thin painted edge
    float rim = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), uRimPower);
    rim = smoothstep(0.55, 0.85, rim) * uRimStrength;      // hard-edged, not a soft glow
    shaded += uRimColor * rim;

    return shaded;
}
// ---------------------------------------------------------------------
```

Splice point (conceptual — actual string match is against Three's built-in chunk source):

```js
material.onBeforeCompile = (shader) => {
  shader.uniforms.uRampSteps     = { value: 3.0 };
  shader.uniforms.uShadowTint    = { value: new THREE.Color(0x0a2a4a) }; // per-surface, see table
  shader.uniforms.uShadowTintMix = { value: 0.85 };
  shader.uniforms.uRimColor      = { value: new THREE.Color(0x9bd9e6) };
  shader.uniforms.uRimPower      = { value: 3.5 };
  shader.uniforms.uRimStrength   = { value: 0.25 };

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + GOUACHE_CHUNK_GLSL)
    .replace(
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + ...',
      'vec3 outgoingLight = applyGouacheRamp(diffuseColor.rgb, dotNL, vViewPosition, normal) + reflectedLight.indirectDiffuse + ...'
    );
};
material.customProgramCacheKey = () => 'gouache-v1'; // avoid cache collisions across variants
```

### 2.3 Per-surface tuning table (hue-shift + rim, tying to the palette)

| Surface | Base lit tone | `uShadowTint` (hue-shifted, not darker) | `uRampSteps` | Rim colour | Rim strength |
|---|---|---|---|---|---|
| Open sea | `#024892` | `#012438` → `#02365b` (violet-navy) | 3 | `#e7e6eb` (foam-white) | 0.15 (handoff to `02_WATER.md` glints) |
| Cloud (lit/shadow face) | `#ebedea` | `#8cbdcb`/`#9bb5a8` (cyan, never grey) | 2 | `#1ca6c7` | 0.1 |
| Forest / canopy | `#45764e` | `#1f4e38`→`#101d19` shifted blue-green | 3 | `#8cbdcb` | 0.2 |
| Limestone cliff | `#cbc5ad`/`#d6d2cc` | `#726f60`/`#534a40`/`#2e312b` (warm brown-grey) | 4 (strata reads best with more bands) | `#d0dbdf` | 0.15 |
| Terracotta / buildings | `#a42a08` | `#654532` (warm shadow, never desaturated to grey) | 2 | none (reserve red, no rim stealing the accent) | 0 |
| Aircraft (vermilion) | `#c63427`/`#b63118` | warm-dark `#6e1c12`, never blue-shifted (the plane must stay hot) | 3 | `#e7e6eb` thin edge highlight only | 0.1, tight `uRimPower` ~6 |

This table is the "one shared chunk, many uniform sets" mechanism the art direction calls for — same GLSL, per-material uniform blocks.

---

## 3. Shadows: hard-edged, cascaded, and the aircraft-on-water problem

### 3.1 Cascaded shadow maps for an open world

A single `DirectionalLight` shadow map has one frustum that must cover the whole visible ground plane; at altitude (200–1500 m camera height, correspondingly large view distances) this either blows the shadow-map resolution budget or produces visible texel shimmer. The standard fix is **cascaded shadow maps (CSM)**: split the camera frustum into 2–4 depth ranges, each with its own tightly-fit shadow camera/map, so near cascades get high texel density and far cascades cover huge area at low density.

Three.js does not ship CSM in core, but the community `three-csm` add-on (also mirrored into some three.js example builds as `CSM`) implements exactly this: multiple internal `DirectionalLight`s, one per cascade, each fitted to a frustum slice — see the [three-csm README](https://github.com/StrandedKitty/three-csm) and the [three.js docs page for CSM](https://threejs.org/docs/pages/CSM.html). A showcase thread on the [three.js forum](https://discourse.threejs.org/t/cascaded-shadow-maps/12311) demonstrates the visual improvement over a single shadow frustum on large terrain, and a React Three Fiber port exists as a [gist reference implementation](https://gist.github.com/itsdouges/05621f06bd38848ab4704a280f596104) if the project uses R3F tooling anywhere.

```js
import { CSM } from 'three/addons/csm/CSM.js'; // or 'three-csm' package

const csm = new CSM({
  maxFar: camera.far,
  cascades: 3,                 // 3 is enough at these altitudes; 4 if draw distance grows past ~6km
  mode: 'practical',           // logarithmic-practical split scheme — denser near cascades
  shadowMapSize: 1024,         // keep modest per-cascade; hardness comes from bias/PCF radius, not resolution
  lightDirection: sunDirection.clone().normalize(),
  camera: mainCamera,
  parent: scene,
});
// per-frame:
csm.update();
```

### 3.2 Keeping edges hard, avoiding peter-panning, avoiding shimmer

The style contract explicitly wants **hard shadow edges, soft interiors** — the opposite of typical PCF softening. Concretely:

| Problem | Standard PBR fix | What to do instead for this style |
|---|---|---|
| Soft/blurry penumbra | Increase `shadow.radius`, use `PCFSoftShadowMap` | Keep `renderer.shadowMap.type = THREE.PCFShadowMap` (hard) or `PCFSoftShadowMap` with `light.shadow.radius` pinned near 0–1 — near-zero blur, per `00_ART_DIRECTION.md` §5. The [Three.js manual's shadow chapter](https://threejs.org/manual/en/shadows.html) and the [`DirectionalLightShadow` docs](https://threejs.org/docs/pages/DirectionalLightShadow.html) cover the bias/radius knobs directly. |
| Peter-panning (shadow detaches from caster at altitude) | Increase `shadow.bias` positive | At 200–1500 m the caster (aircraft) is far from the receiver (sea/ground), so bias must be *tiny* (`~-0.0005` to `0.0001`) and near/far planes on the shadow camera kept tight around the aircraft's actual altitude range, not the whole world's — a wide `shadow.camera.near/far` is the #1 cause of both peter-panning and acne reported repeatedly on the [three.js forum](https://discourse.threejs.org/t/direction-light-shadow-working-weird/62405). For a flying aircraft, drive the cascade fitted around the plane specifically (see §3.3) rather than relying on the terrain CSM alone. |
| Shimmer/swimming when camera moves | — | **Texel snapping**: round the shadow camera's world-space position to whole shadow-map texel increments each frame before rendering the shadow pass, exactly as recommended in most CSM implementations, so a moving camera never sub-pixel-shifts the shadow map contents. `three-csm` and most cascade libraries expose a `fade`/`lightMargin` and internally snap; if hand-rolling this on a plain `DirectionalLight`, snap `light.position` and `light.shadow.camera` bounds to `mapSize / frustumSize` steps. |
| Over-large shadow frustum wasting resolution | — | Tight per-cascade fitting (CSM does this automatically); for the terrain doc's tile streaming, only include tiles inside the current cascade's frustum in the shadow-casting set. |

### 3.3 The aircraft shadow on water — the signature shot

Frame 1 of the art direction reference is explicit: the plane's shadow on water is a **crisp, solid, single-tone silhouette with zero penumbra gradient** — this is called out as "the strongest storytelling device you have." Three approaches, in order of fidelity vs. cost:

1. **Real shadow map, tuned hard** — cast the aircraft into the normal directional-light shadow map, but give the *aircraft specifically* its own tight-fitted mini shadow camera (a 4th, small-frustum cascade that follows the plane, independent of the terrain CSM's cascades) so its texel density stays high regardless of altitude. Sample it in the water shader with **zero PCF softening** (single-tap or 2×2 hard tap, no radius) so the edge is a binary cut rather than the soft-edged blob a generic PCF setup would produce. This preserves *correct* perspective distortion of the shadow shape as the plane banks — important for readability during turns.
2. **Decal/blob shadow fallback** — for distant or low-detail aircraft (multiplayer wingmen, background traffic), project a flattened silhouette mesh (the plane's own top-down silhouette, extruded flat) onto the water surface each frame using the plane's world position and the sun direction, rendered as a simple dark, single-tone, unlit decal. This sidesteps shadow-map resolution entirely and guarantees the "solid single-tone silhouette" look exactly because it *is* one draw of one flat colour — no filtering artifacts possible. Classic blob-shadow technique, now repurposed for style rather than performance.
3. **Hybrid** — real shadow map for shape correctness + a forced-flat unlit override material on the receiving water fragment inside the shadow term (i.e., where `shadow < 1.0`, don't lerp — hard step to the single `uShadowTint` colour) so even a technically-soft-sampled shadow map *reads* as a hard silhouette. This is the pragmatic default: keep the real shadow map's correct projection/perspective, but clamp its output with a `step()` rather than a `smoothstep()` before it touches the water's stepped ramp:

```glsl
// inside the water fragment shader, after standard shadow-map lookup `shadowFactor` (0=fully shadowed,1=lit)
float hardShadow = step(0.5, shadowFactor);           // binary cut, no gradient
vec3 waterColor = mix(uSeaShadowTint, litSeaColor, hardShadow); // hue-shifted tint, not darkened
```

This hybrid is what the water doc (`02_WATER.md`) should consume — the water shader receives a single `hardShadow` scalar per fragment and treats it as a hard switch between two already-graded colours, never a multiply.

Note on the animated water surface: because the sea has vertex displacement (swell/chop, per `02_WATER.md`), the shadow receiver's normals/positions are moving, which can cause the projected shadow to swim slightly with the waves. Since the contract wants a *rigid* silhouette, it's worth projecting the aircraft shadow shape in **flat screen-space / world-XZ decal space** rather than letting it deform with per-vertex wave displacement — i.e., option 2 or a decal-space version of option 1, sampling the shadow map by the *undisplaced* base water plane position, not the displaced one.

---

## 4. Sun glare, bloom, godrays — restraint over "HDR shooter"

The art direction is a painting, not a Bloom-drenched shooter — bloom should touch **only the sun disc and foam highlights**, never wash the whole frame.

### 4.1 Bloom via EffectComposer + UnrealBloomPass, tuned tight

Three.js's standard bloom is [`UnrealBloomPass`](https://threejs.org/docs/pages/UnrealBloomPass.html) run inside an [`EffectComposer`](https://threejs.org/docs/examples/en/postprocessing/EffectComposer.html) chain. Its three parameters (`strength`, `radius`, `threshold`) are the entire tuning surface, and a high `threshold` is the single biggest lever to stop bloom bleeding into midtones — multiple forum reports show the exact failure mode of a low threshold "ruining the whole render" by blooming every bright surface, not just true highlights ([three.js forum](https://discourse.threejs.org/t/effectcomposer-unrealbloompass-is-ruining-my-whole-render-thing/45253)).

```js
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), /*strength*/ 0.55, /*radius*/ 0.25, /*threshold*/ 0.92);
composer.addPass(bloom);
```

| Uniform | Starting value | Rationale |
|---|---|---|
| `threshold` | **0.90–0.94** (near-clip) | Only the sun disc's near-white core and foam-crest highlights (`#e7e6eb`) should cross this; painted mid-tone highlights (`00_ART_DIRECTION.md` rule 4: "discrete highlights, never a Blinn-Phong lobe") must stay below it entirely. |
| `strength` | **0.4–0.6** | Enough to give the sun a soft corona without turning the sky cyan into a glow field. |
| `radius` | **0.2–0.3** | Small kernel — a tight bloom reads as "bright paint," a wide one reads as "camera lens," which fights the gouache-postcard read. |

For **selective bloom** (bloom the sun/foam layer only, leave terrain/water untouched even if their lit tone is bright), render the emissive/bloom-eligible objects to a separate layer/render target and composite, rather than relying on `threshold` alone to separate them — a documented pattern with worked code at [Wael Yasmina's selective bloom article](https://waelyasmina.net/articles/unreal-bloom-selective-threejs-post-processing/) and discussed on [Reddit r/threejs](https://www.reddit.com/r/threejs/comments/12s8mdf/how_does_the_selective_unrealbloompass_work/). Practically: put the sun disc (a simple additive sprite/mesh) and foam-highlight fragments (tagged via a material flag or a bloom-mask render target) on `camera.layers` bit 1, render that layer alone into the bloom composite, and merge additively over the un-bloomed base — this guarantees terrain never blooms regardless of how bright its lit band gets under golden hour.

### 4.2 Lens flare / anamorphic streak — restrained, not modern-shooter

Three.js ships [`Lensflare`/`LensflareElement`](https://threejs.org/docs/pages/Lensflare.html) as light-attached sprite billboards — a simple, cheap, *old-school* flare (small rings/hexagons tracking the sun), which is tonally correct for a 1920s-30s painterly game precisely because it looks like an artifact of a physical period camera lens rather than a modern anamorphic streak. Attach one or two elements maximum (a soft core + one faint ghost), skip the long horizontal anamorphic streak that reads as "J.J. Abrams sci-fi": that streak is a hallmark of the "HDR modern shooter" look this doc is told to avoid.

```js
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

const flare = new Lensflare();
flare.addElement(new LensflareElement(sunCoreTex, 220, 0, new THREE.Color(0xfff3dd)));
flare.addElement(new LensflareElement(ghostTex, 40, 0.55, new THREE.Color(0xd0dbdf)));
sunLight.add(flare);
```

Keep flare intensity coupled to the same time-of-day table as §1 — golden hour/dusk get a visible flare, overcast bora gets none (no visible sun disc to flare from).

### 4.3 Sun glitter on water — handoff

The dashed, discrete sparkle glints on wave crests (art direction: "3–6% of sea pixels... discrete dashes") belong to the water shader, not the post chain — treat them as painted highlight geometry/noise-masked emissive in `02_WATER.md`, not a post-process bloom source, so their edges stay hard and the count stays sparse rather than blooming into streaks. Only the very brightest, largest glints (if any) should be allowed to cross the bloom threshold, and only when the sun is low (golden hour/dusk) — see §4.1's threshold discipline.

### 4.4 Screen-space godrays through cloud

For light shafts breaking through cumulus (relevant when flying through/under cloud per `01_SKY_AND_CLOUDS.md`), a cheap screen-space radial-blur godray pass (sample toward the sun's screen-space position, accumulate occluded/unoccluded samples) is the standard real-time approximation — see the [Cyanilux god-rays shader breakdown](https://www.cyanilux.com/tutorials/god-rays-shader-breakdown/) and Three.js's own older [`GodRaysShader` module](https://threejs.org/docs/pages/module-GodRaysShader.html) for the reference algorithm (occlusion pre-pass → radial blur → additive composite). Keep sample count low (8–16) and, critically, **clamp the additive contribution hard** — this effect is the fastest way to accidentally reintroduce the "volumetric AAA shooter" look. Use it only when the sun is occluded by cloud geometry (early morning / dusk / passing through cumulus), not as a permanent screen effect.

### 4.5 What "wrong" looks like here
- Bloom visibly haloing the *terrain* or the *sea's lit band* — threshold too low.
- A long horizontal or hexagonal-ghost-chain flare crossing the whole screen — anamorphic streak creeping back in.
- Godrays that are visible on a clear day with no cloud between camera and sun — should be near-zero without an occluder.
- Any glint on water surviving as a soft blob rather than a hard-edged dash after bloom — bloom radius too wide, or glint geometry itself is soft.

---

## 5. Aerial perspective / haze — colour lerp, not grey fog

### 5.1 Why exponential/grey fog fails here

Three.js's built-in [`Fog`](https://threejs.org/docs/pages/Fog.html) and `FogExp2` blend towards a single flat fog colour by distance, and the [Three.js manual's fog chapter](https://threejs.org/manual/en/fog.html) shows the classic result: everything past a certain distance converges to one grey-ish colour uniformly in all directions, killing hue. The art direction is unambiguous that this is wrong: "distant land... desaturates *and shifts to the sky's cyan* within ~3 km. Haze is a colour lerp toward `#b1cbd3`, not a grey fog" (rule 5). A single scalar fog density also fogs the *sky itself* incorrectly and doesn't respect that haze should thicken with both distance **and altitude** differently (a boat on the water 3km away is hazier than a cloud at the same distance but higher up, because more atmosphere-equivalent lies along a near-horizontal ray).

### 5.2 What to build instead: distance + height colour lerp

A per-fragment shader term, injected via the same `onBeforeCompile` mechanism as §2, that:
1. Computes `distanceFactor = 1.0 - exp(-dist * uHazeDensity)` (exponential is fine for the *falloff curve* — the failure mode isn't the math, it's lerping to grey) but critically **lerps toward the sky's own haze hex, not a generic fog uniform**: `#b1cbd3` → `#d0dbdf` per the palette table.
2. Adds a **height-based term**: rays that graze near the water surface (near-horizontal, common at 200-1500m looking down at distant coastline) accumulate more haze than steep downward rays over near ground, matching real aerial perspective and the reference's "distant land shifts to cyan within ~3km" behaviour while close-below terrain stays saturated.
3. Desaturates *before* lerping (pull the base colour toward its own luminance a little) so the hue-shift reads as atmosphere, not a colour-mixing artifact — this is what makes it look like sky-tint rather than fog-tint.

```glsl
uniform vec3  uHazeColorNear;   // #b1cbd3
uniform vec3  uHazeColorFar;    // #d0dbdf, slightly lighter/greyer at max range
uniform float uHazeDensity;     // tune per view-distance budget, see table below
uniform float uHazeHeightFalloff; // how quickly haze thins with camera/fragment height delta

vec3 applyAerialPerspective(vec3 baseColor, float viewDist, float heightDelta) {
    float distFactor   = 1.0 - exp(-viewDist * uHazeDensity);
    float heightFactor = exp(-max(heightDelta, 0.0) * uHazeHeightFalloff); // more haze near sea level
    float haze = clamp(distFactor * mix(0.4, 1.0, heightFactor), 0.0, 1.0);

    vec3 hazeColor = mix(uHazeColorNear, uHazeColorFar, distFactor);
    vec3 desaturated = mix(baseColor, vec3(dot(baseColor, vec3(0.299, 0.587, 0.114))), haze * 0.35);
    return mix(desaturated, hazeColor, haze);
}
```

A working three.js implementation of a comparable **height-based fog** (rather than the naive uniform-distance fog) is documented with code at [Wooden Raft's height-fog writeup](https://woodenraft.games/blog/height-fog-implementation-three-js), and the "fog with vertical dropoff" question/discussion on the [three.js forum](https://discourse.threejs.org/t/possible-to-create-fog-with-vertical-dropoff/15015) confirms this is a recognized gap in the built-in fog that needs a custom shader term — reinforcing that a bespoke chunk (not `scene.fog`) is the right call. Matching the haze colour to the actual sky shader (rather than a hand-picked constant that can drift out of sync) is also a common pitfall flagged in the [three.js forum thread on matching fog colour to a sky shader](https://discourse.threejs.org/t/matching-fog-color-with-the-sky-shader/52018) — sample the sky shader's horizon colour function for `uHazeColorFar` at runtime rather than hardcoding it twice.

### 5.3 Tuning by view distance budget

| View distance budget | `uHazeDensity` (start) | Effect |
|---|---|---|
| ~3 km (tight island hopping) | 0.00035 | Matches the reference's "shift to cyan within ~3km" literally — islands at the far draw-distance edge are almost fully sky-cyan. |
| ~6 km (open sea crossings) | 0.00018 | Slower falloff so mid-distance islands stay legible in silhouette before fading. |
| ~10 km+ (vista/photo-mode) | 0.00010 | Long, slow gradient — but tighten `uHazeHeightFalloff` so sea-level haze still reads thick close to the horizon line even though the far cutoff is later. |

`uHazeHeightFalloff` should be tuned so that a cloud layer at ~1500m and a coastline at sea level, both 5km away, visibly differ — the coastline noticeably hazier. Start `uHazeHeightFalloff ≈ 0.0012` (1/m) and adjust against reference frame 2.

---

## 6. Ambient occlusion: skip SSAO, use baked/vertex AO

**SSAO does not belong in this style**, for several converging reasons:

- SSAO produces soft, greyscale, radius-based darkening in crevices — precisely the "multiply-darken" gradient the art direction forbids for *all* shadowing, cast or contact (rule 2). It's mathematically a blurred grey occlusion term, structurally incompatible with hue-shifted stepped shadow bands.
- It's a full-screen space post-effect with a real performance cost (multiple depth/normal buffer samples per pixel) fighting the perf budget (60fps @ 1440p, ≤1.2M triangles) for a game whose silhouette-driven asset language (art direction rule 6: "silhouette over detail... never model bark") doesn't have the crevice-scale geometric detail that SSAO exists to shade in the first place.
- Modern comparisons of AO techniques (SSAO vs HBAO vs GTAO) are explicitly about *increasing* physical plausibility and micro-contact-shadow fidelity — see this [overview of AO techniques](https://superrendersfarm.com/article/ambient-occlusion-explained-ssao-hbao-gtao-2026) — which is the opposite design goal from a flat gouache postcard.

**What to use instead:** a restrained **baked or vertex-painted AO term**, multiplied only into crevices that the artist explicitly wants darkened for legibility (hull undersides, cliff overhangs, hangar interiors) — authored the same way the Guilty Gear Xrd pipeline uses a **hand-controlled vertex-colour channel to bias shading thresholds** rather than a computed occlusion pass, per the technique described in their [GDC talk](https://www.ggxrd.com/Motomura_Junya_GuiltyGearXrd.pdf) ("We used a channel from the Vertex Colors as an offset on the Threshold. This made it possible for the artist to make certain areas on the mesh get darker more easily"). Concretely: reserve a vertex-colour or per-instance attribute channel `aAOBias`, and feed it into the gouache ramp's threshold in §2.2:

```glsl
attribute float aAOBias; // 0 = no bias, 1 = strong bias toward shadow band
// in gouacheStep(): float hl = ndotl * 0.5 + 0.5 - aAOBias * 0.3;
```

This keeps AO **art-directed and hard-edged** (a baked value snapping a whole vertex/region into the shadow band) rather than a screen-space grey halo — consistent with the whole doc's philosophy.

---

## 7. Post chain order, tone mapping, grain, vignette

### 7.1 Order (binding, from `00_ART_DIRECTION.md` §5)

**Depth-colour fog/haze → bloom (tight threshold) → grain → subtle chroma/vignette.**

Aerial perspective must be resolved *before* bloom so haze-lightened distant objects don't spuriously cross the bloom threshold; grain and chroma wobble are the last things applied so they sit on top of the final graded image uniformly, exactly like scan/print artifacts sit on top of a finished painting rather than being lit by it.

```js
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));      // scene already has haze baked into materials via onBeforeCompile (§5)
composer.addPass(bloomPass);                            // §4
composer.addPass(grainPass);                             // custom ShaderPass, §7.3
composer.addPass(chromaVignettePass);                    // custom ShaderPass, §7.3
```

### 7.2 Tone mapping and grading — protect the palette

The style contract is explicit: `ACESFilmic` **off**; use `NoToneMapping` + a hand-graded LUT, because the whole doc's palette work (§2 of `00_ART_DIRECTION.md`) is sampled sRGB hex values that must survive untouched. This matters because `ACESFilmicToneMapping` in Three.js applies a filmic contrast/desaturation curve that measurably crushes contrast and shifts colour on textures authored for a flat/no-tonemap pipeline — reported directly in the [three.js forum thread "ACESFilmicToneMapping leading to low-contrast textures"](https://discourse.threejs.org/t/acesfilmictonemapping-leading-to-low-contrast-textures/15484). For a painterly game where the hex values *are* the design, that curve is actively hostile.

```js
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
```

For deliberate, controlled grading (a gentle S-curve for punch, or a scene-specific warm/cool push for golden hour vs. overcast) prefer a **hand-authored 3D LUT sampled in a `ShaderPass`** over any auto tonemap operator — this is the standard film-style grading pipeline, and Three.js's postprocessing examples directory exposes exactly the `ShaderPass` scaffolding needed (`HueSaturationShader`, `BrightnessContrastShader` as building blocks, or a custom `.cube`-LUT sampling shader) per the breakdown in [this LUT/color-grading writeup for Three.js](https://moldstud.com/articles/p-an-in-depth-look-at-color-grading-techniques-in-threejs-post-processing). Keep the LUT itself *subtle* — a light contrast/warmth nudge per time-of-day preset, not a stylistic override, since the gouache ramp (§2) is already doing the heavy colour-design work upstream of this pass.

| Time-of-day preset | LUT/grade intent |
|---|---|
| Late morning default | Neutral pass-through, near-identity LUT (this is the calibration reference) |
| Golden hour | +warm highlights, slightly lifted shadows toward violet (matches §1 hemisphere ground shift) |
| Overcast bora | Slightly compressed contrast, cooled midtones — never fully flat/grey |
| Dusk | Deepened shadow band saturation (violet/navy), small overall exposure pull-down |

### 7.3 Grain and chroma wobble

Per art direction rule 8: "very subtle static grain + 1–2% chroma wobble... below the threshold of 'effect'." Implement as a small custom `ShaderPass`:

```glsl
// grain + chroma wobble fragment (ShaderPass), applied last before vignette
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uGrainStrength;   // 0.02-0.035 — keep low
uniform float uChromaWobble;    // 0.01-0.02 fraction of a pixel, per-channel offset

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
    vec2 uv = vUv;
    float wob = (hash(uv * 400.0 + uTime) - 0.5) * uChromaWobble * 0.003;
    float r = texture2D(tDiffuse, uv + vec2(wob, 0.0)).r;
    float g = texture2D(tDiffuse, uv).g;
    float b = texture2D(tDiffuse, uv - vec2(wob, 0.0)).b;
    vec3 col = vec3(r, g, b);

    float grain = (hash(uv * vec2(1920.0, 1080.0) + uTime * 60.0) - 0.5) * uGrainStrength;
    col += grain;

    gl_FragColor = vec4(col, 1.0);
}
```

### 7.4 Vignette restraint

A vignette should be barely perceptible — a very gentle darkening (not hue-shifted, this one genuinely can be a soft multiply since it's a *lens* artifact metaphor, not a scene-shadow) at the extreme corners only. Start at **max 6–8% darkening at the corners**, falloff starting past 75% of the frame radius, so it never reads as a deliberate frame or masks the "70% uninterrupted flat sea" compositions the art direction wants preserved (rule 10).

---

## 8. Renderer settings summary + QA checklist

### 8.1 Renderer baseline

```js
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;   // hard-edged; avoid PCFSoftShadowMap's wide default radius
renderer.shadowMap.autoUpdate = true;
```

### 8.2 Starting uniform values (consolidated)

| Uniform | Value | Owner |
|---|---|---|
| `uRampSteps` | 2–4 (per surface, §2.3 table) | gouache chunk |
| `uShadowTintMix` | 0.85 | gouache chunk |
| `uRimStrength` | 0–0.25 (0 for aircraft/roofs — reserve red) | gouache chunk |
| CSM `cascades` | 3 | shadow rig |
| CSM `shadowMapSize` | 1024/cascade | shadow rig |
| `light.shadow.bias` | -0.0005 to 0.0001 | shadow rig |
| `light.shadow.radius` | 0–1 | shadow rig |
| Bloom `threshold` | 0.90–0.94 | post chain |
| Bloom `strength` | 0.4–0.6 | post chain |
| Bloom `radius` | 0.2–0.3 | post chain |
| `uHazeDensity` | 0.0001–0.00035 (view-distance dependent, §5.3) | haze chunk |
| `uHazeHeightFalloff` | ~0.0012 | haze chunk |
| `uGrainStrength` | 0.02–0.035 | post chain |
| `uChromaWobble` | 0.01–0.02 | post chain |
| Vignette corner darkening | 0.06–0.08 | post chain |

### 8.3 QA checklist — what "wrong" looks like

- [ ] **Shading gradient is smooth, not stepped** → Lambert/Phong leaking through; check `onBeforeCompile` splice actually replaced the diffuse term, not just added to it.
- [ ] **Shadow band looks like "base colour × 0.5"** → hue-shift missing; `uShadowTintMix` too low or `uShadowTint` accidentally equal to a darkened base colour instead of a genuinely different hue.
- [ ] **Aircraft shadow on water has a soft/blurred edge** → PCF radius not near-zero, or hard-step clamp (§3.3) missing on the water shader's shadow read.
- [ ] **Aircraft shadow swims/ripples with the waves** → shadow sampled against displaced water geometry instead of the flat base plane / decal space.
- [ ] **Shadows detach from the plane at altitude ("peter-panning")** → shadow-camera near/far too wide, or bias too large positive.
- [ ] **Distant terrain fades to grey, not cyan** → using `scene.fog`/`FogExp2` instead of the custom haze chunk, or `uHazeColorFar` not matched to the sky shader's horizon hex.
- [ ] **Whole midtone image looks like it's glowing** → bloom threshold too low; check terrain/water lit bands aren't crossing it.
- [ ] **A long horizontal streak crosses the sun** → anamorphic flare element present; remove, keep flare to 1–2 small radial elements max.
- [ ] **Godrays visible on a clear day** → occlusion gating missing; godrays should be near-zero with no cloud between camera and sun.
- [ ] **Crevices have a soft grey halo** → SSAO left enabled; replace with vertex/baked AO bias into the ramp threshold.
- [ ] **Colours look "cinematic"/desaturated/contrasty in a filmic way** → `ACESFilmicToneMapping` accidentally left on, or LUT grade too strong; compare against the raw palette hex values in `00_ART_DIRECTION.md`.
- [ ] **Grain or chroma wobble is noticeable as "an effect"** → strength values above the 0.035 / 0.02 ceilings; this should only be visible on a large flat colour field at full attention, never at a glance.
- [ ] **Vignette visibly frames the shot** → corner darkening above ~8% or falloff radius too aggressive; the open-sea negative-space compositions must stay unobstructed.
- [ ] **The vermilion aircraft loses saturation in shadow or haze** → `uShadowTint` for aircraft bled toward blue/cyan (forbidden — the plane must always stay hot), or haze chunk applied to the aircraft material at full strength at close range.

---

## Key references

- [`DirectionalLight` docs](https://threejs.org/docs/pages/DirectionalLight.html), [`DirectionalLightShadow` docs](https://threejs.org/docs/pages/DirectionalLightShadow.html)
- [`MeshToonMaterial` docs](https://threejs.org/docs/pages/MeshToonMaterial.html) and [tutorial](https://sbcode.net/threejs/meshtoonmaterial/)
- [three-csm cascaded shadow maps](https://github.com/StrandedKitty/three-csm), [CSM docs page](https://threejs.org/docs/pages/CSM.html), [forum showcase](https://discourse.threejs.org/t/cascaded-shadow-maps/12311)
- [Three.js manual — Shadows](https://threejs.org/manual/en/shadows.html), [Three.js manual — Fog](https://threejs.org/manual/en/fog.html)
- [onBeforeCompile forum thread](https://discourse.threejs.org/t/onbeforecompile-madness/10860), [injecting custom GLSL writeup](https://salivity.github.io/three.js/article/inject-custom-glsl-into-three-js-materials), [ShaderMaterial lighting forum thread](https://discourse.threejs.org/t/imitating-standardmaterial-lights-in-shadermaterial/12136)
- [`EffectComposer` docs](https://threejs.org/docs/examples/en/postprocessing/EffectComposer.html), [`UnrealBloomPass` docs](https://threejs.org/docs/pages/UnrealBloomPass.html), [selective bloom writeup](https://waelyasmina.net/articles/unreal-bloom-selective-threejs-post-processing/)
- [`Lensflare`/`LensflareElement` docs](https://threejs.org/docs/pages/Lensflare.html)
- [God rays shader breakdown](https://www.cyanilux.com/tutorials/god-rays-shader-breakdown/), [Three.js `GodRaysShader` module](https://threejs.org/docs/pages/module-GodRaysShader.html)
- [Height fog implementation in Three.js](https://woodenraft.games/blog/height-fog-implementation-three-js), [forum: fog with vertical dropoff](https://discourse.threejs.org/t/possible-to-create-fog-with-vertical-dropoff/15015), [forum: matching fog to sky shader](https://discourse.threejs.org/t/matching-fog-color-with-the-sky-shader/52018)
- [ACES filmic contrast-crush forum thread](https://discourse.threejs.org/t/acesfilmictonemapping-leading-to-low-contrast-textures/15484), [Three.js LUT/colour-grading writeup](https://moldstud.com/articles/p-an-in-depth-look-at-color-grading-techniques-in-threejs-post-processing)
- [Ambient occlusion technique comparison (SSAO/HBAO/GTAO)](https://superrendersfarm.com/article/ambient-occlusion-explained-ssao-hbao-gtao-2026)
- [Guilty Gear Xrd GDC talk slides (Motomura)](https://www.ggxrd.com/Motomura_Junya_GuiltyGearXrd.pdf), [GGXrd shading GitHub breakdown](https://github.com/galloscript/GGXrdShading), [Polygon making-of feature](https://www.polygon.com/2015/5/26/8663003/guilty-gear-xrd-cel-shading-making-of/)
- [Non-Photorealistic Rendering lecture, Princeton COS426](https://www.cs.princeton.edu/courses/archive/fall23/cos426/cos426assets/static/lectures/Lecture-15.pdf), [NPR lecture, Cambridge](https://www.cl.cam.ac.uk/teaching/1011/RSL/Richardt.pdf)
- [Porco Rosso background art analysis](http://ghiblicon.blogspot.com/2009/07/background-art-of-porco-rosso.html), [Fantasy/Animation essay on Porco Rosso's sensory lighting](https://www.fantasy-animation.org/current-posts/porco-rosso-how-hayao-miyazaki-evokes-emotional-closeness-through-sensory-stimuli)
