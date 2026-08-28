# Adriatic Island Procedural Generator — Topography Specification

**Scope:** landform generation only. Terrain heightfield, coastline, bathymetry, and the classification masks that downstream systems (biomes, vegetation, settlements, farming, roads, water) will consume. No gameplay, no materials, no scattering logic — but every mask those systems need is defined here as an output.

**Target engine:** Three.js, CPU-side generation into typed arrays, `BufferGeometry` per chunk.

**Reference:** the Ghibli aerial plate — a long, narrow, NW–SE trending landmass with a continuous green spine ridge, a single sweeping crescent beach on one flank, rocky low cliffs and a stepped shelf on the other, a broad tapering headland that decays into low rocky islets, and a hazy archipelago of parallel ridges receding to the horizon.

---

## 1. Geological premise (why the rules are the rules)

The Adriatic's eastern shore is the type example of a **Dalmatian coastline**: a drowned limestone fold belt. Parallel anticline ridges strike NW–SE, roughly parallel to the mainland coast, and sea level rise flooded the synclines between them. What is left above water is a fleet of long, thin, ridge-shaped islands separated by straight channels.

Four consequences drive the entire generator, and every module must respect them:

1. **Anisotropy.** Islands are elongated along a shared strike axis. Nothing in the pipeline should be radially symmetric.
2. **One dominant ridge per island.** The spine is the island's skeleton. Elevation, drainage, cliffs, and plateaus are all defined *relative to the spine*, not as independent noise fields.
3. **Karst, not erosion-by-water.** Limestone dissolves rather than gullies. Valleys are short and steep (`draga`), closed depressions are common (`vrtača`, `polje`), and there is almost no surface river network. Do not build a fluvial erosion sim; build a dissolution + gravity-scree model.
4. **Wind asymmetry.** The NE-facing flank is scoured by the *bura* — bare rock, steeper, cliffed. The SW-facing flank is sheltered and *jugo*-facing — deeper soil, terraces, coves, and beaches. This asymmetry is the single strongest visual signature and it is what makes the reference image read as Adriatic rather than generic tropical.

### 1.1 Vocabulary (used as literal identifiers in code)

| Term | Meaning | Used as |
|---|---|---|
| `otok` | island | top-level entity |
| `otočić` | islet | small satellite island |
| `hrid` | skerry / bare rock, often awash | sub-islet rock |
| `greben` | ridge (also: reef) | the spine |
| `prevlaka` | isthmus / low neck | saddle between ridge segments |
| `rt` | cape / headland | spine terminus |
| `zaliv` | bay | large coastal embayment |
| `uvala` | cove | small sheltered inlet |
| `luka` | harbour | cove flagged as anchorage-viable |
| `kanal` | channel | deep straight water between islands |
| `plaža` | beach | sediment deposit strip |
| `stijena` | cliff | near-vertical rock face |
| `polje` | karst field | large flat closed basin — prime farmland |
| `vrtača` | doline / sinkhole | closed conical depression |
| `škrape` | karren | fluted micro-grooves on bare limestone |
| `suhozid` | drystone wall | terrace riser (mask only, built downstream) |
| `draga` | short steep ravine | dry valley cutting a flank |
| `punta` | minor point | small convexity on the coastline |
| `plićak` | shallows | sub-2 m bathymetry shelf |

---

## 2. Coordinate frame, units, resolution

- **Units:** 1 world unit = 1 metre. Y is up. This matters — the cliff and beach thresholds below are all in real metres and will silently break if the scale drifts.
- **Archipelago frame:** define a global `strikeAngle` in radians (default `-0.62 rad`, i.e. ~NW–SE). Define the strike basis:
  - `ŝ = (cos θ, 0, sin θ)` — along-strike (island long axis)
  - `n̂ = (-sin θ, 0, cos θ)` — cross-strike (points to the NE / bura-exposed side)
- **Exposure convention:** a surface's exposure is `E = dot(surfaceNormalXZ, n̂)` in `[-1, 1]`. `E > 0` = **windward** (bura, bare, cliffed). `E < 0` = **leeward** (sheltered, soil, beaches). Every module reads this one scalar.
- **Heightfield resolution:** 2 m per sample for playable islands. Chunk at 256×256 samples = 512 m tiles. Islands are typically 3–12 km long, 400 m–2 km wide, so a mid-size island is ~12–20 chunks.
- **Sea level:** `y = 0` exactly. Do not offset it; too many thresholds depend on it.
- **Height range:** `-120 m` (channel floor) to `+520 m` (highest peak). Most islands cap at 150–350 m.
- **Determinism:** every module takes `(seed, islandId, moduleSalt)` and hashes them. Generation must be reproducible and, critically, **chunk-independent** — a chunk must be computable without its neighbours except where §11 explicitly allows a two-pass step.

---

## 3. Pipeline overview

Strictly ordered. Each stage may read all prior stages, never a later one.

