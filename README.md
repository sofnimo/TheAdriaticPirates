# The Adriatic Pirates — world renderer

Three.js flight-game world, 1920s–30s Adriatic, art-directed after Studio Ghibli's *Porco Rosso*.

The research docs at the repo root are the specification. **`00 — Art Direction Bible.md` is the
binding contract** — every other doc defers to it on palette and shading rules, and so does the code.

## Running

```bash
npm install
npm run dev        # vite dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
```

## Where things are

| Path | What it holds |
|---|---|
| `src/art/` | The contract as data. Palette hexes (00 §2), budget ceilings (00 §5). **Never imports three.js.** |
| `src/app/RendererConfig.ts` | The only place the renderer is configured. NoToneMapping + sRGB + PCFShadowMap. |
| `src/app/Engine.ts` | Renderer ownership, frame loop, resize. Knows nothing about the world. |
| `src/render/shading/` | The shared gouache chunk + the only sanctioned `onBeforeCompile`. |
| `src/render/lighting/` | The one-sun rig. |
| `src/world/` | World content: sky dome, ocean, depth field. |
| `src/dev/` | Debug/verification scenes. Not shipped world content. |

## Build order

Following the doc index's suggested sequence. Each step has a gate that must pass before the next begins.

- [x] **Step 0 — scaffold.** Renderer contract locked, palette transcribed, palette gate passing.
- [x] **Step 1 — sky gradient + sun + gouache ramp chunk** (`04`, `01` §1). Ramp gate passing.
- [x] **Step 2 — flat ocean, continuous depth ramp, placeholder bathymetry** (`02`). Ocean gate passing.
- [x] **Step 3 — one hand-authored island** (`03`). Island gate passing; ocean gate still passing against the island's own shore.
- [ ] **Step 4 — shore SDF and foam** (`02b`)
- [ ] **Step 5 — clouds and cloud shadows** (`01`)
- [ ] **Step 6 — post chain, grain, grading lock** (`04` §7)

## The palette gate (Step 0)

`npm run dev` renders every authored hex twice in the same cell: the **left half** through the real
WebGLRenderer, the **right half** as a plain CSS background of the identical hex. If the renderer is
mis-configured, the halves differ and every swatch shows a seam.

The eyeball test is backed by a `readPixels` check comparing each GL half against the authored sRGB
bytes. Current state: **43/43 exact, worst delta 0.**

This matters because the whole art direction is sampled hex values. A tone-mapping curve left on by
accident silently rewrites all of them — `04 — Light and Shadow.md` §7.2 documents exactly that failure.

To see the gate detect drift, load **`/?tonemap=aces`** (or flip *tone mapping* in the debug panel).
ACESFilmic takes the palette to **0/43 exact, worst delta 31** — the cyan zenith and the forest greens
move furthest, which is precisely why the bible bans it.

## The ramp gate (Step 1)

`npm run dev` opens the ramp scene: six spheres, one per surface preset in 04 §2.3, over a
shadow-receiving ground plane, with a receding pillar row for aerial perspective.
`?scene=palette` switches back to the Step 0 gate; `?still=1` renders a single frame and
stops the loop (deterministic headless capture); `?report=0` hides the measurement panel;
`?view=haze` starts on the aerial-perspective camera.

The probe reads the frame back and measures, rather than trusting the picture:

| Check | Result |
|---|---|
| Band count == `rampSteps`, all six surfaces | 6/6 |
| Every plateau matches the chunk's own predicted band colour | worst delta **0** |
| Ramp band-to-band transition width | **0 px** |
| Cast-shadow edge width | **0 px** |
| Ground-at-horizon vs sky convergence | delta **1-2** |

Haze is disabled during the sphere measurements and measured separately at the horizon: at
52 m it lifts every band by ~0.01 linear, which is correct but would force the band-value
comparison to allow slop, and a gate that allows slop stops catching things.

Under `?tonemap=aces` the same gate goes to **0/6**, band deltas 16-30, horizon delta 8 —
note that band *counts* stay correct. ACES does not break the stepping, it silently
rewrites every band colour, which is exactly the failure 04 §7.2 warns about.

## The island gate (Step 3)

One hand-authored island, **Punta Severa** — a fixed spine and parameter table in
[`src/art/../world/island/IslandSpec.ts`](src/world/island/IslandSpec.ts), shaped the way
`03` §2 says to shape one: skeleton first, domain-warped, never a radial blob.

