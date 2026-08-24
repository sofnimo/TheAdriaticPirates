# 00 — Art Direction Bible
### Project: 1920s–30s Italian Seaplane Adriatic — Three.js world
### Source of truth for all other docs in this folder. Written from the six supplied reference frames (Ghibli / *Porco Rosso* lineage) with palette values sampled directly from those images.

---

## 1. The one-sentence read

A **hand-painted gouache postcard of the Adriatic, seen from 800 metres up** — flat, luminous, high-chroma seawater; soft cream-and-white cumulus built like sculpture; islands that read as warm limestone and dusty green rather than realistic rock and foliage; and a single hot vermilion object (the plane) that the entire world exists to make sing.

The world is **not** photoreal, and it is **not** flat-shaded low-poly. It is *painterly*: large areas of clean, confident colour with **stepped tonal bands** instead of smooth gradients, and only a few hand-placed highlights. Detail lives in **silhouette and colour separation**, not in texture density or normal maps.

---

## 2. Sampled palette (from your references)

These are measured dominant clusters, not guesses. Use them as the anchor set; everything else should be interpolated between them.

### Deep open sea — the signature colour
| Role | Hex | Notes |
|---|---|---|
| Abyssal / far-from-land | `#0c3273` | Frame 1 (top-down shadow shot). Almost ultramarine ink. |
| Deep sea, sunlit | `#024892` · `#033a82` | The workhorse open-water tone. |
| Mid-blue sea, chop-lit | `#014575` · `#03547c` | Frame 5. Slightly greener, hazier. |
| Sea in shadow / under cloud | `#012438` · `#02365b` | Used as a *hard-edged* patch, not a soft falloff. |
| Wave-crest / foam-streak highlight | `#488a95` → `#a6b5d5` → `#e7e6eb` | Only 3–6% of sea pixels. Discrete dashes. |

### Shallow / coastal water
| Role | Hex |
|---|---|
| Deep lagoon edge | `#074d5c` |
| Turquoise shelf | `#14707c` |
| Bright shallow sand-lit | `#498e8e` → `#309dac` → `#62afb4` |

The **shelf transition is the most important colour event in the entire game.** In frame 3 (the cove) the water goes from near-black teal to electric turquoise to cream sand as a **smooth, continuous painted gradient** — measured pixel-by-pixel down the actual reference frame, the colour shifts by a small amount almost every row, with no plateau-then-jump pattern anywhere in the transition. **Correction:** an earlier version of this doc called this a hard 1–2px band edge. That was wrong — verified by direct pixel sampling (step-to-step colour delta down a clean water column averages ~5/255 per row, with no plateau-then-jump pattern anywhere). This turns out to be a general rule, not a water-specific one: I also sampled the sky's zenith-to-horizon transition (frame 2, clear column) and it shows the identical pattern — steady small increments every few rows, no bands. **Ghibli background elements (sky gradient, water depth-to-shore colour) are painted as smooth continuous gradients. Only foreground objects (plane, cliffs, foliage, buildings, clouds-as-sculptural-objects) get the stepped/quantised cel ramp from rule 1.** Do **not** apply rule 1 to: the sky dome's zenith→horizon gradient, or the water body's depth-driven base colour. Both should be continuous lerps (noise-perturbed for organic variation is fine, banding is not). Foam and glints (discrete painted marks, rule 4) remain a separate, correctly hard-edged layer painted on top of the smooth water base — that part stands, as does every cel-shaded object rule. **Action needed: `01_SKY_AND_CLOUDS.md`'s sky-dome gradient (not the cloud objects) and `02_WATER.md`'s depth-colour ramp both need revising from stepped bands to continuous gradients.**

### Sky
| Role | Hex |
|---|---|
| Zenith | `#1ca6c7` → `#169abb` (a real cyan, not a pale blue) |
| Mid sky | `#4ba8c6` · `#69b2cb` |
| Horizon haze | `#b1cbd3` → `#d0dbdf` |
| Cloud lit face | `#ebedea` (near-white, very slightly warm/green-grey) |
| Cloud shadow face | `#8cbdcb` · `#9bb5a8` — clouds shade **towards the sky's own cyan**, never towards grey |

### Land
| Role | Hex |
|---|---|
| Dense forest / shadow mass | `#1f4e38` · `#101d19` |
| Mid canopy | `#45764e` |
| Sparse scrub / olive | `#6a955f` · `#8eac71` |
| Dry pasture, sun-bleached grass | `#a8b19d` · `#c8cdbe` |
| Limestone cliff, lit | `#cbc5ad` · `#d6d2cc` |
| Limestone cliff, strata / shadow | `#726f60` · `#534a40` · `#2e312b` |
| Beach sand | `#cbc5ad` warmed towards `#ddd0a8` |
| Terracotta roof, brick, harbour detail | `#a42a08` · `#654532` |