```
A. Archipelago layout     → island seeds, strike axes, channel network
B. Spine construction     → 3D polyline skeleton per island (the greben)
C. Footprint field        → island SDF from swept spine + anisotropic warp
D. Base relief            → elevation from spine profile + cross-strike falloff
E. Plateau benching       → polje / terrace flats carved into the relief
F. Cliff formation        → windward scarps, coastal cliffs, plateau risers
G. Karst hydrology        → draga ravines, vrtače, closed-basin resolution
H. Coastal process        → littoral drift, beach deposition, cove carving
I. Bathymetry             → asymmetric shelf, plićak, kanal floor
J. Micro-detail           → škrape, scree, rock outcrop displacement
K. Mask consolidation     → the classification pass, conflict resolution
L. Meshing                → chunk geometry, LOD, normals, output
```

---

## 4. Stage A — Archipelago layout

**Goal:** place islands so the group reads as a drowned fold belt, with the receding parallel ridges visible in the reference plate.

1. **Fold lanes.** Generate `N` parallel lanes along `ŝ`, spaced `cross = 900–2600 m` apart with jitter. Each lane is an anticline crest line. Lane spacing follows a mild geometric progression so channels vary in width.
2. **Lane occupancy.** March along each lane and carve it into segments of length `2–9 km`, separated by `submerged gaps` of `300–1800 m`. An above-water segment becomes an `otok`. A gap becomes a `kanal` crossing. This is what produces chains of collinear islands rather than blobs — exactly the look of the reference's horizon.
3. **Lane amplitude.** Assign each lane a `crestAmplitude` in `60–420 m`. Lanes near the "mainland" edge of the map get higher amplitudes; outer lanes get lower ones and more submerged segments, so the archipelago fades to bare `hrid` rocks at the seaward margin.
4. **Curvature.** Perturb each lane with a low-frequency 1D noise of amplitude `±180 m` laterally over a `4 km` wavelength. Lanes must stay non-intersecting; if two lanes come within `250 m`, push them apart iteratively (3 relaxation passes is enough).
5. **Player island override.** Support an authored island: an explicit spine polyline + parameter block that bypasses A entirely and is stamped into the layout, with lanes relaxed around it.

**Output:** `IslandDescriptor[]` — `{ id, seed, spineControlPoints[], crestAmplitude, lengthM, meanWidthM, laneIndex, archetype }`.

---

## 5. Stage B — Spine construction (the `greben`)

The spine is the most important data structure in the generator. It is a **3D polyline with per-node attributes**, resampled to uniform arc-length spacing of `12 m`.

### 5.1 Geometry

- Fit a Catmull–Rom spline through `4–9` control points drawn from the lane segment, then resample uniformly. Store per node `i`: position `P_i` (XZ), arc length `t_i` normalised to `[0,1]`, tangent `T_i`, and cross-normal `B_i = T_i × up`.
- **Sinuosity budget:** total spine curvature must stay low. Clamp per-node turn angle to `≤ 6°` over 12 m. Dalmatian ridges are near-straight; a wiggly spine instantly looks wrong. Allow one deliberate `elbow` per island — a `20–40°` bend, which is what creates the big `zaliv` on the inner side of the bend (see §9.4). The reference image is exactly this: one elbow, beach in the concavity.

### 5.2 Crest elevation profile

Per node, `crestH_i` is built as a sum, not as noise alone:

```
crestH(t) = A * envelope(t) * (1 + 0.22 * fbm1D(t * 4.0))   -   saddleCut(t)
```

- `A = crestAmplitude`.
- `envelope(t)`: an asymmetric "cigar" — `pow(sin(π t), k)` with `k = 0.55–0.85`, then skewed by remapping `t' = pow(t, skew)` with `skew ∈ [0.7, 1.4]`. This puts the summit off-centre, at `t ≈ 0.35` or `t ≈ 0.65`, never dead middle.
- `fbm1D`: 3 octaves. Gives secondary summits along the crest.
- `saddleCut(t)`: place `1–3` **saddles** (`prevlaka`) at local minima of the fbm. Each subtracts a Gaussian of depth `0.25–0.6 × localCrestH` and width `120–400 m`. A saddle that cuts below `+8 m` becomes a **low neck** — a walkable isthmus with sea on both sides, and a prime settlement/road corridor. If it cuts below `0 m`, the island splits into two islands sharing a lane; accept this and re-run C–L per fragment.

### 5.3 Per-node half-widths

Each node carries `widthW` (windward, `+n̂` side) and `widthL` (leeward) half-widths — the island is **asymmetric in plan**, not just in profile.

```
widthW(t) = meanWidth * (0.55 + 0.30 * fbm1D(t*3, salt=w)) * envelopeW(t)
widthL(t) = meanWidth * (0.85 + 0.45 * fbm1D(t*3, salt=l)) * envelopeW(t)
```

with `envelopeW(t) = pow(sin(π t), 0.35)` so both taper toward the ends. `widthL > widthW` on average by ~1.4× — the sheltered flank is broader and gentler because it retains its debris apron; the windward flank is truncated by cliff retreat. This single ratio does an enormous amount of work in making the island read correctly.

### 5.4 Terminus (`rt`) handling

