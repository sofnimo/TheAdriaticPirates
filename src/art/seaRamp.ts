/**
 * SEA DEPTH RAMP + GLINT RULE — sampled, not remembered.
 *
 * Every hex below was read out of a reference frame with a pixel sampler, and carries the
 * source filename and image coordinate so it can be re-checked. Nothing here is recalled
 * from `00 — Art Direction Bible.md`; where the two disagree, see NOTE ON 00 at the bottom.
 *
 * WHY A CONTINUOUS RAMP AND NOT BANDS
 * -----------------------------------
 * Measured across the reference frames, sea depth colour never plateaus where depth varies.
 * On the cove frame's water column (image-3.jpg x=500, y=268..402) the colour moves on
 * essentially every row: mean per-row change 1.2/255, max 2.8/255, and the longest run of
 * near-identical rows is 6 px out of 133. A five-band quantiser produces flat plateaus tens
 * of pixels deep separated by 0 px cliffs, which is the opposite signal.
 *
 * Open sea DOES read as a flat colour field (plane-skimming x=300, y=380..560 holds #025581
 * to within 1/255 over 180 px) — but that is flat because the depth is flat out there, not
 * because the colour is quantised. A continuous ramp reproduces both behaviours for free.
 *
 * This is the base-colour mapping only. The stepped gouache lit/shadow ramp is unchanged and
 * still applies on top: colour is continuous, light response is banded.
 */

export interface RampStop {
  /** Depth parameter, 0 = waterline, 1 = abyssal. Matches DepthField's SHELF_PROFILE output. */
  readonly t: number;
  readonly hex: number;
  /** Source frame and pixel, so any stop can be re-measured. */
  readonly source: string;
}

/**
 * THE RAMP. Deep -> shallow reads bottom-to-top.
 *
 * The coastal half (t <= 0.74) comes from image-3.jpg, the frame 00 §2 calls the most
 * important colour event in the game. Those stops are not single pixels: the frame's water
 * region was surveyed on an 8 px grid (~1700 cells), cells binned by HSL lightness, and the
 * per-bin median taken — so JPEG noise, the moored aircraft and the rocks do not move them.
 * The single-column transect at x=500 agrees with the binned medians to within ~3/255.
 *
 * The open-sea half (t >= 0.82) comes from the high-altitude frames, which bottom out darker
 * and bluer than any cove frame reaches.
 *
 * The through-line the sampler found, and the thing the old 5-band version destroyed: depth
 * is a COORDINATED sweep of all three HSL axes, not a lightness ramp with a fixed hue.
 * Hue rotates 132 deg -> 209 deg (green -> cyan -> blue), saturation climbs 0.15 -> 1.00,
 * lightness falls 0.70 -> 0.11, all monotonically.
 */
export const SEA_RAMP: readonly RampStop[] = [
  { t: 0.0, hex: 0xa2baa7, source: 'image-3.jpg, water at HSL l=0.70 (n=25) — waterline over bright sand' },
  { t: 0.05, hex: 0x95b5a3, source: 'image-3.jpg, water at HSL l=0.65 (n=60)' },
  { t: 0.1, hex: 0x87af9e, source: 'image-3.jpg, water at HSL l=0.60 (n=54)' },
  { t: 0.15, hex: 0x74a69a, source: 'image-3.jpg, water at HSL l=0.55 (n=55)' },
  { t: 0.2, hex: 0x629d96, source: 'image-3.jpg, water at HSL l=0.50 (n=86)' },
  { t: 0.26, hex: 0x519491, source: 'image-3.jpg, water at HSL l=0.45 (n=101)' },
  { t: 0.32, hex: 0x40898c, source: 'image-3.jpg, water at HSL l=0.40 (n=137)' },
  { t: 0.39, hex: 0x2d7f85, source: 'image-3.jpg, water at HSL l=0.35 (n=147)' },
  { t: 0.47, hex: 0x177580, source: 'image-3.jpg, water at HSL l=0.30 (n=189) — the turquoise shelf' },
  { t: 0.56, hex: 0x0a6776, source: 'image-3.jpg, water at HSL l=0.25 (n=265) — peak saturation, s=0.85' },
  { t: 0.66, hex: 0x064e5d, source: 'image-3.jpg, water at HSL l=0.20 (n=252)' },
  { t: 0.74, hex: 0x05434f, source: 'image-3.jpg, water at HSL l=0.15 (n=83) — near-black teal, cove floor' },
  { t: 0.82, hex: 0x003e57, source: 'peninsula-coastline-aerial-clouds (150,470) — deep coastal shelf' },
  { t: 0.9, hex: 0x072a46, source: 'island-harbor-ships-gathering-aerial (355,360) — open sea past the shelf' },
  { t: 0.96, hex: 0x022a4c, source: 'plane-over-archipelago-wide (300,300) — deep, mid-field' },
  { t: 1.0, hex: 0x001e3a, source: 'plane-over-archipelago-wide (300,385) — deepest foreground' },
];

