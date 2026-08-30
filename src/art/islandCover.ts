/**
 * LAND COVER — the four-tier stack of `05 — Distant Terrain Layering.md` §3, one config.
 *
 *   A0  base topography: sand, cliff rock, light green short grass.
 *   A1  dried-grass colour patches, composited INSIDE the light-grass material. A colour
 *       sublayer on A0, not raised geometry.
 *   B   longer dark-green grass: the raised, alpha-clipped, normal-offset overlay.
 *   C   oak forest, as clustered canopy hulls above B.
 *
 * DISTRIBUTION IS NOT MUTUALLY EXCLUSIVE (§3). A forest pixel may carry A0 grass, A1 dried
 * grass, B long grass and C canopy at once; the upper tier occludes the lower only where its
 * geometry is actually there. So there are three INDEPENDENT masks with their own seeds and
 * scales, correlated only through one very-low-frequency moisture field — §3.1 is explicit
 * that thresholding one noise three times draws visibly nested contour lines.
 *
 * THE VEGETATION LADDER IS A HUE ROTATION, NOT A BRIGHTNESS RAMP (§2.2). The three canopy
 * stops step about 10.5 degrees of hue apart while saturation roughly halves each step. Never
 * produce the lit tone by multiplying the dark one.
 *
 * Fields marked STRUCTURAL feed the baked masks or the hull scatter, so changing them
 * re-bakes; the rest are live uniforms.
 */

export interface IslandCoverConfig {
  /* ------------------------------------------------------------ A0 base materials */
  cliff: number;
  /** The darker limestone the strata bands cut with. §4's triplanar rock branch. */
  cliffStrata: number;
  sand: number;
  /** Light green short grass — the dominant exposed-ground colour. */
  grass: number;
  /** A1: sun-dried grass. Subordinate to the base green, never a biome of its own. */
  grassDry: number;

  /* --------------------------------------------------------------- A1 dried grass */
  /** STRUCTURAL. Metres per period of the dried-grass mask. Materially smaller than B's. */
  dryScale: number;
  /** STRUCTURAL. 0-1 of eligible light grass that dries off. §11 starts at 4-12%. */
  dryCoverage: number;
  /** Live. Width of the painted threshold, in mask units. */
  drySoftness: number;
  /** Live. A second decorrelated octave, so the patches are not one smooth blob field. */
  dryDetailScale: number;
  dryDetailAmount: number;

  /* ------------------------------------------------------------------ A0 shoreline */
  /** Metres of sand added to the width the generator actually deposited. A trim. */
  sandWidth: number;
  /** STRUCTURAL. Metres of pale shore every soft coast carries, beach or no beach. */
  shoreSandWidth: number;
  /** Metres the sand carries on seaward, under the water. A beach does not stop at zero. */
  sandSeaward: number;
  /** Metres of blend at the landward edge. */
  sandSoftness: number;
  /** Metres the sand line wanders, so it is not a contour offset. */
  sandEdgeWobble: number;
  sandEdgeScale: number;

  /* --------------------------------------------------------------------- A0 cliffs */
  /** Slope (0 flat, 1 vertical) at which ground starts turning to cliff. §3.1. */
  cliffSlopeStart: number;
  cliffSoftness: number;
  /** STRUCTURAL. Metres inland over which a cliff coast's rock gives way to ground. */
  coastRockNear: number;
  coastRockFar: number;
  /** Metres per limestone bed. §3.2 — driven off world Y so strata stay horizontal. */
  strataMetres: number;
  /** 0-1 how strongly the beds read. */
  strataStrength: number;

  /* ---------------------------------------------------------- B raised long grass */
  longGrass: number;
  /** Metres along the normal. §11 starts at 0.15-0.60 m, tapering to 0 on cliffs. */
  longGrassOffset: number;
  /** STRUCTURAL. Metres per period of the long-grass mask. Medium-scale islands. */
  longGrassScale: number;
  /** STRUCTURAL. 0-1 occupancy. This moves the PATCH OUTLINES. */
  longGrassCoverage: number;
  /** Live. Where the alpha test cuts. §5's material policy: alphaTest, never blending. */
  longGrassThreshold: number;
  /** Live. Metres per period of the high-frequency breakup that raggeds the patch edges. */
  longGrassBreakupScale: number;
  /** Metres of clearance the overlay keeps beyond the sand band's outer edge. */
  longGrassSandMargin: number;

