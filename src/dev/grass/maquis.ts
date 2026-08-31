import * as THREE from 'three';
import { LAND } from '../../art/palette';
import type { SurfaceUniforms } from '../../vendor/grassField/uniforms';

/**
 * ADRIATIC EVERGREEN MAQUIS — a second plant community for the grass world.
 *
 * DERIVED FROM THE SAME PROTOTYPES AS THE TREES, not modelled separately. The grass world's
 * trees are clusters lifted out of `grass-scene.glb`; there is no procedural tree generator to
 * add a species to, and authoring a new mesh would mean a new binary in a repo that keeps
 * model files out of its history on purpose. So maquis reuses those crowns and changes the
 * three things that actually distinguish the plant: its PROPORTIONS, its COLOUR, and the
 * GROUND IT CHOOSES.
 *
 * WHAT MAQUIS ACTUALLY IS. Mediterranean evergreen shrubland — myrtle, mastic, kermes oak,
 * juniper — dense, leathery, and low. It is not a small tree: a stand is one or two metres
 * tall and as broad as it is high or broader, which is why the scale below is anisotropic
 * rather than a smaller uniform tree. Squashing a conifer crown down and out is a fair
 * approximation of that silhouette, and a far better one than shrinking it evenly.
 *
 * AND IT GROWS WHERE THE PINES WILL NOT. Maquis is the community that holds the dry, thin,
 * exposed, rocky ground — it is what covers a hillside the forest has given up on. The scatter
 * therefore inverts the trees' preferences rather than sharing them: it takes the steeper
 * slopes, prefers the bare-earth mask the trees avoid, and comes closer to the shore. That
 * inversion is what makes the two read as different plants competing for a hillside instead of
 * one asset at two sizes.
 */

/** Sole-to-crown proportions, as multipliers on a tree prototype's own scale. */
export const MAQUIS = {
  /** Vertical squash. A 4 m crown becomes a shrub a bit over a metre. */
  heightScale: [0.26, 0.42] as const,
  /** Horizontal spread. Broader than tall once the squash is applied. */
  widthScale: [0.55, 0.95] as const,
  /** Metres between stands. Tighter than the trees: maquis grows as a thicket. */
  minDistance: 1.9,
  /** Steepest ground it will take. The trees stop at 0.45; scrub keeps going. */
  maxSlope: 0.72,
  /** Sunk further than a tree, so the squashed crown meets the ground with no trunk gap. */
  sink: 0.35,
} as const;

/**
 * The leaf palette, taken from the project's own authored scrub colours rather than invented.
 *
 * `LAND.scrubOlive` and `LAND.forestDense` are 03 §7.2's anchors for exactly this vegetation,
 * so the shrub in the grass world is painted the same colour the island generator would paint
 * it. `uLeafTop` is the sunlit outer shell and `uLeafBottom` the shaded interior; the gradient
 * between them is what gives a dense mass its depth.
 */
export const MAQUIS_LEAF = {
  /** Shaded interior. Nearly black-green — maquis is dense enough to swallow its own light. */
  bottom: LAND.forestDense.hex,
  /** Sunlit shell. */
  top: LAND.scrubOlive.hex,
  /** Per-instance variation, so a thicket is not one flat tone. */
  variation: LAND.forestSparse.hex,
  /**
   * Below the pine's 1.05. Maquis leaves are small, thick and matte — they do not flash the
   * way a conifer's needles do, and a leathery surface reads as darker at the same albedo.
   */
  brightness: 0.9,
  /**
   * Above the pine's 1.1, which pushes the gradient toward the dark end. That is the whole
   * look of a scrub mass: a bright rind over an interior you cannot see into.
   */
  gradPower: 1.65,
} as const;

/**
 * A surface uniform bag that paints maquis instead of pine.
 *
 * SHARES THE WIND BY REFERENCE, OVERRIDES ONLY THE COLOUR. The uniform objects for direction,
 * speed, frequency and time stay the SAME objects the grass and the trees are reading, so every
 * plant in the scene sways to one gust — the vendored material's own comment makes that a
 * requirement, and copying the bag wholesale would quietly give the shrubs their own private
 * weather. Only the five leaf-colour entries are replaced, and they are replaced with new
 * uniform objects so that writing to them cannot reach back into the pines.
 */
export function makeMaquisSurface(surface: SurfaceUniforms): SurfaceUniforms {
  return {
    ...surface,
    uLeafBottom: { value: new THREE.Color(MAQUIS_LEAF.bottom) },
    uLeafTop: { value: new THREE.Color(MAQUIS_LEAF.top) },
    uLeafVarColor: { value: new THREE.Color(MAQUIS_LEAF.variation) },
    uLeafBrightness: { value: MAQUIS_LEAF.brightness },
    uLeafGradPower: { value: MAQUIS_LEAF.gradPower },
  };
}
