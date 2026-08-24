import { LAND } from '../../art/palette';
import { BIOME } from '../island/BiomeField';

/**
 * THE SPECIES TABLE — `03 — Procedural Islands.md` §8.1, and the Ghibli shader's colour maps.
 *
 * DATA ONLY. No three.js import, same rule as `art/`.
 *
 * §8.1 is a silhouette specification, not a modelling one: "A cypress is a dark green
 * teardrop. A stone pine is a flattened umbrella... never model bark." So a species here is
 * a silhouette profile plus a triangle count plus a placement rule, and the shading is four
 * authored hexes in a colour map.
 *
 * TWO COLOUR MAPS PER SPECIES, and that is deliberate. The reference implementation's
 * `Scene.jsx` draws two tree groups with two different four-colour arrays rather than one
 * group with jitter, so a stand reads as several kinds of green instead of one. Doing the
 * same per instance keeps every rendered colour an authored 00 §2 hex — a per-instance tint
 * multiply would invent colours that are on no palette entry, and the palette gate exists
 * because that is how a sampled art direction quietly stops being the art direction.
 */

export type SpeciesName = 'clump' | 'cypress' | 'stonePine' | 'holmOak' | 'macchia';

/** Four tones, lit to darkest — the Ghibli shader's `colorMap`. */
export type ColorMap = readonly [number, number, number, number];

/**
 * Distance window, metres, ascending: `[goneNear, fullNear, fullFar, goneFar]`.
 *
 * A trapezoid rather than a single cutoff, because the ladder has a MIDDLE rung. Trees are
 * full from zero out to `fullFar` and gone by `goneFar`; the clump layer has to disappear
 * when the camera is close enough for the trees themselves to be legible, so it needs a near
 * edge too. Every transition is a smoothstep on the instance's own scale, so a rung entering
 * or leaving is a growth, never a pop.
 */
export type VisibilityWindow = readonly [number, number, number, number];

export interface SpeciesSpec {
  readonly label: string;
  /** Silhouette archetype. Drives which geometry builder runs. */
  readonly shape: 'teardrop' | 'umbrella' | 'blob' | 'dome' | 'crown';
  /** Which rung of 03 §8.2's LOD ladder this is. */
  readonly tier: 'mid' | 'near';
  /** Metres. See VisibilityWindow. */
  readonly visible: VisibilityWindow;
  /** Metres, before per-instance scale variation. */
  readonly height: number;
  /** Canopy radius in metres at the widest point. */
  readonly radius: number;
  /** Per-instance scale range, multiplied into height and radius together. */
  readonly scaleRange: readonly [number, number];
  /** Radial segments. Kept at §8.4's 8-24 triangles per instance. */
  readonly sides: number;
  /** Mean spacing in metres on fully dense ground — the placement grid's cell size. */
  readonly spacing: number;
  /** Biomes this species is placed in, with a per-biome density multiplier. */
  readonly biomes: Readonly<Record<number, number>>;
  /**
   * The Ghibli colour maps. Index 0 and 1 are chosen per instance.
   * Every entry must be an authored 00 §2 hex.
   */
  readonly colorMaps: readonly [ColorMap, ColorMap];
  /** The shader's three brightness cuts, descending. Repo default for trees: 0.6/0.35/0.001. */
  readonly thresholds: readonly [number, number, number];
  /** Metres of wind sway at the crown. 03 §8.3. */
  readonly sway: number;
  readonly note?: string;
}

const F = LAND;

/**
 * The dark-tree ladder, straight down 00 §2's greens: pale scrub, olive scrub, mid canopy,
 * dense forest, deep forest shadow. Same shape as the repo's #427062 -> #1E363F ladder —
 * value falling while hue rotates toward blue — but in this world's own hexes.
 */
const DARK_TREE: ColorMap = [F.canopyMid.hex, F.forestDense.hex, F.forestDense.hex, F.forestDeep.hex];
const DARK_TREE_ALT: ColorMap = [F.scrubOlive.hex, F.canopyMid.hex, F.forestDense.hex, F.forestDeep.hex];
/**
 * The scrub ladder, one rung up the palette from the trees.
 *
 * The alt map originally opened on `pastureBleached` (#c8cdbe), which is the palest green in
 * 00 §2 and reads as near-white at this size. On a 2 m dome with a mostly-lit normal that
 * put a field of pale discs across the hillside — the bushes looked like limestone boulders,
 * which is a real thing on a karst slope and not the thing being placed. `pastureDry`
 * (#a8b19d) is the same grey-green family two steps darker and still separates the alt map
 * from the base one.
 */
const DRY_SCRUB: ColorMap = [F.scrubOlivePale.hex, F.scrubOlive.hex, F.canopyMid.hex, F.forestDense.hex];
const DRY_SCRUB_ALT: ColorMap = [F.pastureDry.hex, F.scrubOlivePale.hex, F.scrubOlive.hex, F.canopyMid.hex];

