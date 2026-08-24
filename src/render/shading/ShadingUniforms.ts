import * as THREE from 'three';
import { HAZE, SKY_GRADIENT, TIME_OF_DAY, type TimeOfDayName } from '../../art/timeOfDay';

/**
 * GLOBAL SHADING UNIFORMS — shared by reference, not by copy.
 *
 * Every gouache material and the sky dome point at these exact `{ value }` objects, so
 * moving the sun or retuning the haze updates the whole world in one assignment. This is
 * the mechanism that keeps sky, haze and terrain shading locked together; if a material
 * ever gets its own private copy of `uSunDirection`, that lock is silently broken.
 */

export interface GlobalUniforms {
  uTime: { value: number };

  // Sky model — read by the dome AND by the haze chunk (via sky_gradient.glsl).
  uSkyZenith: { value: THREE.Color };
  uSkyMid: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uSunDirection: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSunSize: { value: number };

  // Aerial perspective.
  uHazeColorNear: { value: THREE.Color };
  uHazeDensity: { value: number };
  uHazeHeightFalloff: { value: number };
  uHazeStrength: { value: number };
  uSatHoldKnee: { value: THREE.Vector2 };
  uHazeCeiling: { value: number };

  // Time-of-day band tints + optional continuous hemisphere term.
  uLitTint: { value: THREE.Color };
  uFillTint: { value: THREE.Color };
  uHemiGradient: { value: number };
  uHemiSky: { value: THREE.Color };
  uHemiGround: { value: THREE.Color };
}

function makeGlobalUniforms(): GlobalUniforms {
  return {
    uTime: { value: 0 },

    uSkyZenith: { value: new THREE.Color(SKY_GRADIENT.zenith) },
    uSkyMid: { value: new THREE.Color(SKY_GRADIENT.mid) },
    uSkyHorizon: { value: new THREE.Color(SKY_GRADIENT.horizon) },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xfff3dd) },
    uSunSize: { value: SKY_GRADIENT.sunSize },

    uHazeColorNear: { value: new THREE.Color(HAZE.colorNear) },
    uHazeDensity: { value: HAZE.density },
    uHazeHeightFalloff: { value: HAZE.heightFalloff },
    uHazeStrength: { value: HAZE.strength },
    uSatHoldKnee: { value: new THREE.Vector2(...HAZE.satHoldKnee) },
    uHazeCeiling: { value: HAZE.landCeiling },

    uLitTint: { value: new THREE.Color(0xffffff) },
    uFillTint: { value: new THREE.Color(0xffffff) },
    uHemiGradient: { value: 0 },
    uHemiSky: { value: new THREE.Color(0x1ca6c7) },
    uHemiGround: { value: new THREE.Color(0xc8cdbe) },
  };
}

/** The one instance. Import this, never construct another. */
export const globalUniforms: GlobalUniforms = makeGlobalUniforms();

/**
 * Push a time-of-day preset into the shared uniforms. Does not touch the light objects —
 * SunRig owns those and calls this, so direction and colour can never disagree.
 */
export function applyTimeOfDayUniforms(name: TimeOfDayName): void {
  const preset = TIME_OF_DAY[name];
  globalUniforms.uSunColor.value.set(preset.sun.color);
  globalUniforms.uLitTint.value.set(preset.litTint);
  globalUniforms.uFillTint.value.set(preset.fillTint);
  globalUniforms.uHemiSky.value.set(preset.hemi.sky);
  globalUniforms.uHemiGround.value.set(preset.hemi.ground);
}

/** Sun direction from elevation/azimuth in degrees. Unit vector, surface -> sun. */
export function sunDirectionFrom(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ).normalize();
}