/**
 * ALTERNATE SHALLOW BRANCH — recorded, deliberately NOT wired up.
 *
 * karst-sinkhole-cave-turquoise.jpg.jpg is the same cove as image-3 from a different shot,
 * and its shallow water diverges sharply: at equal lightness it is ~30 deg bluer and roughly
 * twice as saturated (l=0.63 gives #6bc3d8 h=192 s=0.58 there, against image-3's h=157
 * s=0.20). Both are real. The difference is what is UNDER the water — image-3 shelves onto
 * bright sand that shows through and drags the colour toward pale desaturated green, while
 * the karst pool has steep walls and no visible bottom, so the water keeps its own colour.
 *
 * Which branch is correct is therefore a seabed-albedo question, and there is no seabed
 * albedo until islands land in Step 3. Until then the ramp above ships image-3's branch,
 * because image-3 is the binding frame. These stops are here so the choice is one edit, and
 * so the disagreement is on the record rather than silently averaged away.
 */
export const SEA_RAMP_NO_SAND: readonly RampStop[] = [
  { t: 0.0, hex: 0xd2faed, source: 'karst (250,800) — waterline' },
  { t: 0.12, hex: 0x92ddcd, source: 'karst (250,824)' },
  { t: 0.24, hex: 0x6bc3d8, source: 'karst (250,848) — electric turquoise' },
  { t: 0.36, hex: 0x53abc8, source: 'karst (250,873)' },
  { t: 0.48, hex: 0x4997ad, source: 'karst (250,897)' },
  { t: 0.6, hex: 0x40889e, source: 'karst (250,921) — pool floor, deepest visible' },
];

/**
 * GLINT / HIGHLIGHT RULE — two populations, sampled.
 *
 * PRIMARY SOURCE: image-4.jpg, a near, lively, sunlit stretch of open sea. Measured in a
 * 479x571 px region clear of the wake and both aircraft. It is the densest and most
 * informative glint frame in the set, and the figures below are its.
 *
 * RE-MEASURED LOCALLY. The frame is now in Visual References/ and every figure below has been
 * checked against it rather than taken on trust. Base water in the left open-water strip reads
 * #02557c (h=199, s=0.97, l=0.25) against the stated #025277 (h=199, s=0.97, l=0.24) — the same
 * water. Light marks in a clean 351x671 px region measure aspect 7.2 median / 12.9 p90 against
 * the stated 6.9 / 10.3, colour s=0.32 exactly as stated, and an axial resultant of R=1.00 at
 * 180 deg for every elongated mark. Dark marks measure 3.57% coverage against 3.0%, hue 206 and
 * lightness 0.15 against 206 and 0.16.
 *
 * ONE DISAGREEMENT, and it is left implemented the stated way. Dark-mark SATURATION measures
 * 0.95-0.98 here, not 0.51: at a detection threshold that isolates the strongest marks the
 * median comes out #012c4d, whose hue and lightness match the stated #142c3e to a point but
 * whose saturation does not. #142c3e is a greyed navy; #012c4d is a darker blue in the water's
 * own family, which is what the marks look like in the frame. `dark.saturationScale` ships at
 * the stated 0.53; 1.0 is the one-line change if the local reading is preferred.
 *
 * TWO POPULATIONS, NOT ONE. Marks go both lighter AND darker than the water, roughly 4:1:
 *
 *   base water   #025277   h=199  s=0.97  l=0.24
 *   light marks  #548da2   h=196  s=0.32  l=0.48    dH -3   S x0.33   L +0.24
 *   dark marks   #142c3e   h=206  s=0.51  l=0.16    dH +7   S x0.53   L -0.08
 *
 * The derive-from-water rule holds for both — hue near-invariant within +/-7 deg, saturation
 * dropping hard in each direction — but the lightness term is SIGNED. Dark marks are ~3% of
 * pixels on their own; without them the surface reads as flat colour with highlights printed
 * on it rather than as a lit, textured surface.
 *
 * CROSS-CHECK, measured locally on the frames that are present. Light-mark parameters vary
 * by frame, and the variation looks like sea state rather than noise:
 *   seaplane-takeoff-spray-harbor, n=58:  water #213777 -> #5f71a0   S x0.45  L +0.183
 *   plane-skimming-sea-foam-portrait, n=6: water #035685 -> #3887ae   S x0.55  L +0.187
 * Both are calmer water than image-4 and both give a weaker, less desaturated lift. The
 * shipped values are image-4's; the spread is recorded so a sea-state-driven version of these
 * constants has somewhere to start.
 */