export const SPECIES: Readonly<Record<SpeciesName, SpeciesSpec>> = Object.freeze({
  /**
   * THE MIDDLE RUNG — 03 §8.2's mid-range LOD, and the layer the reference frame is mostly
   * made of.
   *
   * §8.2 specifies a cross-billboard impostor here: two crossed quads with a tree silhouette
   * baked into an alpha cutout. This is a low-poly crown blob instead, and the swap is
   * deliberate. The impostor's whole advantage is that it costs 4 triangles against a
   * modelled tree's hundreds — but nothing in this world is modelled, the near species are
   * 18-42 triangles, and an impostor of an 18-triangle tree saves fourteen triangles in
   * exchange for an alpha-tested fragment, a texture fetch and a popping artefact whenever
   * the plane circles. §8.2 flags that popping itself as the reason to pin billboard angles.
   *
   * More to the point, a per-tree impostor is answering the wrong question. Look at
   * `peninsula-coastline-aerial-clouds`: at that range there are no individual trees to
   * impost. There are dark blue-green CLUMPS — groups of a dozen crowns reading as one mass,
   * scattered over lighter ground, dense in the valleys and sparse on the ridges. That is
   * what the middle of this ladder has to draw, and one wide 15-triangle blob per clump both
   * matches the reference and costs less than the dozen impostors it replaces.
   */
  clump: {
    label: 'Canopy clump (mid LOD)',
    shape: 'crown',
    tier: 'mid',
    // Gone by 70 m — inside that the individual trees are legible and the clump would be a
    // green boulder sitting among them. Full from 190 m out to 1.4 km, where the hull's own
    // painted mottling takes the grain over.
    visible: [70, 190, 1400, 2400],
    height: 9,
    radius: 8.5,
    scaleRange: [0.65, 1.5],
    sides: 5,
    spacing: 19,
    biomes: {
      [BIOME.denseForest]: 1.0,
      [BIOME.sparseForest]: 0.7,
      [BIOME.terrace]: 0.3,
      [BIOME.macchia]: 0.22,
      [BIOME.pasture]: 0.1,
    },
    colorMaps: [DARK_TREE, DARK_TREE_ALT],
    thresholds: [0.6, 0.35, 0.001],
    sway: 0.25,
  },

  /**
   * 03 §8.1: "tall narrow teardrop... ~10-14 m tall". The single most recognisable
   * silhouette in the setting, and the one that most needs to survive at 1500 m — which is
   * why it is the only species allowed to be tall and thin rather than wide.
   */
  cypress: {
    label: 'Cypress',
    shape: 'teardrop',
    tier: 'near',
    // Cypresses hold further out than anything else their size: a black exclamation mark
    // against a pale terrace is legible long after a round crown has merged into the mass.
    visible: [-1, -1, 520, 1300],
    height: 12,
    radius: 2.0,
    scaleRange: [0.78, 1.25],
    sides: 6,
    spacing: 19,
    biomes: {
      [BIOME.terrace]: 1.0,
      [BIOME.pasture]: 0.55,
      [BIOME.macchia]: 0.2,
      [BIOME.sparseForest]: 0.3,
    },
    colorMaps: [DARK_TREE, DARK_TREE_ALT],
    // Tighter top cut than the repo default: a cypress is nearly all shadow with one lit
    // edge, and that edge is the whole silhouette read at altitude.
    thresholds: [0.66, 0.3, -0.05],
    sway: 0.45,
    note: 'Placed along terrace edges and around villages, per §8.1 and §9.',
  },

  /**
   * 03 §8.1: "flattened umbrella — a wide flat disc canopy on a short trunk". The counterpart
   * to the cypress: horizontal where that is vertical, which is what makes a mixed stand read
   * as two species rather than as one shape at two scales.
   */
  stonePine: {
    label: 'Stone / Aleppo pine',
    shape: 'umbrella',
    tier: 'near',
    visible: [-1, -1, 420, 1000],
    height: 11,
    radius: 5.4,
    scaleRange: [0.8, 1.3],
    // Six, not eight. The umbrella needs five profile rings to keep a trunk under a flared
    // canopy, and at eight sides that is 56 triangles — over double §8.4's near-LOD budget
    // for the one species whose silhouette is a disc nobody counts the sides of.
    sides: 6,
    spacing: 22,
    biomes: {
      [BIOME.sparseForest]: 1.0,
      [BIOME.denseForest]: 0.45,
      [BIOME.macchia]: 0.35,
      [BIOME.pasture]: 0.2,
      [BIOME.terrace]: 0.25,
    },
    colorMaps: [DARK_TREE, DARK_TREE_ALT],
    thresholds: [0.6, 0.35, 0.001],
    sway: 0.35,
  },

  /**
   * The dense-forest filler. Not a named archetype in §8.1, which lists two; it is here
   * because §7.2's dense-forest row needs a body and a forest of nothing but umbrellas and
   * teardrops reads as an orchard. A rounded blob is the third silhouette every Ghibli
   * hillside actually has.
   */
  holmOak: {
    label: 'Holm oak / broadleaf',
    shape: 'blob',
    tier: 'near',
    visible: [-1, -1, 340, 780],
    height: 8,
    radius: 4.2,
    scaleRange: [0.7, 1.35],
    sides: 5,
    spacing: 10,
    biomes: {
      [BIOME.denseForest]: 1.0,
      [BIOME.sparseForest]: 0.6,
      [BIOME.terrace]: 0.3,
      [BIOME.pasture]: 0.12,
    },
    colorMaps: [DARK_TREE, DARK_TREE_ALT],
    thresholds: [0.6, 0.35, 0.001],
    sway: 0.3,
  },

  /**
   * Macchia — the low aromatic scrub that covers every exposed Adriatic slope. Dry, pale,
   * and the only species whose colour map starts above mid-green, because 00 §2 puts the
   * scrub hexes lighter than the forest ones and the frames agree: the seaward flanks are
   * noticeably paler than the sheltered valleys.
   */
  macchia: {
    label: 'Macchia scrub',
    shape: 'dome',
    tier: 'near',
    // The shortest hold of the four: a 2 m bush is sub-pixel by 200 m and the painted
    // mottling on the ground underneath carries the scrub texture from there out.
    visible: [-1, -1, 150, 380],
    // Taller than it is wide, unlike the first pass. A 1.9 m mound of 2.3 m radius is a
    // disc, and a disc lying on a hillside presents a nearly flat upward normal everywhere,
    // so the whole bush resolves to one band and reads as a painted blob rather than a form.
    height: 2.4,
    radius: 1.9,
    scaleRange: [0.6, 1.35],
    sides: 5,
    spacing: 6,
    biomes: {
      [BIOME.macchia]: 1.0,
      [BIOME.pasture]: 0.35,
      [BIOME.terrace]: 0.5,
      [BIOME.sparseForest]: 0.45,
      [BIOME.denseForest]: 0.3,
      [BIOME.bareRock]: 0.25,
    },
    colorMaps: [DRY_SCRUB, DRY_SCRUB_ALT],
    // Brighter cuts than the trees: scrub is a low mound in full sun, mostly lit band.
    thresholds: [0.45, 0.16, -0.2],
    sway: 0.14,
  },
});