  /* ------------------------------------------------------------------ C oak forest */
  /** §8.2's three stops. Shadow is also tier B's colour, which is what ties them together. */
  canopyDark: number;
  canopyMid: number;
  canopyLight: number;
  /** STRUCTURAL. Metres per period of `uForestMask`. Broad enough to form groves. */
  forestScale: number;
  /**
   * STRUCTURAL. 0-1 of eligible ground that is wooded.
   *
   * Eligible ground for tier C is the LONG GRASS, not the island — oaks are confined to tier
   * B (see CoverField's header). So this is a fraction of a fraction, and raising it toward 1
   * does not spread the forest past the grass, it only fills the grass in until the grove
   * outlines disappear. To get more trees over the same ground, `hullsPerCell` is the lever.
   */
  forestCoverage: number;
  /** Live. Soft continuous weight, so density and LOD handoff stay stable. §7.1. */
  forestThreshold: number;
  /** Metres of clearance the treeline keeps beyond the sand band's outer edge. */
  forestSandMargin: number;

  /**
   * STRUCTURAL. Metres per canopy cell. §11: larger than a hull, smaller than a hillside.
   *
   * The lower bound is the load-bearing one and it is not decorative: below a crown DIAMETER
   * the cell stops being a clumping unit and the scatter degenerates into a lattice with one
   * crown per node. `hullRadius` is 21 m, so 42 m is the floor whatever the density wanted.
   */
  canopyCellSize: number;
  /**
   * STRUCTURAL. Overlapping hulls in a fully wooded cell. §7 says 1-4.
   *
   * Held at 5, one above that, to carry a deliberate 3x tree count. Density had to come from
   * somewhere and the two levers are this and `canopyCellSize`; shrinking the cell instead
   * reached the same count but broke the floor above, which is the more structural of the two
   * rules. Measured, not derived — the count is not linear in either lever, because `wanted`
   * is weighted by forest density and rounded stochastically per cell.
   */
  hullsPerCell: number;
  /** STRUCTURAL. Metres of hull radius before per-instance variation. */
  hullRadius: number;
  /** STRUCTURAL. Metres of hull height before per-instance variation. */
  hullHeight: number;
  /** STRUCTURAL. +/- fraction of size varied per hull. */
  hullJitter: number;
  /** STRUCTURAL. Hard cap on hull instances across the whole tile. */
  canopyMaxHulls: number;

  /* ------------------------------------------------------------------ C leaves */
  /**
   * STRUCTURAL. 2D blades clad onto each crown, baked into the shared crown geometry.
   *
   * THIS IS THE TRIANGLE BUDGET LEVER FOR THE WHOLE TIER. Every crown carries the dome's 42
   * triangles plus two per leaf, and there are up to `canopyMaxHulls` crowns — so at 26000
   * crowns, each leaf added to this number costs 52000 triangles across the tile. 34 leaves
   * takes a crown from 42 triangles to 110 and the tier from 1.1M to 2.9M. They are very small
   * triangles and most of them fade to nothing past `leafFadeEnd`, but the vertex work does
   * not fade — every leaf of every unculled crown is still transformed.
   */
  leavesPerHull: number;
  /** Live. Metres across the short axis of a blade. */
  leafSize: number;
  /** Live. Long:short of a blade. 1 is a disc; a leaf wants 2-3. */
  leafAspect: number;
  /**
   * Live. Metres at which blades start shrinking, and where only the hull is left.
   *
   * The answer to the one half of `05 §215` that survives world-fixed leaves: a blade smaller
   * than a pixel sparkles as it crosses the sampling grid. Past this band the smooth hull
   * carries the crown as the painted mass the doc asks for, and the handover is a size ramp
   * rather than a switch.
   */
  leafFadeStart: number;
  leafFadeEnd: number;
  /**
   * Live. 0 lights every blade by the crown's smooth normal, 1 by the blade's own.
   *
   * The §8.1 lever, kept reachable. At 0 the leaves are a silhouette treatment only and the
   * tier lights exactly as it did before they existed; at 1 each blade answers the sun on its
   * own, which is what they are for.
   */
  leafNormalMix: number;
  /**
   * STRUCTURAL. How far the dome is pulled inside the leaf shell, as a fraction of radius.
   *
   * The dome is still the crown's body — a few dozen blades cover a few percent of a 21 m
   * dome, so without it a crown is a sieve with the hillside showing through. Inset so the
   * blades stand proud of it instead of z-fighting its surface.
   */
  domeInset: number;