The last `12–18%` of arc length at each end is a **headland ramp**: `crestH` decays with `pow(1 - u, 1.6)` and both half-widths flare `+15%` then collapse to `~25 m`. This reproduces the reference's broad, flat-ish, low headland that runs out to a point rather than dropping off a cliff. Tag these nodes `isTerminus = true`; §12 uses the tag to seed offshore `hrid` chains continuing along `ŝ`.

---

## 6. Stage C — Footprint field (island SDF)

**Goal:** a signed distance field `sdf(x,z)` where `< 0` is land, so coastline is an isoline and every later module can query "how far from shore am I".

1. **Skeleton distance.** For a query point `p`, find the nearest spine node (uniform grid acceleration structure, cell = 64 m, storing node indices). Compute:
   - `d` = perpendicular distance from `p` to the spine polyline
   - `t` = arc parameter at the projection
   - `side = sign(dot(p - P, n̂))`
2. **Anisotropic radius.** `R(t, side) = side > 0 ? widthW(t) : widthL(t)`.
3. **Coast warp.** Add a domain-warped perturbation to the radius, evaluated in *spine-local* coordinates so it is stable under island rotation:

```
warp(t, side) = R(t,side) * ( 0.22 * fbm2D(t*7,  side*1.3, oct=4)
                            + 0.11 * fbm2D(t*19, side*1.3, oct=3)
                            + 0.05 * ridged2D(t*41, side, oct=2) )
```

The three bands correspond to: bays and headlands (~500 m features), coves and points (~180 m), and rock texture (~60 m). The `ridged2D` term is what produces sharp `punta` points instead of only smooth bulges.

4. **Signed distance:** `sdf = d - (R(t,side) + warp(t,side))`.
5. **Union with satellites.** Islets and skerries (§12) are separate capsule/ellipsoid SDFs, combined with a **smooth-min** of radius `18 m` so a near-shore islet can fuse into a `punta` rather than floating suspiciously 3 m offshore.

**Derived fields cached per sample:** `sdf`, `t`, `side`, `distToShore = -sdf` (land) or `+sdf` (sea), `shoreNormal = normalize(∇sdf)`.

---

## 7. Stage D — Base relief

Elevation is a **transverse profile swept along the spine**, then noised. This is the core reason the terrain will look like a ridge island and not like Perlin soup.

```
h(x,z) = crestH(t) * profile(q, side, t) + detail(x,z) * roughMask
```

where `q = clamp(d / R(t,side), 0, 1)` is normalised cross-strike position (0 = crest, 1 = shoreline).

### 7.1 Transverse profiles

Two different curves per side, blended near `q≈0` over a `40 m` band to avoid a crease at the crest:

- **Windward (`side > 0`) — concave, cliff-terminated:**
  `profileW(q) = 1 - pow(q, 2.2)` for `q < 0.72`, then a steep drop to the cliff top height, then §8 takes over below. Net effect: a broad convex-upward rocky slope that stays high until it falls off abruptly. Mean slope `28–40°`.
- **Leeward (`side < 0`) — convex, apron-terminated:**
  `profileL(q) = pow(1 - q, 1.45)` — a smooth concave-up debris apron that arrives at the coast at a shallow angle. Mean slope `9–18°`. This is the flank that can hold beaches, terraces, olives, and villages.

Modulate the exponent along `t` with a slow noise (`±0.25`) so the profile is not identical the length of the island.

### 7.2 Detail noise

- `detail = 0.10 * crestH * fbm3(pWarped)` with domain warp of `0.35 × wavelength`.
- **Anisotropic stretching:** before sampling noise, scale the sample position by `(1.0 along ŝ, 2.6 along n̂)`. Stretching the noise along strike makes secondary ridgelets and gullies run parallel to the spine, which is geologically correct and visually cohesive.
- `roughMask` reduces detail amplitude to `0.25×` where §10 will place beaches or §9 will place plateau floors, so those stay believably flat.

### 7.3 Crest ridgeline character

Add a **ridged multifractal** term confined to `q < 0.35`, amplitude `0.06 × crestH`, sharpened with `1 - |noise|`. This gives the crest a serrated limestone character with small notches and false summits, rather than a smooth arc. Clamp so it can never create a closed depression on the crest itself (those belong to §9.2 and need a different treatment).

---

## 8. Stage F — Cliffs (`stijena`)

Cliffs are **not** a noise threshold. They are generated as explicit geometric features, because they must be legible from a distance and must terminate cleanly at the waterline.

### 8.1 Three cliff classes

| Class | Where | Height | Rule |
|---|---|---|---|
| **Coastal cliff** | windward shore, `E > 0.25` | 8–70 m | Mandatory on windward shore unless a cove overrides |
| **Fault scarp** | inland, strike-aligned | 15–90 m | 0–3 per island, parallel to `ŝ` |
| **Plateau riser** | plateau perimeter | 3–25 m | Generated by §9.1 |

### 8.2 Coastal cliff construction

Walk the coastline isoline (`sdf = 0`) as an ordered polyline (marching squares on the SDF, then simplify to `6 m` segments). For each coastal vertex:

1. Compute outward normal and `E = dot(normal, n̂)`.
2. `cliffProbability = smoothstep(0.15, 0.65, E) * (1 - beachClaim) * (1 - coveClaim)`.
3. Where accepted, define `cliffTopH = lerp(8, 70, exposure * localRelief)` and a **retreat distance** `Wc = cliffTopH / tan(72°)` — i.e. cliffs are near-vertical but not literally vertical, because Three.js heightfields cannot represent overhangs.
4. Apply a **height remap** in the band `distToShore ∈ [0, Wc]`:
   `h = cliffTopH * smoothstep(0, 1, pow(distToShore / Wc, 0.35))`
   The `0.35` exponent front-loads the rise, giving that hard top edge and a slight basal flare.
5. Below the waterline, continue the face to `-Wc * 0.5` depth before joining bathymetry (§11) — cliffs plunge, they do not sit on a beach.

**Notching:** subtract sinusoidal notches along the cliff face at the tidal band (`y ∈ [-1.5, +1.0]`), amplitude `1.2 m`, wavelength `9–20 m`. Cheap, and it reads instantly as sea-carved limestone.

**Segmentation:** break each continuous cliff run every `40–140 m` with a `chute` — a narrow scree ramp descending at `34°`. Without chutes the windward coast becomes an impassable wall for the whole island length, which is a gameplay problem as much as a visual one. Tag chutes `traversable = true`.

### 8.3 Fault scarps

Place `0–3` lines parallel to `ŝ`, offset from the spine by `0.3–0.7 × widthW`, length `0.3–0.8 × islandLength`. Apply a one-sided height offset across the line (`throw` of `15–90 m`) smoothed over `Wc = throw / tan(65°)`, tapering to zero at both ends over `15%` of the scarp's length. These are what create **stacked bench topography** on the windward flank — a cliff, a sloping bench, another cliff — and they must be strike-parallel or the whole geology story collapses.

---

## 9. Stage E/G — Plateaus, karst, drainage

### 9.1 Plateaus and `polje` (farmland substrate)

Two distinct things, both flat, generated differently.

**(a) `polje` — large closed karst basin.** `0–2` per island, only on islands with `meanWidth > 500 m`. Placement: on the **leeward flank**, at `q ∈ [0.35, 0.75]`, preferentially adjacent to a saddle (a `prevlaka` is a structural low, so the basin naturally sits beside it).

- Shape: an ellipse elongated `2.5–4:1` **along `ŝ`**, `120–450 m` on the long axis, warped by low-frequency noise so the edge is lobed, not elliptical.
- Floor: set `h = floorH` where `floorH = h_at_centre - 0.35 * localRelief`, then add `±0.4 m` of noise only. Slope must be `< 1.5°` across the whole floor — this is the flattest terrain in the game and must be genuinely flat, not "gently rolling".
- Rim: transition from floor to surrounding terrain over `Wr = 18–45 m` using `smoothstep`, producing a rim slope of `20–35°`. Tag the rim `plateauRiser`.
- **Closed-basin flag:** a `polje` has no outlet. This is correct, not a bug. Mark it `endorheic = true` so §9.3 does not try to route drainage out of it, and so downstream systems can optionally place a seasonal pond (`blato`) at the low point.

**(b) Structural benches / terraces.** Broad, gently seaward-sloping shoulders, generated by **quantising** the leeward profile rather than carving basins.

- Choose `nBenches = 2–5`. Compute bench elevations as a geometric series between `+12 m` and `0.55 × crestH` (closer spacing lower down, matching real terracing).
- For each sample on the leeward flank, snap `h` toward the nearest bench elevation with strength `w = smoothstep(28°, 6°, localSlope)` — i.e. only already-gentle ground gets flattened, so the snapping never fights a steep slope and never creates staircases on cliffs.
- `h' = lerp(h, benchH, w * 0.8)`.
- The residual steep strips between benches become `suhozid` riser candidates. Emit them as a mask with the riser's contour, height (`1.5–4 m`), and along-contour direction so drystone walls can be built downstream — they follow contours, always.
- Benches are **leeward-only**. Windward benches come from fault scarps (§8.3) and are rocky, not agricultural.

### 9.2 `vrtače` — dolines

Scatter `10–60` per island via blue-noise (Poisson disk, min radius `35 m`), weighted toward plateau surfaces and gentle upper slopes, excluded from cliffs, beaches, and `polje` floors.

- Radius `8–45 m`, depth `= radius * 0.28` (real dolines are wide and shallow-ish; deep cones look like meteor craters and break the read).
- Profile: `Δh = -depth * pow(1 - pow(r/R, 2.0), 1.5)` — parabolic with a slightly flattened floor.
- **Merging:** if two dolines overlap, combine with smooth-min so they form a compound `uvala`-type basin. Chains of merged dolines aligned along `ŝ` (fracture-controlled) look excellent — bias `20%` of doline placement into short collinear strings of 2–4.
- Never place a doline within `25 m` of the coastline isoline; a doline breached by the sea is a distinctive feature but needs a bespoke treatment, so exclude it for v1.