**The island owns the shoreline.** `IslandField` bakes a height grid, a land mask and an
exposure field once; the terrain mesh is built from it and the bathymetry is built from the
same mask. `02b` §1.2 requires the shore signal to have one owner, and here it has one array.
The gate proves it rather than assuming it.

| Check | Result |
|---|---|
| Footprint anisotropy (03 §0.1: long and thin, not radial) | **3.35 : 1** — 2253 m along the spine × 672 m across |
| Flank asymmetry, coastal band (03 §3.5) | **2.42 : 1** — seaward slope 1.02 vs sheltered 0.42 |
| Terrain mask vs bathymetry mask | **0** texels disagree |
| Discrete tones across the cliff terminator (00 §3 rule 1) | **22** (min 3) |
| Land samples within 26 of an authored 00 §2 hex | **4310 / 4310** |
| Budget (03 §10.1: 1.2 M tris / 40 draws) | **69,966 island tris, 7 draw calls** |

Three of these are measured on the **baked field, not on pixels**. Anisotropy, flank asymmetry
and shore agreement are properties of the island itself; measuring them off a screenshot would
only add a camera's worth of noise to numbers that are already exact, and a flattering angle
can hide a blob.

### Four bugs the gate caught that a screenshot would not have

- **The flank asymmetry was inverted.** The exposure field was reconstructing which flank a
  point sat on from the domain-warp displacement, so it was measuring how far the warp had
  moved the sample rather than which side of the spine it was on. It read 0.86:1 — not weak,
  backwards. No amount of adjusting the height profile would have fixed it, and at a
  three-quarter angle it looked fine.
- **Two flank metrics that could not work.** Mean slope over the whole flank cannot separate a
  cliff from a ramp — both flanks drop the same height over the same width, so the means match
  whatever the cross-section. The 90th-percentile slope is worse: it reports the *sheltered*
  flank as steeper, because §5.3's cultivation terraces are cut into it and every riser is a
  near-vertical step. Measuring the coastal band (2–50 m elevation) is below the terraces and
  is the ground the rule is actually about.
- **The depth-field blur was moving the shoreline.** Smoothing across the waterline dragged
  depth onto the land side, so the water's coast sat a texel or two off the terrain's. The
  blur now leaves land at exactly zero.
- **Land inferred from depth is not land.** The shore check originally read "depth ≤ 0.0005"
  as land; the contour wander can drive a shallow *water* texel to zero distance-from-shore
  too. It reported 163 disagreements for a coastline both systems read from one callback.
  `DepthField` now keeps the mask it was built from and the gate compares masks.

### Known limitations, deliberately not fixed in this step

- **The cross-section is a mesa, not a ridge.** Making the seaward flank cliffed means holding
  height most of the way out and dropping fast, which flattens the crest — the ridged
  multifractal underneath is barely visible from the air. A separate crest term above the
  flank profile would give both.
- **No vegetation instances.** `03` §8's silhouette-first species set is a system of its own,
  not part of "one hand-authored island"; cover is currently colour only.
- **Terrain does not self-shadow.** The island passes `shadowFactor = 1.0` into the shared
  ramp, so the stepped terminator comes from N·L alone and a headland casts nothing across the
  bay behind it. Cast shadows are wired for Step 5, where the cloud shadows land.
- **The island is generated on the main thread**, ~1 s at 1024². `03` §10.1 budgets 150 ms in
  a worker; that matters when islands stream, and nothing streams yet.

## The ocean gate (Step 2)

`npm run dev` opens the ocean scene. Views: `cove` (the composition to hold against the
reference frame), `shelf` (near-vertical, what the probe measures on), `topdown` (the glint
field), `low`/`high` (200 m / 1500 m aliasing checks).

### The depth ramp is continuous, not banded

The sea's depth-to-colour mapping was originally built as five flat bands with hard 0 px
edges. That targeted the wrong effect. Sampling the reference frames directly shows no
banding anywhere the depth varies: on image-3.jpg's water column the colour moves on
essentially every row, mean 1.2/255, max 2.8/255, longest near-flat run 6 px in 133. The sky
gradient behaves the same way, and was already continuous — measured, not assumed.