### The hero accent — reserve it
`#c63427` / `#b63118` (plane vermilion) and `#a42a08` (terracotta). **No natural surface in the world may use saturated red.** Red is the player, the roofs, and the Italian tricolour rudder. This is why the sea is allowed to be so blue.

---

## 3. Non-negotiable style rules

1. **Two-tone-plus-accent shading.** Every surface resolves to a lit tone, a shadow tone, and at most one rim/highlight tone. Implement with a **quantised / stepped diffuse ramp** (2–4 steps), not Lambert falloff. This single decision is what makes it read as cel/gouache.
2. **Shadow tones use an authored tint, never a flat multiply.** The *mechanism* is binding — always `mix(base, shadowTint, amount)` against a hand-picked hex, never `base * 0.5`. The *magnitude* of hue shift this produces varies honestly by surface, per the actually-sampled reference pixels: cloud shifts hard toward the sky's own cyan (~93° hue shift, `#ebedea`→`#8cbdcb`) and forest shifts toward blue-green (~20°). Sea and limestone shadow in the source frames are mostly a lightness/saturation drop with only a small hue change (sea ≈9°, `#024892`→`#012438`; limestone ≈16°, `#cbc5ad`→`#534a40`) — call it "near-black indigo" and "warm brown-grey", not "violet". Do not invent a stronger hue rotation than the sampled hexes in §2 show just to chase a punchier rule of thumb — the mechanism (authored tint, not multiply) is what protects the look; the exact hue delta should follow the reference, not a slogan.
3. **Hard shadow edges, soft shadow interiors.** Frame 1 shows the plane's shadow on water as a *crisp, solid, single-tone silhouette* with zero penumbra gradient. Aircraft shadows are the strongest storytelling device you have (see `04_LIGHT.md`).
4. **Discrete painted highlights — an ambient field on lively water, absent on glassy water.** Foam, wave glints and sun sparkle appear as **dashes, ovals and slashes with hard edges**, never a Blinn-Phong lobe. The ambient glint field is real and is **primarily evidenced by `image-4.jpg`** (racing planes). Measured in a 479×571 px region of that frame's open water, well clear of the wake and both aircraft:
   - **Coverage is high: 16.1% total** — 13.1% light marks plus 3.0% dark marks. This is far denser than the ~4–6% figure `02_WATER.md` §3 currently targets.
   - **Two populations, not one.** Light marks average `#548da2` (HSL 196°, s 0.32, l 0.48) and dark marks average `#142c3e` (HSL 206°, s 0.51, l 0.16), both against base water `#025277` (HSL 199°, s 0.97, l 0.24). So marks go **both lighter and darker** than the water. A lighten-only model misses roughly a fifth of the field. In both directions saturation drops sharply from the base (0.97 → 0.32 / 0.51) while hue barely moves (±7°).
   - **One strong shared axis, confirmed:** 96.7% of light marks and 87.5% of dark marks are wider than tall, all near-horizontal. Aspect W/H median 6.9, p90 10.3 (light); median 8.5, p90 11.5 (dark).
   - **Correction, and a reversal.** An earlier revision of this rule claimed discrete highlights are disturbance-attached only and that no ambient field is supported by the references. **That was wrong.** It was reached by checking frames that happen to show *glassy or distant* water (`image-5.jpg`, `peninsula-coastline-aerial-clouds`, `island-harbor-ships-gathering-aerial`, `plane-over-archipelago-wide`, the cove in `image-3.jpg`) — all genuinely flat — while the one frame that shows near, lively, sunlit open water was missing from the reference folder at the time. Frame 5's citation was still wrong, but the ambient premise was right.
   - **The real rule is sea state, not disturbance.** Glassy/sheltered water (coves, harbours at rest) and distant water carry **no discrete marks**; near, open, sunlit water carries a **dense** field. Drive glint density from sea state and shelter, and fade it out with distance — do not remove it, and do not gate it behind a wake source. Shoreline breaking foam remains its own separate system in `02b_COASTAL_WAVES.md`.
   - **Correction on frame 1 (`image.jpg`):** its teal streaks are not ambient wave glints either. They radiate from behind the aircraft's position rather than scattering independently across the sea — the anime **speed-line** convention for conveying velocity during a fast, low pass, a camera/motion effect tied to the plane, not a persistent property of the water surface. Also do not use `plane-topdown-shadow-sea-alt-crop.jpg.jpg` (a crop of the same frame) as glint evidence for the same reason. Speed lines are a separate, optional, undecided effect — if built at all, treat them as a velocity-triggered overlay, not a water-material feature, and keep them out of `02_WATER.md`'s glint/wake system entirely.