### 9.3 `draga` — dry ravines

No fluvial simulation. Instead, carve a small number of authored-feeling ravines:

1. Seed `2–7` ravine heads on the crest, at local minima of `crestH`'s high-frequency component, spaced `≥ 180 m` apart along `t`.
2. Route each downhill toward the coast using a **steepest-descent walk on the current heightfield** with momentum (blend new direction `0.6` toward previous) and a lateral noise nudge. Terminate at `sdf = 0` or at a closed basin.
3. Carve with a **V-section that widens and shallows downstream:**
   - `depth(u) = maxDepth * (1 - u)^0.7`, `maxDepth = 6–28 m`
   - `halfWidth(u) = lerp(10, 45, u)`
   - cross-profile: `Δh = -depth * (1 - pow(|r|/halfWidth, 1.4))`
4. Ravines are `2.5×` more numerous and shorter on the windward flank (steep, short catchments); leeward ravines are longer, gentler, and are the **natural road and path corridors** — tag them.
5. **Where a `draga` meets the coast**, force a small `uvala` (§10.3) and, if the leeward beach system is active, feed sediment into it (§10.2). This is the single most important cross-module link: it is why beaches sit at valley mouths.

### 9.4 The elbow bay (`zaliv`)

If the spine has an elbow (§5.1), the concave side gets a large embayment: multiply `widthL` by `0.55–0.75` across the elbow's arc span, smoothly ramped over `±250 m`. The result is a broad crescent-shaped shoreline recess on the sheltered flank — the exact geometry that makes the reference image's long beach possible.

---

## 10. Stage H — Coastal process: beaches and coves

Beaches are **derived**, never scattered. A beach exists only where sediment can be produced, transported, and trapped. Getting this causal chain right is what makes the coastline read as real.

### 10.1 Sediment budget

Compute a per-coastal-vertex **supply** term:

```
supply = 0.55 * ravineOutletProximity     // draga delivers debris
        + 0.30 * upcoastCliffErosion      // cliffs feed the drift cell
        + 0.15 * apronGentleness          // wide gentle flank = more loose material
```

`ravineOutletProximity` = `exp(-dist / 120 m)` summed over ravine mouths. `upcoastCliffErosion` = cliff length within `600 m` in the up-drift direction.

### 10.2 Littoral drift and trapping

1. Define a dominant wave approach direction (from `jugo`, i.e. roughly `+ŝ` rotated `30°`), so drift runs along the leeward coast in one consistent direction.
2. March the coastline polyline in the drift direction, carrying an accumulator `S`. At each vertex: `S += supply`, then `S -= 0.02 * S` (losses), and `S -= leakage` where the coast is convex (headlands bleed sediment offshore).
3. **Trapping:** `S` is deposited where the coastline is **concave** (curvature `κ < 0`) and exposure is leeward. Deposition rate `∝ -κ * S`.
4. **Beach width:** `beachWidth = clamp(deposit * k, 6, 85) m`. Long beaches emerge naturally in the elbow bay because it is a long concave run downdrift of a cliffed headland — which is precisely the mechanism in the reference image.
5. **Beach geometry:** replace the terrain in the band `distToShore ∈ [-beachWidth*0.4, +beachWidth]`:
   - Backshore: flat, `+1.2 to +2.5 m`, `1.5°` seaward slope
   - Foreshore: `4–7°` planar slope from backshore down through `y=0`
   - Nearshore: `2.5°` out to the `-2 m` contour, then join §11's shelf
   - Add along-shore `berm` undulation: `±0.35 m`, wavelength `25–60 m`
   - Add `1–3` **beach cusps** on longer beaches: shallow scallops, `18–40 m` spacing, `0.5 m` amplitude
6. **Tombolo / `prevlaka` special case:** if a beach forms on both flanks at the same low saddle, merge them into a double-sided sand neck. Excellent landmark; explicitly allow it.

### 10.3 Coves (`uvala`) and harbours (`luka`)

- A **cove** is carved where a `draga` reaches the coast: push the coastline inland by `0.6 × ravineHalfWidth` and deepen the adjacent bathymetry to `-3 to -9 m`. Coves may occur on **either** flank — this is the one exception that lets the windward cliff wall be broken up.
- Flag a cove as `luka` when: mouth width `> 45 m`, interior depth `> 4 m`, shelter score `> 0.6` (fraction of the compass blocked by land within `500 m`), and gradient behind the head `< 12°`. Settlements go here. The reference's harbour town sits exactly at such a spot: cove + beach + gentle backslope.

### 10.4 Coastal type classification

Every coastal vertex ends up as exactly one of: `plaža` (sand), `šljunak` (pebble — beaches with `supply < 0.35` or on higher-energy stretches), `stijena` (cliff), `rock platform` (low windward shore where relief is too low for a cliff), `uvala mouth`, or `prevlaka`. Emit as a per-vertex enum plus a rasterised mask.

---

## 11. Stage I — Bathymetry