Open sea *does* read as a flat field (plane-skimming holds `#025581` to within 1/255 over
180 px), but that is flat because the depth is flat there. A continuous ramp gives both
behaviours; a quantiser puts plateaus where the depth is still moving.

The stepping that remains is in the **light response**, where the gouache ramp puts it.
Colour continuous, lighting banded. Ramp stops, their source frames and pixel coordinates
live in [`src/art/seaRamp.ts`](src/art/seaRamp.ts).

| Check | Result | Same metric on the reference |
|---|---|---|
| Band edges (plateau ≥8 px then step ≥8) | **0** | 0 across 7 transects in 5 frames |
| Max single-pixel step | **3**/255 | 2.8 (image-3), 4.7 (karst), 8.8 (image-3 x=620) |
| Mean step | **0.4**/255 | 1.2 (image-3) |
| Longest flat run (reported, not gated) | 37 px = **9%** | 5% (image-3) to 17% (peninsula) |
| Colour travelled across the transition | `#8eb2a1` → `#05434f` = **137**/255 | 137/255 (image-3 x=500) |
| Iso-contour wander (detrended, p2p) | **54.7 px** | — |
| Glint coverage, near water | **11.2%** | 16.1% image-4, 5.6% harbour, 1.6% mid-altitude |
| Glint aspect (PCA), median / p90 | **6.6 : 1** / **10.9 : 1** | 6.9 / 10.3 image-4 light marks |
| Glint axial alignment R | **0.98** | 0.98 harbour, 0.93–1.00 open sea, 96.7% aligned in image-4 |
| Glint coverage 200 m → 1500 m | 3.2% → **0%** | — |
| Pixels changed over one 60 Hz step, 200 m | **0%** | — |
| Budget (02 §6.1: 300k tris / 5 draws) | **44,544 tris / 4 draws** | — |

Longest-plateau is measured but deliberately not gated: the source material itself runs 5–17%
depending on how much flat open water a transect crosses, so it cannot separate a painted
gradient from a quantiser. Plateau-**then-jump** can, and does.

Glints are disabled while the shelf is measured and haze is disabled for both — each is
measured separately, so neither has to be given slop in the other's comparison.

### Negative controls

Both are permanent. A gate nobody has watched fail is not evidence.

| Toggle | Effect |
|---|---|
| `?bands=5` | Puts the old quantiser back. Gate → **FAIL**, 1 band edge, max step 34, plateau 99% |
| `?bands=3` / `?bands=8` | **FAIL**, 1 and 4 band edges, max step 58 and 35 |
| `?tonemap=aces` | Palette gate → **FAIL**, 0/43 exact, worst delta 31 |

### Glints: two populations, density from sea state and range

Recalibrated against `image-4.jpg`'s figures. Three things moved:

- **Density is per sea state, not one global target**, and tapers with viewing distance.
  Coverage as a fraction of pixels is framing-dependent, so a fixed fraction blankets the
  frame from any camera; the frames run 16.1% on near lively water, 1.6% at mid altitude and
  essentially zero high up. Measured at image-4's framing, the render lands at 11.2%.
- **Marks go both lighter AND darker than the water**, roughly 4:1. The derive-from-water rule
  survives — hue is invariant within ±7°, saturation drops hard in both directions — but the
  lightness term is signed. Without the dark population the surface reads as flat colour with
  highlights printed on it.
- **Aspect 6.9:1, not 4.5:1.** The old figure came from the harbour frame.

**Re-measured locally once the frame arrived.** Every figure checks out:

| | image-4.jpg (measured here) | Render |
|---|---|---|
| Base water | `#02557c` h199 s0.97 l0.25 | — |
| Light-mark aspect, median / p90 | 7.2 : 1 / 12.9 : 1 | **6.6 : 1 / 10.9 : 1** |
| Light-mark axial R (elongated marks) | 1.00 at 180° | **0.98** |
| Light-mark lightness / saturation | 0.55 / 0.33 | **0.53 / 0.32** |
| Dark-mark coverage | 3.57% | 3.0% configured |
| Coverage, mid-to-near band | ~11% | **10–11%** |

**The range taper turned out to be inside the primary frame.** Splitting image-4 into three
horizontal bands: coverage **0.80% far → 5.23% mid → 17.26% near**, marks 25.7 → 73.8 → 85.9 px.
A twenty-fold change across one frame, at one sea state under one sun. Density falling with
viewing distance is not an inference from comparing different frames — it is in the evidence,
and it is why coverage cannot be one global number. The stated 16.1% is a near-field figure.