export const SPECIES_NAMES = Object.freeze(Object.keys(SPECIES) as SpeciesName[]);

/**
 * THE LADDER, 03 §8.4.
 *
 * Three rungs, and every handover is a continuous growth rather than a switch:
 *
 *   > 1.4 km   canopy-mass hull alone. Its painted mottling supplies the grain — the
 *              reference frame still shows clumped texture at its horizon, so a smooth
 *              shell would be wrong here, not merely cheap.
 *   190-1400   clumps grow in over the hull. This is the frame's own scale: dark masses of
 *              a dozen crowns, not individual trees.
 *   < 520      species grow in; the hull retracts under the terrain; the clumps shrink out
 *              by 70 m. The painted noise gains octaves over the same window, so the grain
 *              keeps resolving after the geometry has finished arriving.
 *
 * Per-species windows live in the table above; these are the hull's, which has to be the
 * mirror of the clump layer's or the two leave a gap with no grain in it.
 */
export const LOD = Object.freeze({
  /** Metres. The hull is fully retracted under the terrain at and below this. */
  nearRange: 210,
  /** Metres. The hull is at full lift at and beyond this. */
  farRange: 900,
  /** Metres of canopy lift on the mass hull. */
  canopyLift: 7,
  /** Painted detail is at full octave count at and below this distance. */
  detailFullAt: 90,
  /** ...and down to the base octave alone at and beyond this. */
  detailNoneAt: 1600,
});

/**
 * 03 §10.1's ceiling is 150k foliage instances, but that ceiling was written against the
 * global 1.2 M triangle budget and 150k x ~20 tris is 3 M on its own. The binding constraint
 * is triangles, so this is the number the placer actually caps on; the instance ceiling is
 * checked too and is not the one that bites.
 *
 * 700k of the global 1.2 M, against the island's 86k and the ocean's 45k. Foliage is where
 * the density in the reference frame lives, so it gets the bulk of the budget — and it can,
 * because most of those triangles are collapsed by the vertex shader in any given frame.
 */
export const FOLIAGE_TRIANGLE_CEILING = 700_000;