Underwater terrain is not an afterthought; the reference image's whole depth story is the pale turquoise shelf on the beach side against near-black water on the other.

- **Leeward shelf:** wide and shallow. From shore, slope `1.5–3°` out to `-15 m` over `250–700 m`, then `6°` to the channel floor. Widen the shelf `1.6×` in front of beaches and inside bays.
- **Windward:** narrow and steep. Cliff faces continue below water at `55–70°` to `-25 m`, then `12°`. Shelf width `30–120 m`. Add strike-parallel submerged ridge ribs (`greben` as reef), rising to `-2 to -6 m` — navigation hazards and visual interest.
- **`Kanal` floor:** flat-ish at `-45 to -120 m`, deeper for wider channels, with a slight V toward the axis. Add strike-parallel corrugations of `±6 m`.
- **`Plićak`:** any area `> -2 m` gets flagged for the pale-water shader band. Ensure at least one broad `plićak` apron off the main beach — it does more for the Ghibli read than any land feature.
- **Continuity:** bathymetry must be `C¹` continuous with the land surface at `sdf = 0`. Blend over the band `|sdf| < 8 m` after both are computed, and re-derive normals across the seam.

---

## 12. Islets, skerries, sea stacks

- **`otočić`:** placed along `ŝ` beyond each `rt` terminus, continuing the lane. `1–5` per terminus, sizes decaying `0.6×` each step, spacing `80–400 m`. Each is a miniature of the full pipeline: tiny spine, asymmetric profile, windward cliff, leeward pebble pocket. Heights `4–40 m`.
- **`hrid`:** bare rocks, `1.5–6 m` above sea level, `3–15 m` across, clustered `4–12` at a time near termini and along submerged ridge ribs. Steep, notched at the waterline, no soil mask.
- **Sea stacks:** where a cliff run has a strong convexity, detach the tip: probability `0.3`, leaving a `6–20 m` diameter stack `15–50 m` offshore at `60–90%` of the adjacent cliff height, plus a submerged stub where it separated.

---

## 13. Stage K — Intersection rules and conflict resolution

This is the section that determines whether the generator produces coherent islands or mush. Features **will** overlap; resolve them by an explicit priority stack, and where possible by *negotiation* rather than clipping.

### 13.1 Authority order (higher wins)

```
1. Sea level & SDF coastline        (topology — never violated)
2. Spine crest elevation profile    (skeleton — never overwritten, only notched)
3. Coastal cliffs                   (hard geometry, must reach waterline cleanly)
4. Beaches                          (must be flat and must meet water at correct slope)
5. Polje floors                     (must be genuinely flat)
6. Fault scarps
7. Draga ravines
8. Structural benches
9. Dolines
10. Micro-detail / škrape           (never changes classification)
```

### 13.2 Pairwise interaction matrix

| A ∩ B | Resolution |
|---|---|
| **Cliff ∩ Beach** | Mutually exclusive. Cliff wins on `E > 0.25`; beach wins on `E < -0.1`. In the `[-0.1, 0.25]` band, whichever has the higher claim value wins, and the loser fades over `25 m`. Insert a **transition**: cliff base → boulder ramp → pebble → sand, over `30–60 m`. Never a hard butt joint. |
| **Cliff ∩ Draga** | Ravine wins locally: it cuts a **chute** through the cliff, `12–30 m` wide, floor at `32–38°`. Tag `traversable`. This is how the windward flank gets its few landing points. |
| **Cliff ∩ Polje** | Forbidden. Reject any `polje` whose rim comes within `60 m` of a cliff top; re-roll placement (max 6 attempts, then drop the polje). |
| **Cliff top ∩ Bench** | Bench is truncated at the cliff top with a `4 m` rounded lip. Do not let bench-snapping pull the cliff top downhill — freeze `h` in the cliff band before §9.1(b) runs. |
| **Beach ∩ Draga** | Reinforcing. Ravine mouth boosts `supply` (§10.1) and forms a small **alluvial fan**: a `0.8 m` convex lens, `40–90 m` wide, spreading into the backshore. The beach widens locally by `1.3×`. |
| **Beach ∩ Cove** | Compatible and desirable: pocket beach at the cove head. Clamp beach width to `0.7 × coveWidth`. If the cove is a `luka`, keep the beach but flatten the backshore further (`0.8°`) — that is the village terrace. |
| **Beach ∩ Prevlaka** | Two beaches at one saddle → tombolo (§10.2.6). Merge, shared crest at `+2.2 m`. |
| **Polje ∩ Draga** | Ravine terminates at the polje rim and forms an **inflow fan** on the floor; it must not breach the rim. If the descent walk tries to exit the polje, stop it (`endorheic`). Add a `ponor` (swallow hole) marker at the floor low point — a doline-like `6–12 m` depression. |
| **Polje ∩ Doline** | Allowed but rare. Suppress doline density to `15%` inside polje floors; keep only the `ponor`. Too many dolines destroys the flatness that makes the polje farmable. |
| **Polje ∩ Bench** | Bench-snapping is **disabled** inside a polje's footprint plus a `30 m` margin. Outside that, benches may abut the rim, which reads as terraces stepping down into the field — good. |
| **Polje ∩ Spine** | Forbidden. Polje centre must be at `q > 0.3`. It's a flank feature; a basin on the crest is geologically wrong and visually confusing. |
| **Fault scarp ∩ Spine** | Scarp must not cross `q < 0.15`. If it would, offset it outward. |
| **Fault scarp ∩ Draga** | Ravine crossing a scarp forms a **knickpoint**: a short steep step (`60%` of throw) in the ravine floor, over `15 m`. Small waterfall/dry-fall site. |
| **Fault scarp ∩ Bench** | Scarp defines the bench edge — snap the nearest bench elevation to the scarp's upper lip so they coincide instead of near-missing by 3 m. |
| **Doline ∩ Draga** | If a doline is within `1.2 × ravineHalfWidth` of a ravine axis, delete the doline (a ravine would have drained it). |
| **Doline ∩ Cliff** | Delete dolines within `30 m` of a cliff band. |
| **Doline ∩ Doline** | Smooth-min merge, radius `= 0.35 × min(R₁,R₂)`. |
| **Draga ∩ Draga** | If two heads converge within `40 m`, merge into a single trunk with `depth = max(d₁,d₂) * 1.25` and `halfWidth = hypot(w₁,w₂)`. Classic dendritic junction. |
| **Bench ∩ Bench** | By construction non-overlapping (quantisation). Verify no riser exceeds `6 m`; if it does, insert an intermediate bench. |
| **Islet ∩ Island** | Smooth-min union if gap `< 40 m` (becomes a `punta`); otherwise keep separate and ensure `≥ -3 m` water between them so boats can pass — or `≥ +1 m` land so players can walk. Never leave a `0 to -1 m` ambiguous mudflat. |
| **Sea stack ∩ Shelf** | Stack base must sit on a `-4 to -12 m` platform, not on the abyssal channel floor. |
| **Any feature ∩ Coastline** | The coastline isoline is recomputed **after** all height edits. Features that accidentally submerge terrain are allowed to change the coastline — but re-run the coastal classification pass (§10.4) afterward. One iteration is sufficient; do not loop. |