**The foreshortening factor now has evidence behind it.** The aspect is matched screen-to-screen
via a 0.57 correction, which previously *assumed* the render's skim pitch matched image-4's.
It does: image-4's marks run 85.9 px near and 25.7 px far, a 3.3× size ratio, and since apparent
size goes as 1/distance, sin(60°)/sin(15°) = 3.34 puts the frame between roughly 15° and 60°
below horizontal — mid-frame ~37°. The render's probe region spans 27–48°, mid-frame 37°. Same
angle, same foreshortening: 1/sin(37°) = 1.66 against 1.77 measured directly off the render.

**One disagreement, left implemented the doc's way.** Dark-mark saturation measures **0.95–0.98**
here, not 0.51. At a threshold isolating the strongest marks the median is `#012c4d`, whose hue
(206) and lightness (0.15) match the stated `#142c3e` closely but whose saturation does not —
a greyed navy versus a darker blue in the water's own family, and the frame reads as the latter.
`dark.saturationScale` ships at the stated 0.53; 1.0 is a one-line change.

### Aerial perspective: the sea is not hazed like the land

00 §3 rule 5 is written about land, and the frames show that is not an accident. Distant land
collapses in saturation — the archipelago's islands read s=0.09 / 0.06 / 0.11 near to far —
while in the same frames the **sea holds s=0.91–0.99 all the way to the horizon**, lightening
(l 0.12 → 0.22) and rotating a few degrees toward cyan without washing out.

That is not a density tuning problem. Sea colour is very dark, and a small lerp in *linear*
space toward a bright sky is an enormous perceptual move: 7% haze on `#04414f` lands on
`#32505d`, dropping saturation 0.88 → 0.30 while the haze fraction still reads as "barely
any". `applyAerialPerspectiveTinted(…, satHold)` restores saturation after the lerp and
leaves the lightness and hue shift intact. `satHold` is 1 for the sea, 0 for everything else,
so land keeps rule 5's behaviour unchanged.

### Known limitations, deliberately not fixed in this step

- **Vertex displacement reaches only 45 m.** It has to fall to zero before the first ring
  boundary or displaced vertices leave T-junction cracks against the coarser ring — a bright
  hairline of sky along the seam. Skirts or edge stitching would let it extend; the near
  field is all that needs real displacement until the landing/taxi camera exists.
- **Glint shelter is inferred from depth**, not from wind or fetch. Both cove references are
  glassy across the whole turquoise shelf while the harbour and open-sea frames are full of
  marks, so sparkle fades in over depth01 0.50 → 0.75. Step 4's fetch field is the honest
  version.
- **The shallow end of the ramp is one of two readings.** image-3 shelves onto bright sand
  that shows through and drags shallow water toward pale desaturated green; the karst pool
  has steep walls and no visible bottom, so at equal lightness it is ~30° bluer and twice as
  saturated. Both are real, and which applies is a seabed-albedo question with no answer
  until Step 3. `SEA_RAMP_NO_SAND` records the other branch so the switch is one edit.
- **No land yet**, so the shore side of the frame renders as the ramp's palest stop with no
  beach or cliff on it. The probe detects and skips that region rather than measuring it.
- **The gradient is smooth but untextured.** Its only irregularity is the shape-scale contour
  wander; the reference has visible brush and paper texture on top. That is Step 6's grain
  pass, not something the depth ramp should be faking.
- **The sea has no sub-wave surface streaking.** In the harbour reference the marks sit on
  soft directional streaks running along the swell, and read as highlights *on* a textured
  surface. Mine is an isotropic scatter inside the patch gate, on flat colour. Measured, the
  brightest marks also stop short of the reference: median lightness matches (0.49 vs 0.50)
  but the top of the range reaches 0.57 against 0.68.
- **The turquoise shelf is narrower than the reference's.** The ramp colours match the frame
  at every point on the hue/saturation ladder, but `SHELF_PROFILE` reaches depth01 0.5 by
  70 m from shore, so the turquoise range occupies a thin strip. In image-3 it dominates the
  frame. That is the placeholder bathymetry's profile, not the ramp, and Step 3 sets it.
