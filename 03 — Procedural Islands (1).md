# 03 — Procedural Island Generation
### Karst archipelago pipeline for the 1920s–30s Adriatic seaplane world
### Obeys `00_ART_DIRECTION.md`: painterly stepped shading, silhouette over detail, no visible tiling/noise, aerial legibility at 200–1500 m altitude, ≤1.2 M triangles / ≤40 draw calls for terrain across ocean + sky + 3 visible islands.

---

## 0. Why karst, and why it matters for the algorithm

The real Adriatic coast — the *type example* geographers use for this coastal class — is a **Dalmatian coast**: a folded limestone mountain range (the Dinarides) whose ridges run parallel to the shore, subsequently **drowned** by post-glacial sea-level rise. Ridge crests stand above water as long islands; folded valleys between them flood into channels. Real Adriatic islands are long, thin, and aligned NW–SE, not radial blobs — the shape is inherited from tectonic fold geometry, not erosion of a circular landmass ([UnlockIAS geomorphology reference](https://www.unlockias.in/bpsc-70th-cce-re-exam-2025-prelims-question-paper/q124-dalmetian-coast); [TheFreeDictionary geographic encyclopedia](https://encyclopedia2.thefreedictionary.com/Dalmatian+Coast+Type)). A University of Zadar paper confirms the coast is *locus typicus* of this pattern — "geomorphological and geological structures parallel to the coast and island chains with zig-zag channels among them" — and documents drowned dolines, uvalas and poljes plus karst springs emerging underwater, the fingerprint our mask/cove logic must reproduce ([Surić, *Submerged karst — dead or alive?*](https://geografija.unizd.hr/Portals/6/ip%20seminar/Suric%20Geoadria%2010-1.pdf); [Kelletat, *Dalmatian Coasts*](https://2024.sci-hub.se/3612/d504ebf09e433e0dfce270c37ec16033/kelletat2005.pdf)).

Three consequences drive every section below:

1. **Anisotropic footprint.** Islands are elongated along a dominant NW–SE axis with a much shorter cross-axis. A radial/Perlin blob island shape is wrong for this setting; the mask generator must be built around **skeleton curves**, not a distance-from-center falloff.
2. **Asymmetric cross-section.** The seaward (SW, exposed to open sea and *bora*/*maestral* wind-driven waves) flank is steep, denuded, cliffed. The landward (NE, sheltered) flank is gentler, often terraced by centuries of cultivation. This asymmetry must be baked into the heightmap generator, not left to chance.
3. **Karst hydrology.** Limestone is soluble; rainfall sinks through joints and bedding planes into underground conduits rather than forming surface rivers. Surface water appears only where the karst is "capped" by impermeable flysch/marl, or in isolated dolines and poljes. Rivers therefore must be *rare, short, and geologically justified* — not the default drainage network a naive flow-accumulation pass would produce everywhere.

---

## 1. Pipeline overview, determinism, chunking, streaming, LOD

### 1.1 Determinism

Every island is fully described by a **32/64-bit seed** plus a small parameter table (axis angle, length, width, ridge count, erosion iterations, biome thresholds). The seed feeds a splittable PRNG (`xoshiro128**` or a hashed counter) so sub-systems (footprint, erosion, vegetation, villages) each get an independent stream via `hash(seed, subsystemId)`. This guarantees the same island regenerates identically on any machine (needed for save-file consistency and the debug workflow in §10), and that chunked regeneration is order-independent — chunk `(x,z)` samples noise fields at world-space coordinates, not chunk-local indices, so neighbors agree at shared edges regardless of generation order (the three.js forum's standard answer to streaming-terrain seams: offset the noise domain by world position, not local index — [*Generate new terrain on movement*](https://discourse.threejs.org/t/generate-new-terrain-on-movement/4763)).

### 1.2 Heightmap vs. mesh decision

For 95% of the terrain — the rolling ridges, slopes, and plateaus — a **heightmap-displaced regular grid** is the right representation: one height sample per grid vertex, rendered as a plane mesh with vertex displacement (CPU-side `BufferGeometry` attribute or GPU vertex-shader displacement from a `DataTexture`/`EXRTexture`). It is cheap, streams well in square chunks, and is what nearly every three.js terrain demo uses. Only the sheer cliff bands and any sinkhole/arch features need geometry that a heightmap *cannot* represent (true overhangs, vertical or negative slopes) — for those we escalate locally to either a **lateral-fold trick** on the heightmap mesh or a **marching-cubes patch** dropped in only where overhangs are flagged (§3.4). This mirrors the standard heightmap-vs-volumetric tradeoff documented across the Sebastian Lague terrain series and forum threads on precision/format for heightmap textures ([three.js forum, *Terrain height map banding*](https://discourse.threejs.org/t/terrain-height-map-banding/53849)).

### 1.3 Chunking & streaming

- World is divided into a fixed grid of **512×512 m chunks**, each a separate `BufferGeometry` + one shared `ShaderMaterial` instance (draw-call budget matters more than triangle count per the art doc's ≤40 draw call target).
- Each chunk carries 3–4 **LOD levels** generated by halving vertex density (skirts added at LOD seams to hide cracks) — the same halving/skip-increment approach used in Sebastian Lague's LOD episode ([*Procedural Landmass Generation E06: LOD*](https://www.youtube.com/watch?v=417kJGPKwDg)) and in the classic *lod-terrain* CDLOD-style repo ([felixpalmer/lod-terrain](https://github.com/felixpalmer/lod-terrain)).
- Chunks stream in/out based on camera distance along the flight path, following the endless-terrain pattern (spawn ahead, unload behind, LOD by distance) documented in the Lague series episode 07 ([*Procedural Landmass Generation E07: Endless terrain*](https://www.youtube.com/watch?v=xlSkYjiE-Ck)) and echoed in three.js's own quadtree/chunked-LOD GitHub issue thread from the engine's early history ([mrdoob/three.js issue #507](https://github.com/mrdoob/three.js/issues/507)).
- A discourse thread on a full terrain-LOD three.js implementation is useful as a working reference: it splits terrain into chunks by render distance and offers wireframe/HUD debug modes similar to what we specify in §10 ([three.js forum, *Terrain Generation + LOD*](https://discourse.threejs.org/t/terrain-generation-lod/46411)).

### 1.4 Where generation happens

| Stage | Location | Why |
|---|---|---|
| Footprint mask, skeleton curves, biome fields | **Web Worker**, CPU, once per island (cached) | Deterministic, needs branching/graph logic (skeletons, Voronoi) that GPU shaders do poorly |
| Height synthesis (fBM, ridged, domain warp) | **Worker**, CPU, or **GPU via render-target** if resolution is high | Both viable; GPU wins at high chunk resolution |
| Hydraulic/thermal erosion | **GPU compute-via-render-target** (`GPUComputationRenderer`) | Erosion is inherently iterative-parallel per texel; unsuitable for main thread |
| Mesh assembly (vertex buffer upload) | **Main thread**, but built in worker and transferred via `Transferable`/`SharedArrayBuffer` | GPU upload must happen on main thread in WebGL2 |
| Instanced foliage placement | Worker (density sampling) + main thread (instance matrix upload) | Same reasoning |

`GPUComputationRenderer` is the standard three.js addon for exactly this "compute via render target" pattern — it manages ping-pong float render targets and per-texel fragment-shader compute steps ([three.js docs, GPUComputationRenderer](https://threejs.org/docs/pages/GPUComputationRenderer.html); usage examples: [epranka/gpucomputationrender-three](https://github.com/epranka/gpucomputationrender-three)).

---

## 2. Island footprint: ridge-aligned skeleton, domain-warped mask, Voronoi/erosion for peninsulas

### 2.1 Skeleton-first, not blob-first

Instead of Amit Patel's classic "start with radial noise, subtract distance-from-center" island shaping ([Red Blob Games, *Making maps with noise functions* — island shaping](https://www.redblobgames.com/maps/terrain-from-noise/islands.html)), we invert the order: **draw the skeleton first, then fill.**

1. Pick an island **spine**: a Catmull-Rom or Bezier curve of 3–6 control points, biased so its dominant direction lies within ±15° of a global archipelago axis (e.g. 305°, matching Adriatic NW–SE trend). Perturb the axis slightly per-island using the seed so a chain doesn't look mechanically parallel.
2. Generate 1–3 **parallel secondary spines** offset from the main spine (representing subordinate anticlines), each shorter, to be merged as attached peninsulas or nearby satellite islets — this reproduces the "many parallel ridges of varying prominence" structure of real Dalmatian chains.
3. Convert each spine into a **signed distance field** (distance to nearest point on the polyline). This SDF is the base "island-ness" field: `d(p) = distanceToSpine(p)`.

### 2.2 Domain-warped mask

Raw distance-to-spine produces a perfectly smooth sausage — too clean. Apply **domain warping** (Inigo Quilez's technique: distort the sample point with a noise field before evaluating the base function, `f(p + h(p))`) to the distance field before thresholding ([Inigo Quilez, *Domain Warping*](https://iquilezles.org/articles/warp/)):

```glsl
// q, r are 2D fbm-warp fields per Quilez's canonical construction
vec2 q = vec2(fbm(p + vec2(0.0,0.0)), fbm(p + vec2(5.2,1.3)));
vec2 r = vec2(fbm(p + 4.0*q + vec2(1.7,9.2)), fbm(p + 4.0*q + vec2(8.3,2.8)));
vec2 warpedP = p + 4.0 * r;
float d = distanceToSpine(warpedP);
float mask = smoothstep(coastWidth, -coastWidth, d); // 1 = land, 0 = sea
```

Two warp iterations are enough — three starts to erase the elongated silhouette the spine gave us, which defeats the point. Warp strength (the `4.0*r` multiplier) should scale with distance along the spine so headlands/points get sharper warp near the tips and the mid-island coast stays smoother.

### 2.3 Voronoi cut for pointy peninsulas and channels

To get the characteristic **pointed, knife-edge peninsulas** and **narrow channels** (not rounded coastal blobs), overlay a sparse **Voronoi diagram** seeded along the spine with jittered points, and use *cell boundaries*, not cell interiors, to carve slivers off the mask — this is the polygon-map technique popularized by Red Blob Games' `mapgen2` (Delaunay/Voronoi dual mesh, elevation-by-distance-from-coast) ([Red Blob Games, Mapgen2](https://www.redblobgames.com/maps/mapgen2/); source: [redblobgames/mapgen2](https://github.com/redblobgames/mapgen2)) and its alternative-to-Voronoi followup for when hard cell edges look too regular ([Red Blob Games, *Alternatives to Voronoi Diagrams*](https://www.redblobgames.com/x/1721-voronoi-alternative/)).

Practically: generate ~40–80 Poisson-disc points per island footprint, build the Voronoi diagram, then **subtract** a random subset of cells whose centers lie near the mask boundary and are aligned across-axis to the spine (i.e. subtract "transverse" slivers, keep "longitudinal" ones). This creates the fjord-like transverse channels and leaves long lateral peninsulas standing — visually close to real Dalmatian promontories like Pelješac or the fingers of Dugi Otok.

### 2.4 Archipelago layout & size distribution

- Lay out 6–14 islands per visible play region along the global chain axis using **1D Poisson-disc spacing** (minimum gap enforced) so islands don't cluster or leave the "70% empty sea" composition rule from the art doc (§3, rule 10) violated by clutter.
- Size distribution: **log-normal**, skewed toward many small islets and a few large "hero" islands — mirrors the real Croatian archipelago's ~1,200 islands where the overwhelming majority are small. Use `size = exp(μ + σ·N(0,1))` with `σ≈0.6` so the tail produces a handful of 6–10 km "hero" islands per ~50 km of coastline.
- Store each island as a lightweight descriptor object (`{seed, spineControlPoints, length, width, axisAngle}`) so far islands can exist as **data only** (no geometry) until the player's chunk-streaming radius reaches them (§1.3).

### 2.5 Prior art directly reusable for this step

- `mapgen4`'s six-layer noise elevation stack (frequencies 1×, 2×, 4×, 16×, 32×, 64×) plus a coastal-noise term that amplifies detail only within a band near sea level (`e_coast = e + α·(1−e⁴)·(n₄+n₅/2+n₆/4)`) is directly portable to our warp step ([mapgen4 source, `map.ts`](https://github.com/redblobgames/mapgen4/blob/master/map.ts); explainer: [Procedural Island Generation III, brashandplucky.com](https://brashandplucky.com/2025/09/17/procedural-island-generation-iii.html)).
- Amit Patel's original `mapgen2` uses corner-elevation-as-distance-from-coast plus Voronoi/Delaunay duals for rivers and ridges — the biome/elevation propagation logic is worth reading even though we replace the isotropic radial base shape ([Blobs in Games, *Polygon map generation part 1*](https://simblob.blogspot.com/2010/09/polygon-map-generation-part-1.html)).

---

## 3. Cliffs: sheer stratified limestone, exposed vs. sheltered asymmetry

### 3.1 Slope-based material blend (the workhorse)

The base cliff look comes from a **slope-threshold material blend** in the terrain shader: sample the heightmap gradient (via a Sobel-style neighbor read or analytic derivative if height is procedural), compute slope angle, and blend between "grass/scrub" and "limestone rock" albedo/ramp based on a smoothstep of slope:

```glsl
float slope = 1.0 - dot(normalize(worldNormal), vec3(0.0, 1.0, 0.0));
float rockMix = smoothstep(0.35, 0.55, slope); // ~20°–33° transition band
vec3 albedo = mix(vegetationRamp, limestoneRamp, rockMix);
```

This is the same technique behind `THREE.Terrain`'s `generateBlendedMaterial`, which blends textures by height range and by explicit slope GLSL expressions (`slope > 0.785 ? ...`) ([repcomm/THREE.Terrain docs](https://repcomm.github.io/THREE.Terrain/)).

### 3.2 Triplanar strata bands

Cliffs must show **horizontal stratification** (limestone beds), which a top-down UV projection cannot do on a near-vertical face. Use **triplanar mapping**: project three times (XY, XZ, YZ) weighted by the normal, and on the vertical (XZ/YZ) projections drive a 1D banding function off world-space **Y** so strata stay perfectly horizontal regardless of the cliff's rotation or the mesh's own UV layout:

```glsl
float band = fract(worldPos.y * stratFrequency + hash(floor(worldPos.y * stratFrequency)) * 0.15);
float stepBand = step(0.5, band); // hard two-tone strata edge, matches the art doc's stepped ramp rule
vec3 rockColor = mix(limestoneShadow, limestoneLit, stepBand);
```

Per the art direction's palette table, lit strata should map to `#cbc5ad`/`#d6d2cc` and shadow/strata lines to `#726f60`/`#534a40`/`#2e312b` — never a smooth gradient between them (rule 1, quantised ramp). `stratFrequency` should vary per-island (seeded) so bedding spacing differs between islands the way real anticlinal folds show different erosion-resistant layer thicknesses.

### 3.3 Vertical displacement / cliff carving

To get *sheer* (near-90°) faces rather than merely steep slopes, heightmap-only generation is insufficient — a smooth noise field's maximum slope is bounded by its frequency/amplitude ratio and rarely reaches vertical without looking artificial. Two complementary techniques:

1. **Slope-clamped erosion carving**: after base fBM + domain warp, run a pass that detects where the *unclamped* target slope (from a secondary high-frequency ridged mask, see §5) exceeds a "cliff threshold," and locally steepens by applying a smoothstep-based vertical scaling only within a narrow horizontal band — effectively "pushing" a talus-angle-limited slope into a near-vertical one over a short run, then letting talus/scree deposition (§3.4/§5.2) soften the base. This is the "stepping formula" approach independently converged on by practitioners: *"You can get cliffs by sending a continuous noisefield through a 'stepping' formula (basically turns gradients into rounded staircases)"* ([r/proceduralgeneration discussion on realistic terrain](https://www.reddit.com/r/proceduralgeneration/comments/zgnckn/making_realistic_terrain/)).
2. **Lateral-fold pseudo-overhang**: after height displacement, displace steep vertices a few metres *horizontally* in the downhill direction (noise-modulated), so the cliff band bulges outward before falling vertical — a cheap heightmap-compatible way to fake a slight overhang without leaving the single-height-per-XZ representation, at the cost of true caves/arches (documented as the practical middle ground between flat-cliff and full marching-cubes: [*Procedural Eroded Terrain in Three.js*, getbutterfly.com](https://getbutterfly.com/procedural-eroded-terrain-in-three-js-theory-techniques-field-notes/), §6.5).

### 3.4 Marching-cubes escalation for true overhangs

Where the design calls for an actual arch, sea cave, or negative-slope overhang (rare — reserve for 1–2 hero landmarks per map, e.g. a blowhole or natural arch akin to the real Adriatic's Punta Kriza-type formations), switch representation locally: define a 3D density field (fBM sampled in 3D, optionally warped) and extract an isosurface with **marching cubes**. Three.js ships this as an addon and official example:

- [`MarchingCubes` — three.js docs](https://threejs.org/docs/pages/MarchingCubes.html) (`three/addons/objects/MarchingCubes.js`)
- [three.js official example, `webgl_marchingcubes`](https://threejs.org/examples/webgl_marchingcubes.html)
- A more complete streaming/chunked marching-cubes voxel renderer built specifically for three.js: [danielesteban/softxels](https://github.com/danielesteban/softxels)

Because marching-cubes patches are triangle-dense and use a completely different texturing scheme (triplanar becomes *mandatory*, not optional, since surfaces face every direction), gate their use tightly: only instantiate a marching-cubes sub-volume within a small bounding box around a flagged overhang feature, never for general cliff terrain, to protect the triangle budget.

### 3.5 Exposed (SW) vs. sheltered (NE) asymmetry

This is the single most important cliff rule and is cheap to implement: compute the **cross-spine bearing** at each point (perpendicular to the local spine tangent) and use its dot product with the fixed "prevailing exposure" vector (pointing SW, toward open sea/bora fetch) as a per-vertex bias:

```glsl
float exposure = dot(normalize(crossSpineDir), exposureVectorSW); // -1..1
float cliffBias  = smoothstep(-0.2, 0.6, exposure);       // >0 on SW-facing flank
float terraceBias = smoothstep(0.2, -0.6, exposure);      // >0 on NE-facing flank
```

`cliffBias` multiplies the vertical-displacement strength from §3.3 (steeper, taller, whiter cliff on the SW flank). `terraceBias` multiplies the terracing pass from §5.3 (gentler slope broken into cultivation steps on the NE flank). This single dot-product term is what makes the island read as *geologically real* rather than a symmetrical noise blob, and it should be computed once per island and cached, not re-evaluated per frame.

---

## 4. Coves, bays, sinkhole harbours, seaplane lagoons

### 4.1 Cove carving from the Voronoi cut

Coves fall naturally out of §2.3's Voronoi-slice technique: any transverse Voronoi cell that is subtracted from the mask but doesn't fully sever the island becomes a bay. Classify each candidate bay by:

- **Mouth width** (distance across the opening) vs **depth** (distance from mouth to innermost point) — a ratio of depth:width > 1.5 with a mouth narrower than the interior flags a "hidden cove," ideal for a smuggler's inlet or seaplane hideout.
- **Depth of enclosing land** (average height of the rim) — high rims (>60 m) shelter the cove from wind, a prerequisite for calm-water seaplane operations.

### 4.2 Sinkhole (doline) harbours

Real Dalmatian islands show collapsed dolines right at the coast, some breached by the sea to form near-circular harbours with disproportionately deep water for their diameter — exactly the "caprock collapse sinkhole" morphology documented in karst literature on the Adriatic/Malta region ([Coratza et al., *Sinkholes of the Maltese archipelago*, University of Modena](https://iris.unimo.it/retrieve/e31e124a-b1bb-987f-e053-3705fe0a095a/Coratza_etal_2012.pdf)). Model these procedurally as a **secondary, sparse Worley/Voronoi noise** (cell centers = candidate doline sites, seeded independently from the peninsula-cutting Voronoi in §2.3) that locally subtracts a steep-walled circular depression from the heightmap:

```
depth(p) = -maxDolineDepth * exp(-(dist(p, dolineCenter) / dolineRadius)^2) * doineMask(p)
```

Only dolines whose depression floor drops below sea level become **flooded doline harbours**; those that don't reach sea level stay as dry karst depressions inland (visually distinct: a circular hollow with no water, useful for a hidden airstrip or a poljë-style flat cultivated basin — see §5 on poljes/plateaus).

### 4.3 Seaplane landing lagoons — gameplay-relevant generation rule

A safe seaplane lagoon needs three procedurally checkable properties, evaluated as a **post-pass classifier** over all generated coves/bays/doline-harbours on an island:

| Requirement | Procedural check |
|---|---|
| Calm water (wind shelter) | Rim height ≥ 40 m on the exposed (SW) side of the cove, computed via §3.5's exposure field |
| Sufficient clear run length | Longest unobstructed straight chord across the water polygon ≥ 400 m (rough 1920s-seaplane takeoff run) |
| Shallow-water hazard clearance | No `shelfDepth` sample (§ water doc's depth banding) shallower than ~1.5 m along the takeoff chord |

Bays passing all three are tagged `lagoon:true` in the island's feature metadata and become spawn/mission/refuel points; this makes the geological generation directly serve gameplay rather than being purely decorative — matching the brief's requirement that these be "gameplay-relevant features," and it is cheap to compute once at generation time and cache in the island descriptor.

---

## 5. Ridges, hills, plateaus: ridged multifractal, erosion, terracing

### 5.1 Ridged multifractal for the spine itself

The island's main ridge height profile (not just its footprint) uses a **ridged multifractal**: take absolute value of signed noise per octave to fold valleys into sharp ridgelines, a technique canonized by Ken Musgrave and popularized in shader form by Inigo Quilez's noise-derivative articles:

```glsl
float ridgedOctave(vec2 p) { return 1.0 - abs(noise(p)); }
float ridged(vec2 p, int octaves) {
    float sum = 0.0, amp = 0.5, freq = 1.0;
    for (int i = 0; i < octaves; i++) {
        float n = ridgedOctave(p * freq);
        n *= n;                 // sharpen the crease (standard ridge trick)
        sum += amp * n;
        freq *= 2.0; amp *= 0.5;
    }
    return sum;
}
```

This "fold sharp valleys, square to sharpen the crease" construction is the standard formulation used across shader/procedural-terrain literature ([derivative-fbm terrain paper summary](https://www.scribd.com/document/972223671/Book); background on fbm/noise derivatives: [Inigo Quilez, *value noise derivatives*](https://iquilezles.org/articles/morenoise/)). Feed the ridged field along the spine SDF from §2.1 so the *ridge crest itself* sits on the geological spine, and hills/foothills fall off from it — geologically this is the anticline crest.

### 5.2 Erosion passes (droplet hydraulic + thermal)

After the base ridged+warped heightmap, run:

1. **Hydraulic (droplet) erosion**: spawn N droplets at random high points, trace downhill using bilinear-interpolated gradient, carry sediment capacity proportional to slope×velocity, erode when under capacity, deposit when over. This is the canonical Sebastian Lague implementation, MIT-licensed and the most widely copied reference ([SebLague/Hydraulic-Erosion](https://github.com/SebLague/Hydraulic-Erosion); video walkthrough: [*Coding Adventure: Hydraulic Erosion*](https://www.youtube.com/watch?v=eaXk97ujbPQ); interactive demo: [sebastian.itch.io/hydraulic-erosion](https://sebastian.itch.io/hydraulic-erosion)). A from-scratch GPU-parallel formulation of the same idea is documented in the academic short paper "Fast Hydraulic and Thermal Erosion on GPU" ([Jákó & Tóth, Eurographics 2011](https://diglib.eg.org/items/0a286bee-1fc3-4e22-a717-81a5301a7e9b)) and implemented for a modern GPU pipeline in a UNO thesis writeup ([Hawkins, *Implementation of Fast Hydraulic Erosion Simulation and Visualization on GPU*](https://digitalcommons.unomaha.edu/cgi/viewcontent.cgi?article=1013&context=csworkshop)).
2. **Thermal erosion (talus relaxation)**: wherever a cell's slope to a neighbor exceeds the material's talus angle, move a fraction of the height difference downhill; iterate a handful of Gauss-Seidel passes. Use talus ≈ 30–38° for scree/soil zones, but on the SW cliff bias (§3.5) *raise* the talus threshold to ~60–65° so this pass only removes numerical spikes and never softens the intentional sheer faces — a dual-use of the same mechanism documented in field-notes form: *"As a guard: set talus to your maximum allowed steepness... so it only sands off numerical spikes without softening intentional cliffs"* ([*Procedural Eroded Terrain in Three.js*](https://getbutterfly.com/procedural-eroded-terrain-in-three-js-theory-techniques-field-notes/)).

Interleave the two: run a batch of ~1,000 droplets, then a few thermal-relaxation iterations, repeat — this alternation produces the mix of smooth valley floors and stable sharp ridgelines seen in real terrain and is explicitly recommended in erosion-tutorial writeups aimed at exactly this kind of pipeline ([mysimulator.uk erosion tutorial](https://www.mysimulator.uk/content/tutorials/terrain-generation-erosion.html)).

**Budget note**: run erosion once per island at generation time (cached to a heightmap texture, not per-frame), at a working resolution of ~512² regardless of final mesh resolution, then upsample. This matches the two-pass "512² macro erosion → 1024² fine detail" pattern used in the field-notes source above.

### 5.3 Terracing for cultivated slopes

On the NE (sheltered) flank, apply a **terracing function** to the final height before mesh generation — quantize height into discrete bands with a smoothed riser/tread profile, at a step height of ~2–4 m (period-appropriate dry-stone terrace scale for olive/vine cultivation):

```glsl
float terrace(float h, float stepHeight, float smoothness) {
    float stepped = floor(h / stepHeight) * stepHeight;
    float frac = (h - stepped) / stepHeight;
    return stepped + smoothstep(0.0, smoothness, frac) * stepHeight * (1.0 - smoothness);
}
```

Gate terracing by `terraceBias` (§3.5) and by a slope ceiling (terraces only appear where the *pre-terrace* slope is 5°–25° — steeper is left as scrub/rock, flatter needs no terracing) and by proximity-to-village fields (§9) since historically terracing clusters near settlements, not uniformly across a whole flank.

### 5.4 Plateaus and poljë-like flats

Karst poljes — large flat-floored closed depressions — appear as a rare feature: pick 0–1 per larger island, carve a broad, shallow, flat-bottomed basin (large-radius, low-depth Worley cell, distinct from the small sharp dolines of §4.2) sitting inland at moderate elevation, undrained (no outlet channel, consistent with §6's few-rivers rule), optionally containing a seasonal karst lake (§6.3).

---

## 6. Rivers and lakes: why karst has almost none, and how to place what little exists

### 6.1 The hydrological rule

In true karst, rainfall infiltrates through joints, bedding planes and dissolution channels into an underground conduit network rather than accumulating into surface streams — this is *the* defining hydrological signature of karst terrain and is explicit in the source material on submerged Adriatic karst (dolines/uvalas/poljes at the surface, with "freshwater karst springs occurring at the coast or even under the sea," i.e. water reappears at the shoreline, not as rivers crossing the island — [Kelletat, *Dalmatian Coasts*](https://2024.sci-hub.se/3612/d504ebf09e433e0dfce270c37ec16033/kelletat2005.pdf)). The generator must therefore actively **suppress** the dense drainage network a naive flow-accumulation pass would produce, and only permit rivers where geologically justified.

### 6.2 Where the few rivers are allowed to exist

Compute a standard **flow accumulation** field (D8 or D-infinity steepest-descent routing, or a droplet-tracing pass reused from §5.2's erosion droplets — each droplet's path already approximates a flow line). Then gate river formation by an **impermeability mask**: a sparse, low-frequency noise field marking patches of the island as "capped" by insoluble caprock/flysch (geologically: places where the limestone is overlain by clay/marl and cannot swallow the flow). Only accumulation-field cells *inside* an impermeable patch, above a flow threshold, become a rendered river segment:

```
isRiver(p) = flowAccumulation(p) > riverThreshold  &&  impermeableMask(p) > capThreshold
```

Tune `capThreshold` so impermeable patches cover only 5–10% of any island's area — most of the terrain remains river-free by construction, and what few streams exist are short, run from a mid-slope spring directly to the coast (matching real karst springs emerging at or near the shoreline), and never form a branching network more than 2–3 tributaries deep.

### 6.3 Lakes

Two lake types, both rare:

1. **Doline/poljë lakes** — the flooded floor of a large doline or polje (§4.2, §5.4) when its lowest point sits below the local water table proxy (approximate the water table as a smoothed, low-pass-filtered version of the terrain's own low points — a cheap stand-in for true groundwater simulation). These are small, closed, no visible inlet/outlet.
2. **Karst lakes fed by a capped spring** — where an impermeable patch's river (§6.2) terminates in a basin before reaching the coast (a dammed low point along its course) rather than draining directly to the sea. Render as a short river feeding a small lake feeding a short second river to the coast — modeling real examples like the Krka/Plitvice-style travertine-barrier lakes without needing full sediment simulation.

### 6.4 Waterfalls off cliffs

Wherever a qualifying river/spring segment's flow path crosses a cell flagged `cliffBias > threshold` (§3.5), terminate the river mesh at the cliff edge and spawn a **waterfall billboard/particle emitter** at that world position rather than continuing the river geometry down the vertical face (a heightmap-following river mesh cannot represent a vertical drop). This is a simple event-flag, not a simulated fluid — consistent with the art direction's "painted mark" philosophy (discrete dashes, not physically simulated foam).

---

## 7. Biome / cover assignment

### 7.1 Driving fields

Five scalar fields, each already available from prior stages, are combined per-vertex/per-texel:

| Field | Source |
|---|---|
| Altitude | Final eroded heightmap |
| Slope | Heightmap gradient magnitude |
| Aspect (exposure) | §3.5's exposure dot-product, signed by compass direction |
| Moisture | Low-frequency noise field, boosted near rivers/lakes/impermeable patches (§6), reduced with altitude and with SW exposure (bora-dried) |
| Distance-to-sea | Precomputed distance transform from the coastline mask (§2) |

### 7.2 Biome table

| Biome | Altitude | Slope | Aspect | Moisture | Dist-to-sea | Palette anchor (`00_ART_DIRECTION.md`) |
|---|---|---|---|---|---|---|
| Beach | ~0 m | flat | any | any | 0 m | `#cbc5ad` → `#ddd0a8` |
| Bare rock / cliff | any | steep or `cliffBias` high | SW-biased | low | any | `#cbc5ad`/`#726f60`/`#2e312b` |
| Macchia scrub | low–mid | gentle–moderate | SW-biased (dry) | low–mid | near coast | `#8eac71` |
| Dry pasture | low–mid | gentle | any | low | mid | `#a8b19d`/`#c8cdbe` |
| Dense forest | mid | gentle–moderate | NE-biased (sheltered, moister) | mid–high | inland | `#1f4e38`/`#101d19` |
| Sparse forest | mid–high | moderate | mixed | mid | mid–inland | `#45764e` |
| Terraced olive/vine | low–mid | terraced band (§5.3) | NE-biased, near villages | mid | near coast | `#6a955f`/`#8eac71` |

### 7.3 Irregular patch boundaries — the art-direction-critical part

The art bible is explicit: *"Break up large fields with irregular patch boundaries... rather than high-frequency texture"* and *"no visible tiling, no visible noise."* A raw per-texel biome lookup from continuous fields produces exactly the forbidden "noise mush" — speckled, high-frequency biome boundaries. Fix with a **two-stage assignment**:

1. Compute the continuous per-texel biome scores as above, but only at **coarse cell centers** of a second, independent Voronoi/Poisson-disc partition (cell size ≈ 30–80 m, larger than any building or tree cluster but smaller than a hillside).
2. Assign one biome per cell (the argmax score at the cell center, not per-texel), then render the cell boundary with a small (~3–6 m) domain-warped wobble so edges look hand-painted rather than polygonal.

This is precisely the biome-per-Voronoi-region method from `mapgen2`/`mapgen4` (assign biome once per polygon from elevation+moisture, not per pixel — [Red Blob Games, Voronoi maps tutorial](https://www.redblobgames.com/x/2022-voronoi-maps-tutorial/)), adapted so cell size matches "shape-scale variation," not texture-scale.

---

## 8. Vegetation rendering

### 8.1 Silhouette-first species set

**Superseded by `05_DISTANT_TERRAIN_LAYERING.md` §7.2.** All procedurally generated forest is oak-only: broad, spreading, asymmetrical broadleaf crowns built from clustered rounded lobes, never individual leaves or bark detail. Use 3–6 reusable oak crown templates so species consistency does not become geometric repetition.

Cypress, stone pine or Aleppo pine may exist only as manually tagged non-forest landmarks if the art direction later retains them. They must never be spawned by the forest distribution texture.

### 8.2 Instancing and LOD

**Superseded by `05_DISTANT_TERRAIN_LAYERING.md` §10.** The bullets and table below are retained only as research history; do not implement their cross-billboard distance bands.

- All near-range trees use `THREE.InstancedMesh` — one draw call per species per chunk, instance-matrix-driven position/rotation/scale, which is the consensus three.js approach for "thousands of repeating objects" (*"With InstancedMesh you lose frustum culling unless you manually update the bounding box"* — worth doing per-chunk, not per-tree — [three.js forum, *When is InstancedMesh worth it*](https://discourse.threejs.org/t/when-is-instancedmesh-worth-it-in-three/62044)).
- At mid distance, swap to a **cross-billboard impostor**: two crossed quads with the tree silhouette baked into an alpha-cutout texture, always facing a fixed set of angles (not full billboarding, to avoid popping when circling in a plane) — the standard mid-range LOD used in the three.js forest/instancing showcases ([three.js forum, *Procedural Instanced Forest*](https://discourse.threejs.org/t/procedural-instanced-forest-high-performance-real-trees/88610), which explicitly does LOD-in-shader by collapsing distant leaf quads to `gl_Position = vec4(0,0,0,1)` so the GPU culls them pre-fragment-stage).
- At far distance (dense-forest biome, viewed from altitude), **do not render individual trees at all** — replace with the "canopy-as-mass" technique: a single low-poly hull mesh matching the forest patch's silhouette, shaded with the same stepped forest-shadow ramp (`#1f4e38`/`#101d19`), optionally with a coarse noise-perturbed top surface for canopy bumpiness. This directly serves the art bible's "silhouette over detail" rule and the triangle budget simultaneously.

### 8.3 Density maps and wind

- Forest density comes from the broad, low-frequency world-space `uForestMask` defined in `05_DISTANT_TERRAIN_LAYERING.md` §7.1. The same mask controls near oak instances, aerial canopy hulls and far terrain colour so the forest footprint never changes with LOD.
- Blue-noise (Poisson-disc) jitter places individual near oaks only inside eligible forest-mask cells; it does not define the forest boundary. Blue noise avoids both clumping and grid-alignment artifacts, the same rationale used for peak/point placement in general island-generation writeups ([*Procedural Island Generation I*, brashandplucky.com](https://brashandplucky.com/2025/09/07/procedural-island-generation-i.html)).
- Wind: a simple per-instance vertex-shader sway driven by a shared low-frequency scrolling noise texture sampled by world XZ and instance ID phase-offset, consistent with the "simple instanced grass with wind displacement" pattern documented in the three.js forum ([*Simple instanced grass example*](https://discourse.threejs.org/t/simple-instanced-grass-example/26694)).

### 8.4 Budgets

**Superseded by `05_DISTANT_TERRAIN_LAYERING.md` §10.** Use the revised C0–C3 oak LOD table there.

| LOD | Range | Representation | Triangles/instance |
|---|---|---|---|
| Near | 0–150 m | InstancedMesh, low-poly hero shape | 8–24 |
| Mid | 150–500 m | Cross-billboard impostor | 4 |
| Far | 500+ m / dense canopy | Canopy-as-mass hull, 1 per forest patch | ~40–120 total for patch |

---

## 9. Villages and harbours placement rules

Villages are placed by a **constraint-satisfaction pass** run once per island after terrain + biome are finalized, not by hand or by pure noise:

1. **Candidate sites**: sample the flat-ground mask (slope < 8° over a 60 m radius) intersected with "near coast" (distance-to-sea < 150 m) intersected with "sheltered bay adjacency" (within 100 m of a bay/cove classified in §4, and preferring bays with `lagoon:true` for harbour-with-slipway variants).
2. **Score and pick**: rank candidates by a weighted sum of (a) shelter — high `exposure` bias toward NE/sheltered per §3.5, (b) flat area extent, (c) freshwater proximity (spring or capped-river outlet from §6.2, historically villages cluster at the rare freshwater points), (d) minimum spacing from other chosen village sites (≥1.5 km, enforced via rejection sampling).
3. **Layout**: place a small hand-authored footprint template (6–14 terracotta-roof dashes per the art bible's "a village is 6 terracotta dashes" rule) oriented to hug the shoreline curve, with 1–2 **slipways** (angled ramps into the water) placed only at sites also flagged `lagoon:true` or adjacent to gentle beach (§7.2), reflecting the seaplane-servicing role these harbours play in the setting.
4. **Campanile/landmark bias**: exactly one building per village template is tagged "campanile" and rendered slightly taller/narrower, both for period authenticity and as a *navigation landmark readable from altitude* — directly serving the art bible's aerial-legibility rule.

---

## 10. Budgets, timing, and the authoring/debug checklist

### 10.1 Budgets (rolling up to the art doc's global target)

| Resource | Budget | Notes |
|---|---|---|
| Terrain triangles (3 visible islands + LOD) | ≤ 1.2 M total (shared with ocean/sky per art doc) | Enforced via LOD table §1.3 |
| Terrain draw calls | ≤ 40 | One shared "gouache" material, merged chunk geometries where static |
| Foliage instances (near LOD) | ≤ ~150k live instances/frame | InstancedMesh per species per chunk |
| Heightmap working resolution (per island, pre-upsample) | 512×512 for erosion; up to 2048×2048 baked output | Matches the two-stage erosion→upsample pattern (§5.2) |
| Per-island generation time budget | < 150 ms worker time for footprint+height+biome; erosion amortized over several frames via GPU render-target ping-pong | Never block the main render thread |

### 10.2 Generation timing split

| Task | Thread | Rationale |
|---|---|---|
| Skeleton curves, Voronoi cut, biome cell assignment | Worker | Branching CPU logic |
| fBM/ridged/domain-warp height synthesis | Worker (low-res) or GPU render target (high-res) | Either viable; prefer GPU once island is in near-streaming range |
| Erosion (droplet + thermal) | GPU via `GPUComputationRenderer` ping-pong render targets | Iterative, texel-parallel, exactly the addon's design case ([GPUComputationRenderer docs](https://threejs.org/docs/pages/GPUComputationRenderer.html)) |
| Mesh vertex buffer construction | Worker builds typed arrays, transfers via `Transferable` | Avoids blocking main thread during streaming |
| GPU upload / draw call setup | Main thread | Required by WebGL2 |

### 10.3 Authoring/debug visualisation checklist

Ship a debug overlay (toggle key) with these views, each a direct visualization of an intermediate field from the pipeline above — this is standard practice in every terrain-generation series referenced in this document and dramatically speeds up tuning:

- [ ] **Skeleton view** — draw spine polylines + Voronoi cut cells over the map (validates §2.1–2.3 before any noise is applied).
- [ ] **Raw vs. warped mask** — side-by-side land/sea mask before and after domain warp (validates warp strength isn't erasing the elongated silhouette, §2.2).
- [ ] **Slope heatmap** — grayscale slope magnitude (validates cliff thresholding, §3.1, §3.3).
- [ ] **Exposure field** — red/blue diverging map of the SW/NE dot product (validates §3.5's asymmetry is actually asymmetric, not accidentally uniform).
- [ ] **Erosion delta** — wear map (rock removed) and deposition map (sediment added) from the droplet pass, so you can confirm gullies/scree aprons are forming where expected (§5.2).
- [ ] **Flow accumulation + impermeability mask overlay** — confirms rivers only appear inside capped patches and stay sparse (§6.2), catching the single most common failure mode (a naive port producing rivers everywhere).
- [ ] **Biome cell grid** — the coarse Voronoi partition from §7.3 with per-cell biome color, to visually confirm boundaries read as hand-painted patches, not per-pixel noise.
- [ ] **Lagoon/village candidate overlay** — bay classification flags (`lagoon:true`) and village candidate scores plotted as markers (§4.3, §9).
- [ ] **Triangle/draw-call HUD** — running totals against the §10.1 budget table, per chunk and cumulative.
- [ ] **Wireframe + LOD-tint mode** — color chunks by active LOD level to catch popping/seam bugs at streaming boundaries (the same wireframe/HUD debug mode used in three.js forum terrain showcases, [*Terrain Generation + LOD*](https://discourse.threejs.org/t/terrain-generation-lod/46411)).

---

## 11. Prior art — real three.js / web procedural terrain projects worth studying directly

| Project | What to take from it | Link |
|---|---|---|
| Red Blob Games — `mapgen2` (Amit Patel) | Voronoi/Delaunay dual-mesh biome & elevation propagation; original polygon island generator | [redblobgames.com/maps/mapgen2](https://www.redblobgames.com/maps/mapgen2/) · [source](https://github.com/redblobgames/mapgen2) |
| Red Blob Games — `mapgen4` | Six-octave layered elevation stack, painted mountains/valleys workflow, GPU-friendly design | [redblobgames.com/maps/mapgen4](https://www.redblobgames.com/maps/mapgen4/) · [source](https://github.com/redblobgames/mapgen4) |
| Red Blob Games — *Making maps with noise functions* | Canonical fBM/elevation/moisture/biome/island-shaping reference | [redblobgames.com/maps/terrain-from-noise](https://www.redblobgames.com/maps/terrain-from-noise/) |
| Sebastian Lague — *Procedural Landmass Generation* series | Chunked LOD, endless streaming terrain, seam-fixing, texture-from-heightmap shader | [SebLague/Procedural-Landmass-Generation](https://github.com/SebLague/Procedural-Landmass-Generation) |
| Sebastian Lague — *Hydraulic Erosion* | Reference droplet-erosion implementation (MIT license, 980+ stars) | [SebLague/Hydraulic-Erosion](https://github.com/SebLague/Hydraulic-Erosion) |
| Inigo Quilez — articles on fBM, domain warping, noise derivatives | Shader-level ridged/warped noise math used throughout §2, §5 | [iquilezles.org/articles](https://iquilezles.org/articles/) |
| `felixpalmer/lod-terrain` | Working CDLOD-style chunked terrain in WebGL, directly portable pattern | [github.com/felixpalmer/lod-terrain](https://github.com/felixpalmer/lod-terrain) |
| `AdamStone/lowpoly-heightmap-terrain` | Small, readable three.js chunk-streaming heightmap terrain with fBM | [github.com/AdamStone/lowpoly-heightmap-terrain](https://github.com/AdamStone/lowpoly-heightmap-terrain) |
| `danielesteban/softxels` | Chunked marching-cubes voxel renderer for three.js, for overhang/cave escalation | [github.com/danielesteban/softxels](https://github.com/danielesteban/softxels) |
| three.js official `GPUComputationRenderer` + `webgl_gpgpu_birds` example | Canonical GPU-compute-via-render-target pattern used for erosion | [docs](https://threejs.org/docs/pages/GPUComputationRenderer.html) |
| three.js official `MarchingCubes` example | Overhang/organic-isosurface escalation path | [threejs.org/examples/webgl_marchingcubes](https://threejs.org/examples/webgl_marchingcubes.html) |
| `repcomm/THREE.Terrain` | Slope/height blended-material shader reference, scatter-mesh helper | [repcomm.github.io/THREE.Terrain](https://repcomm.github.io/THREE.Terrain/) |
| three.js forum — *Procedural Instanced Forest* | Live discussion of shader-based LOD collapse for instanced trees | [discourse.threejs.org/t/88610](https://discourse.threejs.org/t/procedural-instanced-forest-high-performance-real-trees/88610) |
| three.js forum — *Terrain Generation + LOD* showcase | End-to-end chunked LOD three.js terrain project with debug tooling | [discourse.threejs.org/t/46411](https://discourse.threejs.org/t/terrain-generation-lod/46411) |
| three.js forum — *Procedural game level generation* showcase | Layered 2D data textures driving both geometry and texture masks, chunk+frustum culling | [discourse.threejs.org/t/34409](https://discourse.threejs.org/t/procedural-game-level-generation/34409) |

---

## 12. Summary parameter sheet (quick reference)

| Parameter | Suggested value | Section |
|---|---|---|
| Archipelago axis | 305° ± 15°, seeded | §2.1 |
| Island count per region | 6–14, log-normal size, σ≈0.6 | §2.4 |
| Domain warp iterations | 2 | §2.2 |
| Voronoi cells per island footprint | 40–80, Poisson-disc | §2.3 |
| Cliff slope transition band | 20°–33° (smoothstep) | §3.1 |
| Strata band frequency | seeded, per-island | §3.2 |
| Talus angle (soil) / (cliff guard) | 30–38° / 60–65° | §5.2 |
| Terrace step height | 2–4 m | §5.3 |
| Terrace slope gate | 5°–25° pre-terrace | §5.3 |
| Impermeable-cap coverage | 5–10% of island area | §6.2 |
| Village minimum spacing | ≥ 1.5 km | §9 |
| Seaplane lagoon min. clear chord | ≥ 400 m | §4.3 |
| Chunk size | 512×512 m | §1.3 |
| Heightmap working res (erosion) | 512² → upsample to 2048² | §5.2, §10.1 |
| Terrain triangle budget | ≤ 1.2 M (shared w/ ocean+sky) | §10.1 |
| Terrain draw calls | ≤ 40 | §10.1 |