### 13.3 Two-pass requirement (chunk boundaries)

Three modules are inherently non-local and need a **feature pass** before the **raster pass**:

- Coastline walk (littoral drift, cliff runs) — needs the whole island's coastline.
- Ravine routing — walks arbitrarily far.
- Bench elevation series — global to the island.

Therefore: generate **per-island feature descriptors first** (cheap, coarse `8 m` proxy heightfield is enough for routing), serialise them into a compact `IslandFeatureSet`, and only then rasterise chunks independently by querying that set. Chunks stay parallelisable and seam-free. Do **not** attempt to derive these features per-chunk.

---

## 14. Output data contract

Per chunk, produce:

| Buffer | Type | Purpose |
|---|---|---|
| `height` | `Float32Array` (N+1)² | Vertex Y |
| `normal` | `Float32Array` ×3 | Computed by central differences on the **stitched** field (sample one row/col beyond the chunk to avoid seam normals) |
| `slope` | `Float32Array` | Degrees, cached — many downstream systems need it |
| `exposure` | `Float32Array` | `dot(normalXZ, n̂)`, `[-1,1]` |
| `landformId` | `Uint8Array` | Enum: `crest, windwardSlope, leewardSlope, cliffFace, cliffTop, chute, benchFlat, benchRiser, poljeFloor, poljeRim, ravineFloor, ravineWall, dolineFloor, backshore, foreshore, rockPlatform, shelf, channelFloor, islet, hrid` |
| `distToShore` | `Float32Array` | Signed, metres |
| `soilDepth` | `Float32Array` | Derived: `f(slope, exposure, landform)` — 0 on cliffs, max on polje floors and bench flats. Vegetation and farming read this. |
| `q, t` | `Float32Array` ×2 | Spine-local coords — lets any later system reason in island space |

Island-level: `IslandFeatureSet` with spine polyline, coastline polyline + per-vertex classification, polje polygons, bench contours, riser contours (for `suhozid`), ravine paths, cove/`luka` markers, cliff runs + chutes, islet list.

**Guarantee to downstream systems:** farming placement should need nothing more than `landformId ∈ {poljeFloor, benchFlat}` AND `slope < 6°` AND `soilDepth > 0.6`. If that query does not return good, contiguous, sensibly-sized fields, the topography generator has failed, regardless of how it looks.

---

## 15. Meshing and LOD notes