export const GLINT_RULE = {
  light: {
    /** HSL saturation multiplier applied to the local water colour. */
    saturationScale: 0.33,
    /** HSL lightness added. Signed: this population goes lighter. */
    lightnessLift: 0.24,
    /**
     * Spread on the lift. The references do not have one mark brightness — in the harbour
     * frame the median mark is l=0.50 while the brightest reach l=0.68 — and without a spread
     * the field reads as printed rather than caught.
     */
    lightnessLiftVariation: 0.18,
    /** Median long:short axis, and the 90th percentile. image-4 light marks. */
    aspect: 6.9,
    p90Aspect: 10.3,
  },
  dark: {
    saturationScale: 0.53,
    /** Signed the other way: this population goes DARKER than the water. */
    lightnessLift: -0.08,
    lightnessLiftVariation: 0.06,
    /** Dark marks run longer than light ones. image-4 dark marks. */
    aspect: 8.5,
    p90Aspect: 11.5,
  },
  /** Share of marks drawn from the dark population. image-4 measures roughly 4:1 light:dark. */
  darkFraction: 0.2,
  /**
   * Screen-to-world aspect correction. THE ASPECT FIGURES ABOVE ARE SCREEN MEASUREMENTS.
   *
   * image-4.jpg is a low pass, so its marks are foreshortened: the short axis runs into the
   * screen and compresses, inflating the measured ratio above the mark's actual shape on the
   * water. Rendering a world-space 6.9:1 mark and measuring it back on a comparably framed
   * low pass gives 12.2:1, so the two cannot both be 6.9 — matching screen-to-screen at
   * comparable framing is the same principle the coverage figure is matched under.
   *
   * 6.9 / 12.2 = 0.57. Applied to the authored aspect it puts the rendered skim view back on
   * image-4's screen figure, which implies a world shape nearer 3.9:1.
   *
   * THE ASSUMPTION BEHIND IT NOW HAS EVIDENCE. This factor assumed the render's skim pitch
   * matched image-4's, which could not be checked while the frame was missing. It can now.
   * Marks in image-4 run 85.9 px near and 25.7 px far, a 3.3x size ratio; since apparent size
   * goes as 1/distance, the far band sits 3.3x further away, and sin(60 deg)/sin(15 deg) = 3.34
   * puts the frame between roughly 15 and 60 deg below horizontal — a mid-frame view angle near
   * 37 deg. The render's probe region spans 27-48 deg below horizontal, mid-frame 37 deg. The
   * same angle, so the same foreshortening: 1/sin(37 deg) = 1.66 against the 1.77 measured
   * directly off the render. The factor stands, and now for a stated reason rather than a hope.
   */
  screenToWorldAspect: 0.57,
  /**
   * Ceiling on the lifted lightness, for the light population only. Every mark measured sat
   * on dark water, so an unbounded lift turns pale shallow water into near-white confetti.
   * The brightest mark found anywhere is #91a2cc at l=0.68.
   */
  maxLightness: 0.7,
  /**
   * depth01 range over which sparkle fades in. Both cove frames are glassy across the whole
   * turquoise shelf — no discrete marks at all — while the harbour and open-sea frames are
   * full of them. Depth is the stand-in for shelter until Step 4 brings a fetch/wind field.
   *
   * Set so marks only reach full strength in genuinely open water (0.75 is ~160 m from
   * shore). Every frame that shows sparkle shows it over dark water.
   */
  depthFade: [0.5, 0.75] as const,
} as const;

