/**
 * GERSTNER WAVE STACKS — `02 — Water.md` §1.3, transcribed.
 *
 * Four waves, not the dozens an FFT ocean would use. That is a deliberate downgrade from
 * "physically complete" to "reads correctly from a plane": at 200-1500 m the wave
 * silhouette is sub-pixel, so wave 1 carries the silhouette and the rest exist to give the
 * normal enough variation to place glints.
 *
 * THE LONGEST WAVE MUST DOMINATE THE NORMAL. This is the rule the three states below are
 * built around, and it is arithmetic rather than taste. What the eye reads as surface
 * roughness is the normal's tilt, and for a Gerstner wave that tilt is `2*pi*A / wavelength`
 * — a RATIO, not an amplitude. The previous stacks were tuned by amplitude alone and got the
 * ratio backwards: the breeze state's 7 m ripple tilted the normal by 0.036 while its 70 m
 * swell managed only 0.031, so the fine chop was the loudest thing on the water and the swell
 * underneath it was nearly invisible. Every state here keeps the shortest component's ratio
 * well below the longest's, and nothing is shorter than about 35 m.
 *
 * SHARPNESS IS STEEPNESS, NOT WAVELENGTH. Peaked crests come from the Gerstner Q term, which
 * pinches a wave toward its crest without adding any new frequency. That is why `choppy`
 * below is sharp without being rippled: it reaches its character through Q, where the obvious
 * approach — shortening the waves — would just put the fine chop back.
 *
 * Directions are degrees clockwise from north; wavelengths and amplitudes in metres.
 * DATA ONLY — no three.js import.
 */

export interface GerstnerWave {
  readonly amplitude: number;
  readonly wavelength: number;
  readonly directionDeg: number;
  /**
   * Artist Q, 0-1. How far the crest is pinched toward a peak.
   *
   * The stack's Q values are also bounded as a SUM: the analytic normal accumulates `Q/4` per
   * wave into the vertical term, so a stack summing past 4 can drive it negative and turn the
   * surface inside out. Keeping the total near 2.5 or below leaves headroom.
   */
  readonly steepness: number;
}

export interface SeaState {
  readonly label: string;
  readonly waves: readonly [GerstnerWave, GerstnerWave, GerstnerWave, GerstnerWave];
  /**
   * Fraction of open-water pixels carrying a discrete mark, LIGHT AND DARK COMBINED.
   *
   * This is a per-sea-state density, not one global target. The frames disagree by an order
   * of magnitude and it is the water that differs, not the measurement: image-4.jpg's near,
   * lively, sunlit open sea runs 16.1% (13.1 light + 3.0 dark), the harbour 5.6%, mid-altitude
   * open sea 1.6%, and both cove frames sit at zero across the whole turquoise shelf. Shelter
   * and distance take it back down from here; see GLINT_RULE.depthFade.
   */
  readonly glintCoverage: number;
  readonly note?: string;
}

const wave = (amplitude: number, wavelength: number, directionDeg: number, steepness: number): GerstnerWave =>
  Object.freeze({ amplitude, wavelength, directionDeg, steepness });

export const SEA_STATES = Object.freeze({
  flat: Object.freeze<SeaState>({
    label: 'Flat water',
    waves: [
      wave(0.05, 150, 200, 0.10),
      wave(0.03, 105, 235, 0.08),
      wave(0.02, 74, 170, 0.06),
      wave(0.012, 50, 260, 0.05),
    ],
    glintCoverage: 0.02,
    note: 'Barely moving. Tilt ratio 0.002 — a long, slow breathing of the surface with no ' +
      'texture on it at all. The art bible negative-space shots; sheltered coves read as glass.',
  }),

  wavey: Object.freeze<SeaState>({
    label: 'Wavey',
    waves: [
      wave(0.80, 170, 210, 0.30),
      wave(0.42, 118, 240, 0.26),
      wave(0.20, 80, 190, 0.20),
      wave(0.10, 55, 260, 0.16),
    ],
    glintCoverage: 0.16,
    note: 'Default. Long rolling swell: 170 m between crests carrying 0.8 m of rise, and low Q ' +
      'so the crests stay rounded. Every component is a smooth roll — the shortest is still 55 m.',
  }),

  choppy: Object.freeze<SeaState>({
    label: 'Choppy',
    waves: [
      wave(1.35, 108, 20, 0.72),
      wave(0.72, 74, 40, 0.62),
      wave(0.36, 51, 5, 0.52),
      wave(0.18, 35, 55, 0.42),
    ],
    glintCoverage: 0.22,
    note: 'Taller than wavey and peaked with it. The sharpness is Q, not wavelength: crests ' +
      'pinch up while the water stays free of fine chop. Heavy whitecap dashing.',
  }),
});

export type SeaStateName = keyof typeof SEA_STATES;
export const SEA_STATE_NAMES = Object.freeze(Object.keys(SEA_STATES) as SeaStateName[]);
export const DEFAULT_SEA_STATE: SeaStateName = 'wavey';

/**
 * Display label -> key, for the debug UI's dropdown.
 *
 * lil-gui shows the KEYS of an object like this and assigns the values, so the menu reads
 * "Flat water" while the code keeps working in `SeaStateName`.
 */
export const SEA_STATE_OPTIONS: Readonly<Record<string, SeaStateName>> = Object.freeze(
  Object.fromEntries(
    SEA_STATE_NAMES.map((name) => [SEA_STATES[name].label, name]),
  ) as Record<string, SeaStateName>,
);

/** Direction in degrees clockwise from north -> unit XZ vector. */
export function waveDirection(directionDeg: number): [number, number] {
  const r = (directionDeg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

/**
 * Dominant swell AXIS (wave 1) — glints stretch along this.
 *
 * An axis, not an arrow. Glints are stretched along the swell and do not care which way it is
 * running, so this was never wrong for its original caller and its sign was never pinned down.
 * Anything that needs the arrow must use `swellTravelDirection` below.
 */
export function swellDirection(state: SeaState): [number, number] {
  return waveDirection(state.waves[0].directionDeg);
}

/**
 * The direction the swell actually TRAVELS — the opposite of `waveDirection`.
 *
 * The minus sign is not a fudge, it falls out of the phase convention in `gerstner.glsl`:
 *
 *     phase = k * dot(d, worldXZ) + omega * uWaveTime
 *
 * A crest is a line of constant phase, so as time advances `dot(d, worldXZ)` must DECREASE to
 * hold it — the crest moves along -d. The `+omega*t` makes `d` the bearing the swell comes
 * FROM, which is also how a sailor would name a wind, so nothing in the data was mislabelled.
 *
 * It cost a mirrored world to notice. The fetch field marched its ray along `swellDirection`
 * assuming that was the way the waves were going, so every island sheltered its windward face
 * and left its lee exposed, and the foam — gated on that same field — broke on the calm side.
 * Both were consistent, both were backwards, and consistency is exactly what makes this class
 * of error survive: nothing disagrees with anything, the whole picture is just flipped.
 */
export function swellTravelDirection(state: SeaState): [number, number] {
  const [x, z] = waveDirection(state.waves[0].directionDeg);
  return [-x, -z];
}
