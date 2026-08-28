import { LAND, SKY } from './palette';

/**
 * TIME-OF-DAY PRESETS — `04 — Light and Shadow.md` §1.1, transcribed.
 *
 * Intensities are a painter's exposure knob, not photometric units (04 §1): they are
 * tuned by eye against the sRGB palette, because tone mapping is off by contract.
 *
 * `litTint` / `fillTint` are this implementation's addition, not from the table. They
 * carry the sun-warmth and sky-fill colour as a *tint on the flat bands* rather than as
 * a smooth per-fragment gradient, which would destroy the flat-band read that rule 1
 * exists to produce. Late morning — the calibration reference — is identity on both, so
 * at the default preset a lit band renders the authored palette hex exactly.
 *
 * DATA ONLY — no three.js import.
 */

export interface TimeOfDayPreset {
  readonly label: string;
  readonly sun: {
    readonly color: number;
    readonly intensity: number;
    readonly elevationDeg: number;
    readonly azimuthDeg: number;
    readonly castShadow: boolean;
  };
  readonly hemi: {
    readonly sky: number;
    readonly ground: number;
    readonly intensity: number;
  };
  /** Multiplier on the lit band. Identity at the calibration preset. */
  readonly litTint: number;
  /** Multiplier on the shadow band — where the sky-bounce fill actually shows. */
  readonly fillTint: number;
  readonly note?: string;
}

const preset = (p: TimeOfDayPreset): TimeOfDayPreset => Object.freeze(p);

export const TIME_OF_DAY = Object.freeze({
  earlyMorning: preset({
    label: 'Early morning',
    sun: { color: 0xffe0b0, intensity: 1.6, elevationDeg: 12, azimuthDeg: 95, castShadow: true },
    hemi: { sky: SKY.cloudShadow.hex, ground: LAND.pastureDry.hex, intensity: 0.55 },
    litTint: 0xfff0dc,
    fillTint: 0xd8dcea,
    note: 'Long hard shadows; sea shadow shifts further violet; thick haze band.',
  }),

  lateMorning: preset({
    label: 'Late morning (DEFAULT)',
    sun: { color: 0xfff3dd, intensity: 2.0, elevationDeg: 50, azimuthDeg: 135, castShadow: true },
    hemi: { sky: SKY.zenith.hex, ground: LAND.pastureBleached.hex, intensity: 0.65 },
    litTint: 0xffffff, // identity — this preset IS the calibration reference
    fillTint: 0xffffff,
    note: 'The reference-frame condition. Shadows short, hard, near-vertical.',
  }),

  goldenHour: preset({
    label: 'Golden hour',
    sun: { color: 0xffb15e, intensity: 1.75, elevationDeg: 16, azimuthDeg: 100, castShadow: true },
    hemi: { sky: SKY.horizonHazeFar.hex, ground: 0x8a6a52, intensity: 0.5 },
    litTint: 0xffe2bd,
    fillTint: 0xd6c9df,
    note: 'Rim term becomes the dominant read; sun disc bloom widens.',
  }),

  dusk: preset({
    label: 'Dusk',
    sun: { color: 0x8f7fc0, intensity: 1.1, elevationDeg: 3, azimuthDeg: 285, castShadow: true },
    hemi: { sky: 0x5f6fa8, ground: LAND.limestoneShadowDeep.hex, intensity: 0.75 },
    litTint: 0xd9cfe8,
    fillTint: 0xa9b0d0,
    note: 'The one preset where fill does more storytelling than the sun. Never true black.',
  }),

  overcastBora: preset({
    label: 'Overcast bora',
    sun: { color: 0xcfd8dc, intensity: 0.9, elevationDeg: 40, azimuthDeg: 135, castShadow: false },
    hemi: { sky: SKY.cloudShadowAlt.hex, ground: LAND.limestoneStrata.hex, intensity: 1.1 },
    litTint: 0xe8eeee,
    fillTint: 0xdfe6e2,
    note: 'Flat stepped bands with no cast shadow; fill carries the scene.',
  }),
});

export type TimeOfDayName = keyof typeof TIME_OF_DAY;

export const TIME_OF_DAY_NAMES = Object.freeze(Object.keys(TIME_OF_DAY) as TimeOfDayName[]);

export const DEFAULT_TIME_OF_DAY: TimeOfDayName = 'lateMorning';

/** Sky gradient colours. One source for the dome and for the haze the world fades into. */
export const SKY_GRADIENT = Object.freeze({
  zenith: SKY.zenith.hex,
  mid: SKY.mid.hex,
  horizon: SKY.horizonHazeFar.hex,
  /** ~1 deg disc radius (01 §7.1). */
  sunSize: 0.99985,
});

/** Aerial perspective, 04 §5.3. Tight island-hopping budget is the default. */
export const HAZE = Object.freeze({
  colorNear: SKY.horizonHaze.hex, // #b1cbd3
  /** ~3 km view budget: "shift to cyan within ~3km", literally. */
  density: 0.00035,
  heightFalloff: 0.0012,
  /**
   * Global multiplier on the whole aerial-perspective term, 0 = no haze at all.
   *
   * Separate from `density`, which sets how fast haze accumulates with distance. This scales
   * the result, so it thins the atmosphere everywhere at once without moving the range at
   * which the shift toward cyan happens.
   */
  strength: 0.42,
  /**
   * Haze fraction over which a saturation-holding surface (the sea) hands its saturation
   * back to the atmosphere. Late onset, sharp knee — 00 §3 rule 5's land curve is unchanged
   * and never uses this. See aerial_perspective.glsl for the pixel-row measurement.
   */
  satHoldKnee: [0.62, 0.92] as const,
  /**
   * Haze ceiling for opaque land. Distant land in the frames desaturates to s=0.06-0.15 but
   * keeps a value 0.06-0.41 below the sky behind it — it never fully converges, which is what
   * keeps the silhouette readable at range. See aerial_perspective.glsl for the measurements.
   */
  landCeiling: 0.62,
});
