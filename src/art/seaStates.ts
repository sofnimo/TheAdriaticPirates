/**
 * GERSTNER WAVE STACKS — `02 — Water.md` §1.3, transcribed.
 *
 * Four waves, not the dozens an FFT ocean would use. That is a deliberate downgrade from
 * "physically complete" to "reads correctly from a plane": at 200-1500 m the wave
 * silhouette is sub-pixel, so wave 1 carries the silhouette and waves 3-4 exist only to
 * perturb the normal enough to place glints.
 *
 * Directions are degrees clockwise from north; wavelengths and amplitudes in metres.
 * DATA ONLY — no three.js import.
 */

export interface GerstnerWave {
  readonly amplitude: number;
  readonly wavelength: number;
  readonly directionDeg: number;
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
  calm: Object.freeze<SeaState>({
    label: 'Calm (harbour mornings)',
    waves: [wave(0.06, 40, 200, 0.35), wave(0.03, 22, 235, 0.3), wave(0.015, 9, 170, 0.25), wave(0.008, 4, 260, 0.2)],
    glintCoverage: 0.03,
    note: 'The art bible negative-space shots. Sheltered coves read as almost glass.',
  }),

  breeze: Object.freeze<SeaState>({
    label: 'Breeze (patrol / cruise)',
    waves: [wave(0.35, 70, 210, 0.55), wave(0.18, 38, 240, 0.5), wave(0.08, 16, 190, 0.4), wave(0.04, 7, 260, 0.3)],
    glintCoverage: 0.16,
    note: 'Default. Density from image-4.jpg: 13.1% light + 3.0% dark marks over near, lively, sunlit open water.',
  }),

  bora: Object.freeze<SeaState>({
    label: 'Bora wind (storm set-piece)',
    waves: [wave(1.1, 120, 20, 0.75), wave(0.55, 65, 40, 0.65), wave(0.25, 28, 5, 0.55), wave(0.12, 12, 55, 0.45)],
    glintCoverage: 0.22,
    note: 'Heavy whitecap dashing; sea reads mid-blue rather than deep.',
  }),
});

export type SeaStateName = keyof typeof SEA_STATES;
export const SEA_STATE_NAMES = Object.freeze(Object.keys(SEA_STATES) as SeaStateName[]);
export const DEFAULT_SEA_STATE: SeaStateName = 'breeze';

/** Direction in degrees clockwise from north -> unit XZ vector. */
export function waveDirection(directionDeg: number): [number, number] {
  const r = (directionDeg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

/** Dominant swell axis (wave 1) — glints stretch along this. */
export function swellDirection(state: SeaState): [number, number] {
  return waveDirection(state.waves[0].directionDeg);
}