  /** Live. 0 = broad top-lit mass, 1 = rounder sun-side split. §8.1, start 0.35-0.75. */
  normalSpread: number;
  /** Live. N·L thresholds for the mid and lit stops. §11 starts at 0.15 / 0.45. */
  splitMid: number;
  splitLit: number;
  /** Live. Lit-dab coverage. §2.3 measured 7.6%, so ~0.08. */
  dabDensity: number;
  /** Live. World metres per dab. §2.4 wants dabs ~0.9-1.0x the mass mark size. */
  dabScale: number;

  /* ------------------------------------------------------ shared suitability rules */
  /** STRUCTURAL. Slope (0-1) above which no cover of any tier is placed. */
  coverMaxSlope: number;
  /** STRUCTURAL. Metres per period of the shared macro moisture field. §3.1. */
  moistureScale: number;
  /** STRUCTURAL. How much moisture biases each mask, 0-1. */
  moistureBias: number;
}

export const ISLAND_COVER: IslandCoverConfig = {
  cliff: 0xcbc5ad,
  cliffStrata: 0x726f60,
  sand: 0xddd0a8,
  grass: 0x8eac71,
  grassDry: 0xc8cdbe,

  dryScale: 62,
  dryCoverage: 0.1,
  drySoftness: 0.16,
  dryDetailScale: 23,
  dryDetailAmount: 0.35,

  sandWidth: 4,
  shoreSandWidth: 9,
  sandSeaward: 120,
  sandSoftness: 11,
  sandEdgeWobble: 7,
  sandEdgeScale: 90,

  cliffSlopeStart: 0.42,
  cliffSoftness: 0.18,
  coastRockNear: 14,
  coastRockFar: 62,
  strataMetres: 7.5,
  strataStrength: 0.55,

  longGrass: 0x1f4e38,
  longGrassOffset: 0.45,
  longGrassScale: 280,
  longGrassCoverage: 0.58,
  longGrassThreshold: 0.36,
  longGrassBreakupScale: 17,
  longGrassSandMargin: 31.5,

  canopyDark: 0x1f4e38,
  canopyMid: 0x366f48,
  canopyLight: 0x749d79,
  forestScale: 420,
  forestCoverage: 0.42,
  forestThreshold: 0.5,
  forestSandMargin: 28,

  canopyCellSize: 50,
  hullsPerCell: 5,
  hullRadius: 21,
  hullHeight: 12,
  hullJitter: 0.4,
  canopyMaxHulls: 26000,

  // 24 blades on a 21 m crown, and the number is set by the BUDGET rather than by taste.
  //
  // A crown costs 42 triangles for its dome plus two per leaf, so this multiplies the whole
  // tier's triangle count by (42 + 2n)/42 — 2.14x at 24, 2.62x at 34, 3.6x at 50. 03 §10.1
  // allows 1.2M island triangles and IslandProbe gates on it, so the headroom here is however
  // much of that the terrain mesh and the existing crowns are not already using. 24 reads as
  // foliage rather than as a dome with confetti on it while roughly doubling the tier; going
  // further is a budget decision that wants the probe's actual figure in front of it.
  leavesPerHull: 24,
  // 5 m across and 2.4 times as long. Not a botanical leaf — at 21 m of crown a real one would
  // be a tenth of a pixel from any height this game is played at. This is the painted-dab
  // scale the rest of the art direction works in: a mark that reads as a leaf, sized to be
  // seen from a seaplane.
  leafSize: 5,
  leafAspect: 2.4,
  // FAR ENOUGH OUT TO ACTUALLY SEE THEM. These first shipped at 260/620 m, which was set by
  // worrying about the sparkle §215 warns of and not by checking where this world is looked at
  // from: the aerial island view sits ~700 m off the hero island and the canopy view ~220 m,
  // so leaves were gone or going in every framing that matters and the tier rendered as the
  // bare domes it had before. The sparkle is a real effect and this may need pulling back in,
  // but it can only be judged on leaves that are on screen in the first place.
  leafFadeStart: 1200,
  leafFadeEnd: 2600,
  leafNormalMix: 1,
  domeInset: 0.9,

  normalSpread: 0.55,
  splitMid: 0.15,
  splitLit: 0.45,
  dabDensity: 0.08,
  dabScale: 34,

  coverMaxSlope: 0.5,
  moistureScale: 900,
  moistureBias: 0.3,
};
