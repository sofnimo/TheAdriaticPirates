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

  normalSpread: 0.55,
  splitMid: 0.15,
  splitLit: 0.45,
  dabDensity: 0.08,
  dabScale: 34,

  coverMaxSlope: 0.5,
  moistureScale: 900,
  moistureBias: 0.3,
};