5. **Aerial perspective is strong and colour-based — but sea and land do NOT share one haze curve.** Haze is a colour lerp toward `#b1cbd3`, never a grey fog. **Land** hazes exactly as previously written: distant land desaturates hard *and* shifts to the sky's cyan within ~3 km — in `plane-over-archipelago-wide`, a near island reads `#456457` (hue 155°, s 0.18, l 0.33) while far ridgelines read `#82a2a8`/`#83a7ae` (hue ~190°, s 0.18–0.21, l 0.59–0.60): the hue swings to sky-cyan and lightness nearly doubles.
   **Sea resists haze far longer than land, but not indefinitely.** Measured down an open-sea column in `peninsula-coastline-aerial-clouds`, the sea holds saturation **0.96–0.99 from the foreground all the way to just below the horizon band** — no progressive desaturation at all. But in `plane-over-archipelago-wide` the sea does collapse in the final approach to the horizon: foreground `#002039` (s 0.97, l 0.12) → mid `#052b4d` (s 0.87, l 0.16) → immediately below the horizon `#2e677f` (s 0.46, l 0.34).
   So the correct model is a **late-onset, sharp-kneed haze on water**: essentially none across the near and middle field, then a rapid collapse in the last band before the horizon. It is **not** "sea never hazes" (a full saturation hold to the horizon is wrong — the archipelago frame contradicts it), and it is **not** the land curve. Note also that a small haze fraction applied to very dark sea colour destroys saturation disproportionately, so tune the water curve by *measured saturation retention*, not by the haze fraction reading "small".
6. **Silhouette over detail.** A cypress is a dark green teardrop. A stone pine is a flattened umbrella. A village is 6 terracotta dashes. Never model bark.
7. **No visible tiling, no visible noise.** Ghibli backgrounds have variation at the *shape* scale. Break up large fields with **irregular patch boundaries** (fields, groves, rock strata) rather than high-frequency texture.
8. **Grain, faintly.** Frame 4 has visible film/paper grain on the flat colour areas. A very subtle static grain + 1–2% chroma wobble sells the painted origin. Keep it below the threshold of "effect".
9. **Everything reads at altitude.** The default camera is 200–1500 m looking down at 20–45°. Every asset must be authored for **top-down and three-quarter aerial legibility first**.
10. **Composition negative space.** Frames 1 and 5 are >70% uninterrupted flat sea. Resist the urge to fill the ocean. Emptiness is the mood.

---

## 4. Period grounding (1920s–30s Adriatic)

- **Geology:** Dalmatian karst — the real Adriatic islands are drowned limestone ridges. This is a gift: it *naturally* produces long, thin, parallel islands, pointed peninsulas, fjord-like channels, sheer white sea-cliffs, sinkhole coves, and almost no rivers. Lean into it (`03_ISLANDS.md`).
- **Vegetation:** Aleppo/stone pine, cypress, holm oak, macchia scrub, terraced olive and vine, dry sage-green pasture. Nothing lush, nothing tropical, nothing autumnal.
- **Built world:** Venetian-Gothic harbour towns, campanili, terracotta roofs, whitewashed lighthouse, hangar sheds, seaplane slipways, canvas tents, Regia Aeronautica roundels, tricolour markings, radio masts.
- **Atmosphere:** Mediterranean summer. Late-morning to golden-hour sun. Bora wind days give you the excuse for whitecaps and torn cloud.

---

## 5. Technical style contract (feeds every other doc)

| Decision | Commitment |
|---|---|
| Renderer | WebGL2 / Three.js, `WebGLRenderer` with `ACESFilmic` **off** — use a custom or `NoToneMapping` + hand-graded LUT so the palette above survives untouched. |
| Colour space | `outputColorSpace = SRGBColorSpace`, author all albedo in sRGB, keep lighting maths linear. |
| Material base | Custom `ShaderMaterial` / `MeshStandardMaterial` + `onBeforeCompile` injection for the stepped ramp. One shared "gouache" shader chunk reused by terrain, foliage, cliffs, buildings. |
| Lighting | One directional sun (shadow-casting) + one hemisphere fill tinted sky-cyan above / sand-warm below. No area lights, no GI, no reflection probes except a cheap sky cubemap. |
| Shadows | `PCFSoftShadowMap` but with tight cascades and a **near-zero blur radius** to keep edges hard. |
| Post-chain | Depth-colour fog → bloom (tight threshold, only for sun glare and foam) → grain → subtle chroma/vignette. Order matters. |
| Budget target | 60 fps at 1440p on a mid laptop GPU; ocean + sky + 3 visible islands ≤ 1.2 M triangles, ≤ 40 draw calls for terrain. |

---

## 6. Doc map

- `01_SKY_AND_CLOUDS.md` — sky gradient, sculptural cumulus, cloud shadows, flying *through* cloud.
- `02_WATER.md` — depth-driven colour, painted glints, swell, wakes, the shelf band.
- `02b_COASTAL_WAVES.md` — shoreline foam, breaking waves, wet sand, rock spray.
- `03_ISLANDS.md` — procedural karst: cliffs, coves, peninsulas, ridges, hills, rivers, lakes, forest density.
- `04_LIGHT.md` — sun, cel ramps, hard shadows, glare, aerial perspective, time of day.
