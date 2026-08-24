# 05 — Distant Terrain Layering

**Scope.** How land reads from the air at 200–1500 m: the stack of base topography, raised patchy vegetation, and canopy elements, plus the lighting model that makes it read as paint rather than as a shaded heightfield.

**Status.** This doc **supersedes `03_ISLANDS.md` §8.1–§8.4** (forest species, distribution and LOD). Amendments are stated explicitly in §10. It is bound by `00_ART_DIRECTION.md` — every colour and lighting rule here must obey rules 1, 2, 5, 6 and the §5 renderer contract.

---

## 1. Verdict: does this technique already exist?

The proposed stack was: base topography with sand/cliff/light-grass materials → a slightly raised patchy dark layer → tree planes above, lit light/dark by sun direction.

**Component by component it is all established. The exact combination is not published, and one part of the proposal is wrong for this camera.**

| Proposed element | Prior-art status |
|---|---|
| Base with blended sand / cliff / grass materials | **Standard.** This is texture splatting / control maps. Frostbite splats material shaders over one another in strict layer order and combines them in large single-pass shaders ([Andersson, Frostbite terrain, SIGGRAPH 2007](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/chapter5-andersson-terrain-rendering-in-frostbite.pdf)); Unity's equivalent authoring model is Terrain Layers with paint opacity ([Unity Terrain Layers](https://docs.unity3d.com/6000.5/Documentation/Manual/class-TerrainLayer.html)). Not novel. |
| A second surface raised slightly along the normal | **Established mechanism, wrong name.** The nearest named technique is shell rendering: Lengyel, Praun, Finkelstein and Hoppe render fur as a series of concentric shells of semi-transparent medium plus silhouette fins ([*Real-Time Fur over Arbitrary Surfaces*](https://hhoppe.com/fur.pdf)), and NVIDIA's implementation extrudes the mesh n times along the normal, each shell sampling a texture-array slice ([NVIDIA, *Fur using Shells and Fins*](https://developer.download.nvidia.com/SDK/10/direct3d/Source/Fur/doc/FurShellsAndFins.pdf)). **A single raised layer is a degenerate relative of that, not the technique itself.** Not novel as a mechanism. |
| Alpha-cut patchiness in that layer | **Standard.** Alpha test/discard, with screen-door dissolve documented as the order-independent alternative for vegetation LOD ([GPU Gems 2, ch. 1](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-1-toward-photorealism-virtual-botany)). Not novel. |
| Trees as alpha planes | **Established since 2000.** Jakulin represents sparse tree parts as alpha-textured planar slices and blends between the nearest directional slicings ([*Interactive Vegetation Rendering with Slicing and Blending*, Eurographics 2000](https://diglib.eg.org/items/6afedd64-f8c6-4082-9216-ca05fad16d1c)). Not novel — **but see §7, this is the part to change.** |
| Light/dark driven by sun direction, quantised | **Standard cel shading.** Derive `NoL = dot(N, L)` and route it through shadow/key/highlight thresholds rather than an uninterrupted Lambert gradient ([Flax cel-shading guide](https://docs.flaxengine.com/manual/graphics/shaders/cel-shading.html)). Not novel. |
| Terrain-anchored painterly marks | **Established, with terrain-specific prior art.** Meier's founding problem statement is getting paint to stick to surfaces rather than appearing view-plane-fixed ([*Painterly Rendering for Animation*, SIGGRAPH 1996](https://disneyanimation.com/publications/painterly-rendering-for-animation/)); Bhattacharjee and Narayanan render terrain-fixed brush strokes as alpha-blended sprites oriented along terrain slope, with precomputed depth ordering and a screen-space density LOD ([*Real-Time Painterly Rendering of Terrains*, ICVGIP 2008](https://cvit.iiit.ac.in/images/ConferencePapers/2008/Shiben08Painterly.pdf)). Not novel. |
| **The exact ordered stack, for a painterly aerial read** | **No direct disclosure found.** No GDC/SIGGRAPH talk, devlog or repository located in this research documents base → raised patchy dark vegetation sheet → canopy layer as a named combination, and no verified three.js/WebGL2 repository implements it. That is a search result, not proof of nonexistence. |

**Bottom line.** Low novelty per component, moderate distinctiveness as an art-directed composition. Implement it confidently; document it internally as a synthesis, not as a new rendering primitive. Do **not** call it shell texturing — the accurate name is:

> **An alpha-clipped, normal-offset vegetation overlay over splat-blended base terrain, with a clustered canopy-mass layer above it.**

That phrasing is defensible and searchable. Reserve "shell texturing" for a real multi-shell implementation, and "decal" for genuine projected overlays — three.js `DecalGeometry` is projected decal geometry, not a terrain copy ([three.js DecalGeometry](https://threejs.org/docs/pages/DecalGeometry.html)).

---

## 2. What the reference actually measures

Measured on `peninsula-coastline-aerial-clouds.jpg.jpg`, in a 215×167 px window over the vegetated near/mid headland, clear of sea, sand and village. Three natural clusters (k-means, k=3 — **not** percentile thresholds, which would have fixed the coverage figures by construction):

| Tier | Hex | HSL | Coverage in this window |
|---|---|---|---|
| Shadow mass | `#084c29` | h 148.6°, s 0.79, l 0.17 | 68.3% |
| Mid | `#366f48` | h 138.3°, s 0.34, l 0.33 | 24.1% |
| Lit dab | `#749d79` | h 127.6°, s 0.17, l 0.54 | 7.6% |

Four findings follow, and they are the specification:

**2.1 — There are three vegetation tones, not two.** The mid tier holds a quarter of the area. A strict two-tone split will not reproduce this frame. Use three flat stops.

**2.2 — The tonal ladder is a hue rotation, not a brightness ramp.** Hue steps monotonically 148.6° → 138.3° → 127.6°, about 10.5° per stop, while saturation roughly halves each stop (0.79 → 0.34 → 0.17). **Never produce the lit tone by multiplying the dark tone by a scalar.** Total dark-to-light rotation is **21.0°** — which independently matches the forest hue-shift magnitude of ≈21° already recorded in `00_ART_DIRECTION.md` rule 2, sampled from a different frame. Two independent frames agreeing to a tenth of a degree is strong evidence the rule is real.

**2.3 — The lit tone is sparse.** 7.6% of the vegetated area, not the ~50% a Lambert half-lambert would give. This directly sets dab density; see §8.3.

**2.4 — Mark scale is near-equal between tiers.** Dark blobs measure ~8.2 px equivalent diameter, light dabs ~7.9 px, a ratio of 0.96. The lit marks are not small speckles on large masses; they are comparably sized dabs of a different colour. Absolute world scale is **not** determined — it depends on the frame's unknown ground footprint, so treat these as a ratio and tune the metre value against §10.

Caveats stated plainly: the 68/24/8 split is specific to a densely vegetated window and is not a global target; a sparser hillside will invert it. Absolute saturation is higher in this frame than in the frame the bible's palette came from — the **hue relationships transfer, the absolute saturation does not**.

---

## 3. The four-layer compositing order

The land is now a four-layer stack. Every layer may coexist at the same XZ position; an oak forest does not erase the long grass or the dried-grass variation beneath it.

1. **A0 — base topography:** sand, cliff rock and light green short grass.
2. **A1 — dried-grass colour patches:** small light-yellow/ochre patches composited inside the light-grass material. This is a colour/material sublayer on A0, not raised geometry.
3. **B — longer dark-green grass:** the raised, alpha-clipped normal-offset overlay.
4. **C — oak forest:** independently masked oak crowns/canopy hulls above B.

Render/depth order follows that list, but **distribution is not mutually exclusive**. A forest pixel may contain A0 light grass, A1 dried grass, B long grass and C oak canopy simultaneously. The upper layer occludes the lower one only where its geometry is visible.

### 3.1 Independent but coordinated control textures

Use three distinct world-space, mipmapped control fields:

| Field | Purpose | Character |
|---|---|---|
| `uDryGrassMask` | Small dried-grass flecks within the A0 light-grass material | Fine, sparse, soft-edged patches |
| `uLongGrassMask` | Occupancy of raised B dark/long grass | Medium-scale irregular patches |
| `uForestMask` | Probability and density of C oak forest | Broad, low-frequency forest regions |

Do **not** reuse one noise sample at three thresholds. That produces visibly nested contour lines. Start from separate seeds and scales, then optionally correlate them with one shared, very-low-frequency moisture/biome field. This lets oaks prefer greener/moister areas without forcing every forest edge to trace the long-grass or dried-grass edge.

```glsl
float biomeMoisture = texture(uBiomeMacro, worldXZ / uBiomeScale).r;
float dryRaw        = texture(uDryGrassMask, worldXZ / uDryScale).r;
float longRaw       = texture(uLongGrassMask, worldXZ / uLongScale).r;
float forestRaw     = texture(uForestMask, worldXZ / uForestScale).r;

float dryPatch  = 1.0 - smoothstep(uDryLow, uDryHigh, dryRaw + 0.25 * biomeMoisture);
float longGrass = smoothstep(uLongLow, uLongHigh, longRaw + 0.15 * biomeMoisture);
float forest    = smoothstep(uForestLow, uForestHigh, forestRaw + 0.35 * biomeMoisture);
```

The coefficients are starting points, not measured truths. All coordinates are world anchored, never screen anchored.

## 4. Tier A0/A1 — base topography and dried grass

One opaque heightfield mesh. Four materials in a packed RGBA control texture: treat RGB as three painted weights and derive the fourth as the normalised remainder, the pattern shown in the three.js splatting example ([three.js forum, multi-textured terrain](https://discourse.threejs.org/t/how-to-create-a-multiple-textured-terrain/5069)). Four is also the practical ceiling per texture pass in Unity's documented model ([Unity Terrain Layers](https://docs.unity3d.com/6000.5/Documentation/Manual/class-TerrainLayer.html)).

- **Materials:** sand, cliff rock, **light green short grass/pasture**, one variation slot (dirt or bare karst).
- **Dried grass A1:** within the light-grass branch only, apply `uDryGrassMask` as small sparse patches of a light yellowish, sun-dried grass colour. It must not tint sand, rock or the B long-grass overlay.
- **Dried-grass shape:** many small, soft irregular islands with generous clear light-grass space between them. Do not create a continuous yellow biome, evenly distributed speckle, or large desert-like stains.
- **Dried-grass blend:** authored two-colour interpolation or a hard/soft painted threshold, not a brightness multiply. The dried colour is a separate palette entry and must remain subordinate to the light green base.
- **Rule modifiers:** bias painted weights by slope and height rather than replacing them. `THREE.Terrain`'s `generateBlendedMaterial` is the concrete three.js precedent, blending layers by elevation, slope and location with blend-in/opaque/blend-out levels ([THREE.Terrain](https://github.com/IceCreamYou/THREE.Terrain)). Its literal sample values are demo units, not settings to copy.
- **Cliffs:** world-space triplanar projection on the x/y/z planes blended by surface normal, which is documented as a standard fix for stretched terrain UVs on large terrain ([Unity Triplanar node](https://docs.unity3d.com/Packages/com.unity.shadergraph@14.0/manual/Triplanar-Node.html)). Apply to the rock branch only.
- **Anti-tiling:** two scales, not one. A very low-frequency hand-painted colour/biome field defining readable masses, plus one or two decorrelated world-space detail noises. Frostbite's principle is exactly this — unique low-frequency colour combined with tiled high-frequency detail and per-detail masks ([Frostbite chapter](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/chapter5-andersson-terrain-rendering-in-frostbite.pdf)); Frictional describe packing mask channels to blend more layers in fewer passes and varying cache resolution with LOD ([Frictional Games, terrain textures](https://frictionalgames.com/2010-11-tech-feature-terrain-textures/)). Eastshade's shipped equivalent was a three-channel vertex splat plus a macro overlay ([Eastshade devblog](https://eastshade.com/foliage-optimization-in-unity/)).

There is **no** established named method called "stochastic patch-boundary blending". Do not use that phrase; the two-scale approach above is the defensible version of the same goal.

---

## 5. Tier B — raised patchy long-grass overlay

This is the slightly higher, patchy **longer dark-green grass** layer, and it is the tier the user's model gets most right. Reframed to match §2: it is the dark value underpainting beneath the oak crowns.

**Geometry: a topology-matched copy, not a decal.**

1. Generate the base tile mesh from the heightfield.
2. Generate a second mesh on the **same vertex grid and tile boundary**.
3. In its vertex shader evaluate the *same* height and normal as the base, then displace along that normal by `vegetationOffset`.
4. Sample `uLongGrassMask` (medium-scale art-directed dark islands) times a separately seeded high-frequency breakup mask; `discard` uncovered fragments.
5. Surviving fragments are opaque and write depth. The base shows through the holes.

Deriving both meshes from one height/normal evaluation is what prevents seams, hovering and LOD desynchronisation. Change their LOD together, always.

**Material policy.** Alpha test, not blending. three.js `alphaTest` discards fragments below the opacity threshold, letting survivors take part in ordinary depth test/write; `transparent` objects get special treatment and render after opaque ones, which a clean cel-painted ground layer does not want ([three.js Material source](https://raw.githubusercontent.com/mrdoob/three.js/dev/src/materials/Material.js)).

```js
overlayMaterial.transparent = false;
overlayMaterial.alphaTest = 0.5;       // art-tune; semantics are documented, this value is not
overlayMaterial.depthTest = true;
overlayMaterial.depthWrite = true;
overlayMaterial.polygonOffset = true;  // tiny safety bias only, never the "height"
overlayMaterial.polygonOffsetFactor = -1;
overlayMaterial.polygonOffsetUnits = -1;
```

**Why the naive version fails, and the fix order.** Near-coincident copies quantise to the same depth and flicker. Fix in this order:

1. **Real geometric separation** along the normal. This is the primary solution, not a trick.
2. **Alpha test** so holes need no sorting.
3. **Polygon offset as a small bias only.** `polygonOffsetFactor` gives a slope-dependent term and `polygonOffsetUnits` a constant implementation-specific one ([three.js Material source](https://raw.githubusercontent.com/mrdoob/three.js/dev/src/materials/Material.js)); make them only just large enough, since an extreme near/far ratio worsens z-fighting and the values need tuning against the actual depth convention ([three.js forum, polygon offset](https://discourse.threejs.org/t/the-polygon-offset-is-not-correct-when-viewed-from-the-front/57631)).
4. **Tighten the camera depth range.** Do not use an arbitrarily huge far plane.
5. **`logarithmicDepthBuffer` only as escalation** — it can reduce fighting but affects techniques that are not depth-buffer aware ([same thread](https://discourse.threejs.org/t/the-polygon-offset-is-not-correct-when-viewed-from-the-front/57631)).

**Never rely on `renderOrder`.** It chooses draw sequence; it creates no depth separation between coplanar fragments.

**Clamp the offset on steep ground.** A normal-offset skin reads well from above and vanishes toward grazing angles — fins exist in the original technique precisely to preserve volume in such views ([NVIDIA](https://developer.download.nvidia.com/SDK/10/direct3d/Source/Fur/doc/FurShellsAndFins.pdf)). This camera is top-down and oblique, so one overlay is viable; reduce or kill the offset on cliffs where it would peel.

**Do not escalate to many shells.** Multi-shell stacks demonstrate 5, 10 and 40 layers with per-layer colour-buffer bandwidth and blending cost ([Procedural Pixels, shell texturing vs raymarching](https://www.proceduralpixels.com/blog/shell-texturing-vs-raymarching)). At 200–1500 m there is no resolvable sub-canopy volume to buy. One layer.

---

## 6. Why a single overlay, and not Unity/Unreal's built-in path

Neither engine establishes a "raised duplicate terrain" layer. Their architecture is **one blended surface plus a separately managed vegetation representation**: Unity's Terrain Layers carry surface material, while its *details* — grass and small objects — render as textured quads or meshes with their own Detail Distance cull and density scale, and Unity warns a short detail distance visibly pops ([Unity details](https://docs.unity3d.com/6000.1/Documentation/Manual/terrain-Grass.html), [Unity terrain settings](https://docs.unity3d.com/6000.5/Documentation/Manual/terrain-OtherSettings.html)). Unreal's equivalent vocabulary is Landscape Grass Type ([Epic grass quick start](https://dev.epicgames.com/documentation/en-us/unreal-engine/grass-quick-start-in-unreal-engine)).

So Tier B belongs to the *decoration* half of that split, implemented differently because our vegetation is a painted value mass rather than scattered blades. Note that the best-known Unity shell-grass implementation explicitly does not work on Unity Terrain and does not work on WebGL, because it depends on geometry shaders ([michael-sacco/grass](https://github.com/michael-sacco/grass)) — it is not a portable precedent for this target.

---

## 7. Tier C — oak forest, and the one correction to the proposal

**The proposal said trees should be vertical planes. For this camera, that is wrong as the primary representation.**

This is not a stylistic objection, it is what the reference shows. At the altitude of `peninsula-coastline-aerial-clouds`, almost no individual tree silhouettes resolve — forest reads as texture on a mass, and §2.4 measures the lit marks as comparably sized to the dark ones, i.e. dabs across a surface, not crowns standing on it.

The technical reasons agree:

- **Camera-facing cards rotate with the camera.** They preserve apparent width at every heading, which is exactly why they are a long-standing foliage technique ([GPU Gems 2](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-1-toward-photorealism-virtual-botany)) — and exactly the defect here. As the plane circles, every crown turns to face it, destroying any fixed sun-side dab placement. Turning stickers, no parallax.
- **Cross planes collapse from overhead.** GPU Gems contrasts its screen-facing quad with a fixed three-quad clump and notes the clump progressively breaks down as the view becomes more directly overhead ([GPU Gems 2](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-1-toward-photorealism-virtual-botany)). A vertical plane seen from above has near-zero projected area and shows its X.
- **Alpha cards cost fill rate at scale.** Eastshade identifies draw calls as the primary forest optimisation problem ([Eastshade](https://eastshade.com/foliage-optimization-in-unity/)); Crysis found its two-pass alpha test/blend quality-to-efficiency ratio not worthwhile ([GPU Gems 3, ch. 16](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis)).

**Use clustered oak canopy hulls instead.** Partition `uForestMask` into a world grid of 32–128 m cells, generated deterministically from `(cellX, cellZ, biomeSeed)` so cells stream without storing per-tree transforms — the grid-cell organisation GPU Gems describes for outdoor vegetation ([GPU Gems 2](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-1-toward-photorealism-virtual-botany)). A cell is eligible only where the forest mask passes its threshold and terrain constraints permit trees; its sampled mask value controls oak density and hull coverage. Per eligible cell, place 1–4 overlapping irregular low-poly hulls: a 6–20 triangle broad dome, or 3–6 tilted convex polygon planes biased **upward** so top-down views have area. Randomise radius, height and outline.

### 7.1 Forest distribution texture

`uForestMask` is the single source of truth for where generated forest exists. It must be a broad, low-frequency, world-space grayscale texture or baked procedural field with domain-warped boundaries:

```glsl
float forestNoise  = texture(uForestMask, warpedWorldXZ / uForestScale).r;
float suitability  = gentleSlope * inlandOrSheltered * biomeMoisture;
float forestWeight = smoothstep(uForestLow, uForestHigh, forestNoise * suitability);
```

- Use a broad scale so forest reads as coherent groves and woods from the aircraft, not evenly scattered trees.
- Multiply by suitability rather than letting noise put oaks on beaches, sheer cliffs, roads, villages or water.
- Use the continuous `forestWeight` for density and LOD handoff; use blue-noise points only for local near-oak placement within eligible cells.
- Author or bake the mask per island/chunk so the same field drives near oak instances, C2 canopy hulls and C3 forest colour in the terrain. This prevents the forest footprint from changing with LOD.
- `uForestMask` does **not** suppress A1 dried grass or B long grass. Those lower layers continue beneath the forest and can show through canopy gaps.

### 7.2 Oak-only species and silhouette rule

All procedurally generated forest trees are **oak-style broadleaf trees only**. No conifer, cypress, stone pine, Aleppo pine or mixed-species forest may be generated by `uForestMask`.

- **Near oak:** short-to-medium trunk; broad, spreading asymmetrical crown; clustered rounded lobes; no individual leaves; no visible bark texture.
- **Mid oak:** 2–5 overlapping rounded/irregular crown planes or one low-poly broad crown, with a coherent synthetic normal.
- **Aerial oak:** overlapping broad canopy hulls. Variation comes from crown width, height, lobe placement, palette ID and rotation, not species swapping.
- Use 3–6 reusable oak crown templates so an oak-only forest does not become a field of identical domes.
- Cypress or pine, if retained elsewhere for period/location character, must be manually tagged **non-forest landmark vegetation** and must never be spawned by the forest mask.

The aggregate-LOD principle behind this is established — BroadLeaf describes a hierarchy of leaf LODs accelerating selection and culling ([BroadLeaf, GDC](https://www.gdcvault.com/play/1028728/BroadLeaf-Real-Time-Cinematic-Rendering)), and Epic uses upper-hemisphere impostors for distant Fortnite trees when Nanite is off ([Epic Impostor Baker](https://dev.epicgames.com/documentation/en-us/unreal-engine/impostor-baker-plugin-in-unreal-engine)). But "canopy hull" and "canopy card" are **descriptive labels, not published technique names** — use them internally without implying they are named AAA techniques.

**Where vertical planes are still correct** — keep them, scoped:

- Ridge lines silhouetted against sky, where the vertical profile is the whole point.
- Isolated landmark oaks, which are read as broad asymmetrical shapes.
- Near/low flyover, where crowns occupy real screen area.

**Octahedral impostors: not the starting point.** They genuinely solve view change — full-sphere and upper-hemisphere bakes capture a grid of views and the runtime blends the three nearest frames ([Epic Impostor Baker](https://dev.epicgames.com/documentation/en-us/unreal-engine/impostor-baker-plugin-in-unreal-engine)), with the octahedral layout being a texture-space efficiency gain over older impostor workflow ([Brucks, *Octahedral Impostors*](https://shaderbits.com/blog/octahedral-impostors/)). But Epic's documented example bakes 144 frames per asset, and at our altitude the player reads a patch, not a crown. Reserve them for hero trees and near/mid LOD only. The three.js ecosystem work here is explicitly work-in-progress: the octahedral-impostor repository is marked WIP ([agargaro/octahedral-impostor](https://github.com/agargaro/octahedral-impostor)) and its forum thread describes a 200k-tree demo with mesh LOD to 100 and impostors beyond, while participants report interpolation-line artifacts ([three.js forum](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735)). Useful lead, not a dependency.

---

## 8. Lighting: the part that actually creates the painted look

### 8.1 Override the normals

Per-leaf or per-card normals give a rapidly changing field of Lambert dots that shifts with camera motion and mip level — the opposite of a painted mass. Suppress them and light the aggregate crown with one smooth coherent normal field.

This is established tooling practice, not a hack: SpeedTree exposes global and local vertex-normal modification for leaves and fronds specifically for lighting control ([SpeedTree lighting docs](https://docs9.speedtree.com/modeler/doku.php?id=lighting-leaves-and-fronds)), and stylised-tree workflows build custom radial/spherical normals ([Stylized Tree Shader Tutorial](http://www.aversionofreality.com/blog/2022/8/7/stylized-tree-shader)).

```glsl
// worldPos is the deformed hull vertex; every term is stable in world space.
vec3 q       = (worldPos - aCanopyCenter) / aCanopyRadius;   // ellipsoid coords
vec3 radialN = normalize(q);
vec3 canopyN = normalize(mix(vec3(0.0, 1.0, 0.0), radialN, uNormalSpread));
// uNormalSpread ~0.35–0.75: low = broad top-lit mass, high = rounder sun-side split
```

`canopyN` must be fixed to the world, **never** to the view. Then `dot(canopyN, sunDir)` yields a sun-side mass that stays put while the aircraft circles. Normal-map contribution at this LOD: 0–10%, or none.

**Honest caveat.** It is widely repeated that *Breath of the Wild* and *Genshin Impact* use exactly this spherical/flattened-normal trick. No primary Nintendo or miHoYo source verifying that was located — the official Genshin GDC session is art-direction and open-world, not a foliage-shader disclosure ([GDC Vault](https://www.gdcvault.com/play/1027539/-Genshin-Impact-Crafting-an)). Cite those games as visual references; describe the implementation as a proven general stylised-foliage workflow, not as verified reverse engineering.

### 8.2 Quantise to three flat stops

Per §2.1 the reference has three vegetation tones, so use three thresholds, not two. Cel shading's documented pattern already supports shadow, key and highlight bands ([Flax](https://docs.flaxengine.com/manual/graphics/shaders/cel-shading.html)).

Palette from §2, hue-rotating and desaturating up the ladder:

| Stop | Hex | Role |
|---|---|---|
| Shadow | `#084c29` | the mass, and Tier B's colour |
| Mid | `#366f48` | transition body |
| Lit | `#749d79` | sun-facing dabs |

These are this frame's values. Reconcile against the bible's `#1f4e38` / `#45764e` before committing: the **hues** agree closely (148.6° vs 151.9°, 127.6° vs 131.0°), the saturations do not, because this frame is graded hotter. Prefer the bible's saturation, this frame's hue ladder and coverage.

### 8.3 Sun-gated, world-anchored dabs

```glsl
uniform vec3  uSunDir;      // normalised, surface toward sun
uniform vec3  uCanopyDark, uCanopyMid, uCanopyLight;
uniform float uSplitMid, uSplitLit;   // e.g. 0.15, 0.45
uniform float uDabDensity;            // ~0.08 per §2.3
uniform float uDabScale;              // world metres per dab
uniform sampler2D uDabNoise;          // mipmapped, tileable, soft irregular shapes

float noL = dot(normalize(vCanopyNormalWorld), normalize(uSunDir));

// World-anchored lookup — never screen space, or it shimmers under flight.
float dabValue = texture(uDabNoise, vWorldPos.xz / uDabScale).r;

float midMask = step(uSplitMid, noL);
float litMask = step(uSplitLit, noL) * step(1.0 - uDabDensity, dabValue);

vec3 c = mix(uCanopyDark, uCanopyMid, midMask);
c      = mix(c,           uCanopyLight, litMask);
```

Deliberately **not** `base * max(noL, 0.0)`. A smooth Lambert multiplier produces the airbrushed gradient the reference does not have.

Rules that follow from the measurements:

1. Two spatial frequencies: broad 20–80 m modulation splitting masses, and dab shapes within the lit side at the scale set by §2.4's near-1.0 size ratio — dabs comparable to the masses, not fine speckle.
2. `uDabNoise` must be hand-painted or authored round/irregular shapes, **not** high-frequency white noise, sampled in world coordinates so mips can remove unstable detail with distance.
3. Per-cell palette variation via `hash(cellId)` picking among 2–4 stop-triples, applied **before or after** the quantisation decision — never per pixel.
4. Drive the coverage mask from the same painted map that controls forest distribution. Authored masses beat random placement; this is Meier's stroke-adhesion requirement applied to terrain ([Disney publication](https://disneyanimation.com/publications/painterly-rendering-for-animation/), [terrain NPR paper](https://cvit.iiit.ac.in/images/ConferencePapers/2008/Shiben08Painterly.pdf)).

### 8.4 No translucency at canopy LOD

Foliage translucency is a real cheat for individual leaves — Crysis used double-sided foliage, alpha-tested leaves and an artist-made map in a subsurface approximation ([GPU Gems 3, ch. 16](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis)), and Horizon's vegetation G-buffer carries translucency amount and diffusion ([Guerrilla, GDC 2018](https://ubm-twvideo01.s3.amazonaws.com/o1/vault/gdc2018/presentations/gilbert_sanders_between_tech_and.pdf)).

For a flat painted canopy it **hurts**: it adds a smooth light-dependent halo inside the dark mass, weakens the graphic split, and leaks the lit colour onto the wrong side. Omit it at Tier B/C. If a low sun needs a rim, add a quantised flat third colour gated on a silhouette mask — not physical transmission.

---

## 9. Distance behaviour and the far handoff

Beyond the range where a hull's patch edge approaches subpixel, an alpha-cutout layer stops being thickness and becomes temporal noise. Fade Tier B and C out and **bake their low-frequency dark coverage into Tier A0's colour**. The distant terrain must use the same three-stop palette and same sun-side convention, or the lighting language visibly changes at the boundary.

Select LOD by **projected screen size, not fixed metre thresholds**, with per-cell hysteresis and a capped update budget. three.js `LOD` provides level distances plus a hysteresis factor for exactly this flicker problem, but manage large forests at cell level rather than one `LOD` object per tree ([three.js LOD](https://threejs.org/docs/pages/LOD.html)).

For distant representation, prefer palette-bearing vertex colours over textures. Frame analysis of *The Witness* reports low-LOD detail stored as vertex colours rather than textures, alongside aggressive LOD and mesh merging ([Thomas Poulet, frame analysis](https://blog.thomaspoulet.fr/posts/the-witness-frame-analysis-part-2/)) — secondary reverse engineering, so treat as analysis not postmortem, but it is directly compatible with a stylised web terrain.

Aerial perspective should be a **distance-to-biome palette interpolation**, per rule 5's land curve, not literal grey fog. Sable's reported approach layered flat shading with distant fog customisable per biome and lines that faded with distance to aid perspective and hide object fade-in ([GameDeveloper on the Sable GDC talk](https://www.gamedeveloper.com/marketing/how-shedworks-refined-the-art-of-sable-in-pursuit-of-readability), [GDC session](https://gdcvault.com/play/1027721/The-Art-of-Sable-Imperfection)) — the single most transferable precedent for distant readability here.

### Failure modes

| Failure | Cause | Fix |
|---|---|---|
| Overlay seams or hovers | Base and overlay picked different LOD grids, normals or height samples | Derive both from one evaluation; switch LOD together |
| Patch boundaries swim | Coverage sampled in unstable coordinates | Sample in world/terrain space; share the low-frequency field |
| Far layer moirés | Cutout detail became subpixel | Mip the coverage, raise threshold contrast with distance, then hand off to Tier A0 |
| Cracks at tile edges | Offset normals differ at chunk borders | Share border vertices/normals or reconstruct from the same global height function |
| Detail pop | Abrupt density cutoff | Cross-fade over a band; Unity documents the same concern for short detail distances ([Unity terrain settings](https://docs.unity3d.com/6000.5/Documentation/Manual/terrain-OtherSettings.html)) |
| Canopy glitters | Per-card normals survived | §8.1 — override them |

---

## 10. Amendments to `03_ISLANDS.md` §8

§8.1, §8.2, §8.3 and §8.4 are now all amended. Generated forest species are oak-only; the older cypress/stone-pine forest set no longer applies. The density map is specifically `uForestMask`, shared by all forest LODs. The LOD table is replaced below.

**What was wrong.** The old table put cross-billboard impostors across 150–500 m and deferred canopy-as-mass to 500 m+. §7 shows cross planes lose projected area from overhead, which is the dominant view in this game, so that band was doing the least reliable thing across the most-used range. The old §8.2 anticipated the *rotation* problem — it specified fixed angles rather than full billboarding — but not the *overhead area collapse*. Canopy-as-mass must start much closer.

**Revised LOD table:**

| LOD | Selection rule | Representation | Triangles |
|---|---|---|---|
| C0 near | crown is an identifiable object (≈0–120 m) | InstancedMesh low-poly oak hero shape | 8–24 |
| C1 mid | clumps still occupy material screen area (≈120–350 m) | 2–5 tilted, mostly opaque crown planes or a tiny low-poly crown; coherent clump normal | 6–20 |
| C2 primary aerial | forest reads as patches (≈350–1200 m) | **1–4 irregular canopy hulls per 32–128 m cell** — the main look | 6–20 per hull |
| C3 far | hulls approach subpixel (≈1200 m+) | coverage and palette baked into Tier A0 material | 0 |

Metre figures are starting points for the screen-size rule, not thresholds to hard-code.

**Also amended:** cross-billboards are demoted from "the mid-range representation" to a scoped tool for ridge silhouettes and isolated landmark oaks (§7). The `#1f4e38`/`#101d19` pair in old §8.2 becomes the three-stop ladder of §8.2.

**Still binding:** silhouette over detail, `InstancedMesh` per oak-template family per chunk with per-chunk bounding-box updates, blue-noise local placement inside the forest mask, and wind sway by world XZ with instance phase offset.

---

## 11. Starting parameters

Proposed tuning ranges, in metres. **Not from any source** — no cited work provides a universal terrain-overlay scale.

| Knob | Start | Test criterion |
|---|---|---|
| A0 grass palette | light green short grass | Dominant exposed-ground colour; never dark enough to merge with B |
| A1 dried-grass coverage | sparse, initially 4–12% of eligible light grass | Small yellowish dead-grass patches, not a biome |
| A1 patch scale | materially smaller than B patches | Visible variation without competing with the long-grass/forest composition |
| Tier B normal offset | 0.15–0.60 m on gentle ground, tapering to 0 on cliffs | Enough separation to kill coincidence and show an edge cue, without peeling |
| Tier B coverage threshold | 0.42–0.62 | Contiguous dark islands vs broken ground |
| Tier B fade | by screen-space patch size, never a fixed world value | Begin the handoff before cutout holes shimmer |
| Forest-mask scale | broad enough to form multi-cell groves | No salt-and-pepper oak distribution |
| Forest threshold width | soft continuous weight before placement | Supports density gradients and stable LOD |
| Base material count | 3–4 first pass | Matches the four-per-pass model |
| Canopy cell size | 32–128 m | Larger than a hull, smaller than a hillside |
| Hulls per cell | 1–4 overlapping | Irregular outline without a repeating dome look |
| `uNormalSpread` | 0.35–0.75 | Raise if the scene reads uniformly top-lit |
| `uDabDensity` | ≈0.08, per §2.3's 7.6% | Compare lit-area fraction against the reference crop |
| Dab scale | tune so dab ≈ 0.9–1.0 × mass mark size | §2.4's measured ratio |
| Mid/lit splits | `uSplitMid` 0.15, `uSplitLit` 0.45 | Target ≈68/24/8 area split in dense forest |

---

## 12. Acceptance tests

1. **Sun lock.** Freeze the sun, orbit one forest patch. Lit dabs stay on the same world-space side; nothing rotates to face the camera.
2. **Top-down.** Pitch to near vertical. No cross-plane X or thin-card silhouette dominates.
3. **Normal override A/B.** Per-card normals vs synthetic canopy normals. The latter must read as one light/dark mass, not glittering facets.
4. **Dabs off.** With `uDabDensity = 0` the hard `noL` split should already read as a shaded crown. Dabs enrich; they must not be load-bearing.
5. **Depth shimmer.** Fly at 200, 500 and 1500 m over flat ground, ridges and cliffs. Base and overlay must never trade pixels.
6. **LOD sync.** Slow orbit while tiles change LOD. Overlay boundaries neither slide against the base nor crack at seams.
7. **Speed stability.** At full cruise, world-space mipped dabs must not sparkle or swim.
8. **Palette continuity.** View C1→C2→C3 transitions against the sun. Palette and light direction must match across all three.
9. **Histogram check.** Render a dense-forest region, cluster it k=3, and compare against §2's 68/24/8 and the 21.0° hue rotation.
10. **Fill rate.** Profile alpha on vs off. If alpha dominates, simplify to opaque hull silhouettes before adding LOD complexity.
11. **Layer overlap.** Find a location where A1, B and C all evaluate positive. Dried grass and long grass must remain present beneath canopy and show through valid gaps; no upper mask may destructively rewrite a lower mask.
12. **Noise independence.** Display the three masks side by side. Their borders must not trace one another, while forest can still show a broad ecological preference for greener/moister macro regions.
13. **Oak-only audit.** Inspect near, mid and aerial forest LODs. Every generated tree reads as a broadleaf oak crown; no conifer/cypress/pine silhouette appears.
14. **Forest LOD footprint.** Switch C0→C1→C2→C3 while viewing the mask edge. The occupied forest boundary must remain fixed because every LOD uses `uForestMask`.

---

## 13. Three.js implementation notes

- Instance hulls with `InstancedMesh` for per-instance matrices and colours, recomputing bounds after transform changes for correct culling ([three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)). Use `BatchedMesh` where a cell needs several hull templates under one material, since it supports per-object frustum culling and sorting ([three.js BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)).
- Custom `ShaderMaterial` for the world-space synthetic normal and palette quantisation ([three.js ShaderMaterial](https://threejs.org/docs/pages/ShaderMaterial.html)).
- Per-instance attributes: `canopyCenter.xyz`, `canopyRadius.xyz`, `seed`, `coverage`, `paletteId`, `oakTemplateId`.
- Bind `uDryGrassMask`, `uLongGrassMask` and `uForestMask` as separate mipmapped textures or as separate channels of an authored control atlas only if each channel was generated independently. Never derive all three by thresholding one channel.
- Cull by cell bounds before submitting instances. Keep dab noise a single shared mipmapped texture with per-cell offsets from `seed` — never one texture per cell.
- Reduce overdraw and draw calls before reducing the handful of triangles in a hull. Foliage is fill-rate and sorting limited; `BatchedMesh` docs call out sorting to mitigate overdraw artifacts ([three.js BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)).

**Prior art audit — what exists and what does not.** Useful leads: [THREE.Terrain](https://github.com/IceCreamYou/THREE.Terrain) for blended terrain materials and a demonstrated grass LOD update; [three.js splatting thread](https://discourse.threejs.org/t/how-to-create-a-multiple-textured-terrain/5069) for the base blend; [three.js offset-faces thread](https://discourse.threejs.org/t/offset-faces-of-a-buffergeometry/32757) for near-coincident overlay handling; [craftzdog/ghibli-style-shader](https://github.com/craftzdog/ghibli-style-shader) as Ghibli-adjacent art direction (a single tree, not a forest system); [santjc/threejs-shell-texture](https://github.com/santjc/threejs-shell-texture) as evidence the shell term is in use in this ecosystem, without terrain, LOD or depth policy.

Not found, and not to be overclaimed: no verified three.js/WebGL2 repository implements a splat-blended base plus a normal-raised alpha-clipped vegetation overlay with synchronised terrain LOD, and none implements canopy hulls with world-locked synthetic normals and quantised sun-direction dabs. No source establishes "stacked offset terrain layers" as a formal name. Acerola's shell-texturing material is provenance for the label, not a technical specification — anchor terminology on the NVIDIA and Hoppe sources instead.

**Optional final pass, with a warning.** A restrained gouache/paper treatment can be added last — [THREE.Watercolor](https://github.com/mattatz/THREE.Watercolor) is an `EffectComposer` watercolor pass with a paper texture, and [madblade/brush-renderer](https://github.com/madblade/brush-renderer) drives strokes from colour, log-depth and UV buffers. But a pure post effect over a detailed CG terrain reads as "CG through a filter". The painted quality has to come from the object-space structure above; only then is a screen-space pass worth adding. It must also respect the §5 renderer contract — `NoToneMapping`, FXAA not TAA.
