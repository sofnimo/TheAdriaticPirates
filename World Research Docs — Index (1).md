# Adriatic Seaplane — World Research Docs

Reference: Studio Ghibli / *Porco Rosso*. Setting: 1920s–30s Italian seaplane presence in the Adriatic. Engine: Three.js / WebGL2.

Read in this order. `00` is the binding contract — every other doc defers to it on palette and style.

| Doc | Scope |
|---|---|
| [`00_ART_DIRECTION.md`](./00_ART_DIRECTION.md) | Style bible. Palette sampled directly from your six reference frames, 10 non-negotiable style rules, period grounding, renderer/post-chain contract. |
| [`01_SKY_AND_CLOUDS.md`](./01_SKY_AND_CLOUDS.md) | Sky gradient, sculptural cel-lit cumulus (4 techniques compared, one recommended), flying through cloud, cloud shadows on sea and land, perf. |
| [`02_WATER.md`](./02_WATER.md) | Open-sea geometry and LOD, Gerstner wave stacks per weather state, depth-driven banded colour, painted glint field, sky fresnel, seaplane wakes. |
| [`02b_COASTAL_WAVES.md`](./02b_COASTAL_WAVES.md) | Shore-distance SDF atlas, two-layer foam with run-up, breaking-wave ribbons, rock spray, wet sand, tide line, surf audio hooks. |
| [`03_ISLANDS.md`](./03_ISLANDS.md) | Procedural Dalmatian karst: ridge-aligned footprints, sheer cliffs vs terraced slopes, coves and seaplane lagoons, erosion, sparse rivers, biome cover, instanced vegetation, harbours. |
| [`04_LIGHT.md`](./04_LIGHT.md) | Sun/fill rig with time-of-day presets, the shared gouache ramp shader, cascaded hard shadows (incl. the aircraft-shadow-on-water problem), restrained glare, cyan aerial perspective, post order and grading. |
| [`05_DISTANT_TERRAIN_LAYERING.md`](./05_DISTANT_TERRAIN_LAYERING.md) | The four-layer land stack seen from the air: light-grass base, small yellow dried-grass patches, raised dark long grass, and independently noise-masked oak-only forest; plus canopy hulls, normal overriding and three-stop sun-gated dab lighting. Supersedes `03_ISLANDS.md` §8.1–§8.4. |

## Cross-doc dependencies to respect

- The **depth signal** used by `02_WATER.md`'s colour ramp and `02b`'s foam must be the same buffer. One source of truth.

- The **gouache ramp GLSL chunk** in `04_LIGHT.md` is shared by terrain, cliffs, foliage, buildings, clouds and aircraft. Do not fork it per material.
- `02b`'s coastline spline comes from `03_ISLANDS.md`'s footprint stage — it is not re-derived.
- Haze/aerial-perspective is applied once, in the shared chunk from `04_LIGHT.md`, not per-system.

## Suggested build order

1. Sky gradient + sun + gouache ramp chunk (`04`, `01` §sky) — establishes the palette on screen.
2. Flat ocean with banded depth colour against a placeholder bathymetry (`02`).
3. One hand-authored island to validate cliff/biome shading, then swap in the generator (`03`).
4. Shore SDF and foam (`02b`).
5. Clouds and cloud shadows (`01`).
6. Post chain, grain, grading lock (`04`).
