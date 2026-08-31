# src/models/

Drop `.glb`, `.gltf`, `.fbx` or `.obj` files in here and they appear in the bench's
`src/models/` dropdown at <http://localhost:5173/testmodels> — no registration step, the
bench globs this folder.

Two other ways in, for a file that does not live in the repo:

- **Drag and drop** it onto the bench window. For a `.gltf` export, drag the whole folder's
  contents at once so the loader can resolve the `.bin` and textures by filename.
- **`browse files...`** in the Model panel, same rules.

`?model=<filename>` loads one of these files on boot, so a particular framing is linkable.

Nothing here is committed except `reference-box.gltf` — see `.gitignore`. Model files are
scratch, and binary assets have no business in the history of a repo that generates its
world procedurally.

## What is in here now

- **`reference-box.gltf`** — a 10 × 3 × 6 m box, authored in metres, in the palette's
  terracotta. A calibration object: if this does not read as 10 m against the scale rod,
  the bench is lying to you before any real asset arrives.
- **`Porcorosso.fbx`** — the Savoia S.21 (from `porco-rossos-savoia-flying-boat.zip` in
  `~/Downloads`). Gitignored; re-copy it if you reclone. **The download ships no textures at
  all** — the archive is the single `.fbx`, and the asset is material-coloured only. There is
  nothing to hook up.

  Three things about it worth knowing, all of which the bench reports on load:

  - It carries **its own lighting rig** — a 1500-intensity point light, a 250 spot, and a
    directional. Those are stripped on load (04 §1 says one sun) and the count is reported.
    Left in, they blow every surface past 1.0 under `NoToneMapping` and the bloom pass turns
    the model into a white ball.
  - It bundles a **whole diorama**: an 8.8 m water plane (the 101k-triangle `Plane`), a jetty
    (`boards`), a row of `barrels`, and a spare `COPY_cabin` parked off to one side. All of
    it is hidden by `Porcorosso.parts.json` — see below.
  - **331,509 triangles across 38 meshes.** The whole-world ceiling in 00 §5 is 1.2M
    triangles and 40 draw calls. One hero aircraft at a quarter of the triangle budget and 38
    of the 40 draws is not shippable as-is; it needs a decimate and a material merge.

- **`bird.fbx`** — a rigged gull, from `birds.zip` in `~/Downloads`. Gitignored
  like the Savoia; 330 kB, 810 triangles, no textures, material-coloured black with a yellow
  beak. `/grassworld` flies six of them over the meadow.

  **The file looks like a five-bird flock and is not one.** It ships five `SkinnedMesh`es,
  five armatures and a 0.67 s clip of 105 tracks — which reads as 5 birds x 7 bones x 3
  channels. But all five armatures use the *same seven bone names*, and an `AnimationMixer`
  binds a track to a node by name, first match in a depth-first walk. So all fifteen tracks
  called `Bone.quaternion` land on one armature's `Bone` and fight over it, and the other
  four armatures are never addressed. Load it as-is and exactly one bird flaps while four
  glide in their bind pose.

  `src/dev/grass/Birds.ts` therefore uses the file for the one thing it reliably contains —
  a single rigged, animated bird — and clones that six times, each with its own skeleton,
  mixer and place in the wingbeat. Renaming five armatures' worth of bones inside a binary
  FBX is not a fix this repo should be making.

## Sidecars: `<model>.parts.json`

A model file may sit next to a sidecar of the same stem — `Porcorosso.fbx` is configured by
`Porcorosso.parts.json`. Sidecars ARE committed (see `.gitignore`); they are a few hundred
bytes and they are the only record of *why* an asset is shown the way it is.

```json
{ "note": "why these parts are not the subject", "hide": ["Plane", "boards"] }
```

`hide` names top-level parts to switch off before the first fit. It exists because assets
arrive with their showroom attached, and a showroom is geometry like anything else: it lands
in the bounding box and the auto-fit sizes to the diorama instead of to the subject. Hiding
those four parts of the Savoia takes the authored bounds from 2056 to 1221 units and puts
the wingspan back on the longest axis.

Applied before the fit, not after, so the model does not visibly resize a moment after it
appears. Everything stays togglable in the **Parts** panel — un-tick nothing and you have
the original diorama back. A name the asset does not have is reported rather than ignored,
because that usually means the sidecar was written against an older export.

## What the bench is for

**Scale first.** The world is in metres; exporters are not. Turn `auto-fit` off, read the
`authored` line, and compare against the 10 m scale rod and its 1.8 m mark. An asset that
only looks right at `0.007x` was authored in some other unit entirely.

**Then the `range200` / `range800` / `range1500` framings**, which are 00 §3 rule 9's stated
camera envelope. An asset that reads at 20 m and dissolves at 800 m is not finished.

**Then `shading: original` versus one of the surface presets.** The world runs one gouache
shader with per-surface uniforms (04 §2.3). A model that only holds together under its own
baked maps will not match anything around it.

## The `original`-mode controls, and why they exist

`shading: original` keeps the asset's own materials, which are lit by three.js rather than
by the gouache chunk — so three settings appear that affect *nothing else in the project*:

- **exposure** — 04 §1 runs the sun at intensity 2.0, which is free for gouache surfaces
  because that shader discards three's lighting and reads only the sun's direction. An
  imported PBR material does read it, and white albedo × 2.0 with no tone mapping (00 §5) is
  pure white. 0.35 puts it back in range.
- **PBR fill** — the rig has no fill light on purpose. Without one, an imported material's
  unlit faces are pure black, which reads as a broken import. Cyan, not grey (00 §3 rule 2).
- **tame gloss** — flattens specular and metalness to the matte ceiling the art direction
  assumes. Reversible, and the count of affected materials is reported.

Every one of these is a viewing aid for imported materials. None of them can touch the sky,
the ground plane, or any gouache preset.