- Uniform grid per chunk, `2 m` at LOD0. LOD1–3 at `4/8/16 m` with skirts (`8 m` drop) to hide cracks; do not attempt geomorphing in v1.
- **Cliff faces are the LOD hazard.** A `70 m` cliff across a `16 m` LOD3 sample becomes a smeared ramp. Mitigation: keep chunks containing `cliffFace` at a minimum of LOD1, and additionally emit **cliff face strips** as separate small meshes generated from the cliff run polyline (extruded vertical quads with the notch profile), so silhouettes survive at distance. This also lets cliffs slightly overhang, which the heightfield alone cannot.
- Sea surface is a separate flat plane at `y=0`; depth-based colour uses the bathymetry, so accurate shallow shelves are what produce the turquoise band.
- Compute normals from the height field analytically where possible (the profile functions are differentiable) and fall back to central differences for noised regions.
- Budget: a `6 km × 900 m` island at 2 m ≈ 1.35 M vertices across ~18 chunks. Generate off the main thread in a Web Worker pool, one island per worker, streaming chunks as they finish.

---

## 16. Parameters — archetypes

Expose these as presets; each is a full parameter block.

| Archetype | Length | Mean width | Crest | Character |
|---|---|---|---|---|
| **Dugi otok** (long ridge) | 8–12 km | 700 m | 250 m | The reference image. One elbow, long leeward beach, continuous windward cliff, 1 polje, 4 benches. |
| **Visoki otok** (high island) | 4–6 km | 1.6 km | 480 m | Steep, dramatic, cliffs both flanks, deep ravines, no polje, few beaches, many stacks. |
| **Ravni otok** (low island) | 3–5 km | 1.1 km | 90 m | Mostly bench and polje, rock platforms instead of cliffs, wide shelves, several coves. Farming island. |
| **Prevlaka pair** | 2×3 km | 500 m | 160 m | Two ridges joined by a tombolo neck. Two harbours back-to-back. |
| **Hridi cluster** | — | — | 6 m | Bare skerry field. No soil, navigation hazard, seabird colony site. |

---

## 17. Validation — must pass before shipping a seed

Automated checks, run per island at generation time:

1. **Asymmetry:** mean windward slope `>` mean leeward slope by `≥ 10°`. Else the wind story failed.
2. **Spine continuity:** a path exists along the crest from `t=0.1` to `t=0.9` never exceeding `30°` and never dropping below `+4 m` (or crossing a tagged tombolo). The spine must be walkable — it is the island's main route.
3. **Beach coherence:** total beach length `≥ 250 m` on any island with `meanWidth > 500 m`, at least one beach ≥ `180 m` continuous, and every beach is `E < 0`. No beach on a windward cliff.
4. **Farmland yield:** total area matching the §14 farming query is `2–8%` of island land area. Below 2% the island is unplayable; above 8% it looks like a golf course.
5. **Cliff traversability:** no continuous impassable cliff run longer than `600 m` without a chute.
6. **No sinks in ravines:** every ravine reaches either the sea or a flagged `endorheic` basin. Zero unflagged internal sinks.
7. **Slope sanity:** `< 0.5%` of land samples exceed `85°` (heightfield artefacts). Zero NaNs. Zero samples where `|h| > 600`.
8. **Coastline sanity:** coastline polyline is closed, non-self-intersecting, and has no segment shorter than `0.5 m` (degenerate marching-squares output).
9. **Seam test:** sample the height field along all chunk boundaries; max discontinuity `< 0.01 m`.
10. **Silhouette test:** render each island from 4 sea-level azimuths at 1 km; a human check that the ridge reads as one coherent landform with a legible summit, not as a lumpy field.

---

## 18. Suggested build order

1. Strike frame + spine + SDF + base relief (§5–7). **Stop and look at it** — if the basic ridge island doesn't read correctly in grey box, nothing later will save it.
2. Bathymetry + sea (§11). Depth colour alone makes it look 60% finished.
3. Cliffs (§8). Biggest single visual gain.
4. Beaches + littoral drift (§10). The Ghibli moment.
5. Benches + polje (§9.1). Makes it inhabitable.
6. Ravines + chutes (§9.3). Makes it traversable.
7. Dolines + micro-detail (§9.2, J).
8. Islets, stacks, archipelago layout (§4, §12).
9. Validation harness (§17), then seed-hunt for hero islands.

Do not reorder. Each stage's parameters are tuned against the previous stage's silhouette, and tuning noise detail before the ridge profile is correct wastes the most time.

---

## 19. Anti-patterns

- **Radially symmetric islands.** If `widthW == widthL` and the noise is isotropic, you have generated a generic tropical island. The anisotropy is the whole point.
- **Fractal Brownian everything.** Elevation must come from the spine profile with noise as a *modifier* (≤ 15% of amplitude), not from noise with a falloff mask.
- **Beaches by threshold.** `if (slope < 5 && height < 3) sand` produces sand in absurd places — inside coves on the windward wall, on top of rock platforms, in thin useless slivers. Use the sediment budget.
- **Cliffs by slope colouring.** A steep slope shaded grey is not a cliff. Cliffs need explicit geometry, a hard top edge, waterline notching, and a plunging base.
- **Hydrological realism.** Do not run a fluvial erosion sim on limestone. It will produce dendritic river networks that no Adriatic island has, and it will destroy the flat polje floors you need for farming.
- **Isotropic noise on bathymetry.** Underwater features are strike-parallel too.
- **Dolines everywhere.** Tempting because they are cheap. At high density the island looks bombed.