/**
 * GLINT SHAPE — the envelope the gate checks against.
 *
 * Coverage is per sea state (see seaStates.ts), not one global target: the frames run from 0%
 * on a sheltered cove to 16.1% on image-4's lively open water, and that is the water
 * differing, not the measurement.
 *
 * Alignment was the one thing the motion-streak frame did NOT get wrong. Measured locally,
 * the ambient frames come in at R=0.98 and R=1.00 on axial resultant length, against R=0.84
 * for the speed-line frame — sparkle is MORE globally aligned, not less, because wave crests
 * in one sea state are parallel. image-4 agrees: 96.7% of its marks are wider than tall on
 * one near-horizontal axis. A single swell axis is correct.
 */
export const GLINT_SHAPE = {
  /** Full envelope across every frame with discrete marks, sheltered water excluded. */
  coverageRange: [0.015, 0.17] as const,
  /** Axial resultant length to hold: alignment is a target, not a defect. */
  minAxialR: 0.9,
  /**
   * Combined-population aspect the gate expects, ON THE PROBE'S RUN-LENGTH SCALE.
   *
   * The probe measures elongation as mean run length along the swell over mean run length
   * across it, which is cheap and framing-robust but reads systematically LOW against the
   * connected-component PCA the reference figures come from: on the same rendered frame the
   * proxy says 4.3:1 where PCA says 6.6:1, a factor of ~0.65. Comparing the proxy's number
   * directly against image-4's PCA figure would fail a field that is actually correct.
   *
   * So the window is the PCA target [5.0, 11.5] scaled onto the proxy. The PCA cross-check is
   * the real comparison and lives in the README: 6.6 median / 10.9 p90 rendered against
   * image-4's 6.9 / 10.3.
   */
  aspectRange: [3.2, 7.6] as const,
} as const;

/**
 * NOTE ON `00 — Art Direction Bible.md`
 *
 * The sampled ramp AGREES with 00's authored sea hexes through the middle of the range:
 *   turquoiseShelf #14707c vs sampled #177580 at t=0.47   (h 187/186, s 0.72/0.69)
 *   lagoonEdge     #074d5c vs sampled #064e5d at t=0.66   (h 192/190, s 0.86/0.88)
 *   shallowSandLit #498e8e vs sampled #40898c at t=0.32   (h 180/182, s 0.32/0.37)
 *
 * It DISAGREES at both ends, and the ends are where the disagreement is informative:
 *   - shallowSandLitHigh #62afb4 (h=184) vs sampled #74a69a (h=166) at equal lightness.
 *     00's shallow hexes sit on the no-sand branch above; image-3's sit on the sand branch.
 *   - abyssal #0c3273 (l=0.25, h=218) vs sampled #001e3a (l=0.11, h=209). 00's abyssal is
 *     much lighter than the deepest water in any sampled frame. It is close to
 *     plane-banking-over-sea-island-bg (270,285) #033b85, a MID-altitude open sea reading —
 *     which suggests 00's hex was taken before aerial perspective was factored out.
 *
 * `palette.ts` is untouched. This is a separate, additive table; 00's hexes still drive
 * everything else. Flagging rather than reconciling, because which one is right at the
 * shallow end is a seabed-albedo decision that Step 3 makes.
 */
