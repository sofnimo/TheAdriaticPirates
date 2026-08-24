/**
 * ONE HAND-AUTHORED ISLAND — Step 3.
 *
 * The README's build order is "one hand-authored island, then swap in the generator", and
 * this is the hand-authored half: a fixed spine and a fixed parameter table, placed by hand
 * rather than sampled from a distribution. `03 — Procedural Islands.md` §2.4 already
 * describes the descriptor a generated island would carry — `{seed, spineControlPoints,
 * length, width, axisAngle}` — so this is that same shape, filled in by hand. Swapping in
 * the generator later means producing these objects from a seed, not rewriting what consumes
 * them.
 *
 * The island is authored around 03's three governing facts, not invented:
 *   1. Anisotropic footprint on the NW-SE Dalmatian trend (§0, §2.1) — a spine, not a blob.
 *   2. Asymmetric cross-section (§3.5) — steep cliffed seaward flank, gentler sheltered one.
 *   3. Karst hydrology (§0.3) — no surface drainage, so no river network is generated.
 */

export interface IslandSpec {
  readonly name: string;
  readonly seed: number;
  /** Spine control points in world XZ metres, ordered along the island's long axis. */
  readonly spine: ReadonlyArray<readonly [number, number]>;
  /** Half-width of the land mask either side of the spine, in metres, before warping. */
  readonly coastHalfWidth: number;
  /** Metres of domain warp applied to the mask. Large enough to break the sausage, small
   *  enough to leave the elongation intact — 03 §2.2. */
  readonly warpStrength: number;
  readonly warpScale: number;
  /** Peak ridge height in metres above sea level. */
  readonly peakHeight: number;
  /** Metres of the ridged multifractal's wavelength along the spine. */
  readonly ridgeScale: number;
  /**
   * Unit XZ vector pointing at the open sea — 03 §3.5's "prevailing exposure". The flank
   * facing this gets the cliffs; the flank away from it gets the gentler terraced profile.
   */
  readonly exposure: readonly [number, number];
  /** Metres between limestone bedding planes, for the strata bands in 03 §3.2. */
  readonly strataSpacing: number;
}

/**
 * PUNTA SEVERA — the Step 3 island.
 *
 * Placed south-west of the placeholder coastline the ocean step used, so the existing cove
 * and shelf camera views look straight at its seaward flank and the shelf transition happens
 * against real land instead of against a stand-in.
 *
 * The spine runs 305 deg (NW-SE), 03 §2.1's global archipelago axis, with the control points
 * nudged off a straight line by hand so the island has a distinct head, a waist, and a
 * trailing tail rather than reading as a symmetrical lozenge. Length ~2.4 km on a ~340 m
 * half-width puts it in the doc's "hero island" class at the small end.
 */
export const PUNTA_SEVERA: IslandSpec = {
  name: 'Punta Severa',
  seed: 20261,
  // 305 deg is (sin, cos) = (-0.819, 0.574); the spine runs along that axis through
  // roughly (150, -560), with hand-placed deviations at the third and fourth points to
  // give a waist and a hooked tail.
  spine: [
    [1080, -1180],
    [640, -880],
    [230, -700],
    [-140, -600],
    [-520, -430],
    [-880, -180],
  ],
  coastHalfWidth: 340,
  // ~150 m of warp on a 340 m half-width: enough that the coast never reads as an offset
  // curve, not so much that the silhouette stops being elongated.
  warpStrength: 150,
  warpScale: 520,
  peakHeight: 260,
  ridgeScale: 900,
  // Open sea lies to the south-east of the spine here, so the exposed flank faces +z.
  exposure: [0.34, 0.94],
  strataSpacing: 14,
};
