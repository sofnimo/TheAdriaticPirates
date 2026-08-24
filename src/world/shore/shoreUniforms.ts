import * as THREE from 'three';
import { LAND, SEA } from '../../art/palette';
import type { ShoreAtlas } from './ShoreAtlas';

/**
 * The shoreline uniform block, built once and SHARED by the water and the terrain.
 *
 * Both materials read the same atlas and the same run-up phase — the water to draw foam on the
 * seaward side, the terrain to darken wet sand on the landward side. They have to agree about
 * where the wave is right now, or the damp band and the foam that made it will visibly drift
 * apart. Sharing one set of uniform objects is the cheapest way to make that impossible.
 *
 * Defaults are `02b — Coastal Waves.md` §8.5's authoring table.
 */
export interface ShoreUniforms {
  [key: string]: THREE.IUniform;
}

export function makeShoreUniforms(atlas: ShoreAtlas): ShoreUniforms {
  return {
    uShoreAtlas: { value: atlas.texture },
    uShoreOrigin: { value: new THREE.Vector2(atlas.originX, atlas.originZ) },
    uShoreWorldSize: { value: atlas.worldSize },
    uMaxShoreDist: { value: atlas.maxShoreDistance },
    uRingWidth: { value: 1.3 },
    uRunupReach: { value: 12 },
    uRunupSpeed: { value: 0.62 },
    uRunupFreq: { value: 0.12 },
    uRunupCycles: { value: 1.6 },
    uFoamSteps: { value: 3 },
    uFoamDetailLOD: { value: 1 },
    cFoam: { value: new THREE.Color(SEA.crestHigh.hex) },
    cFoamShadow: { value: new THREE.Color(0xb1cbd3) },
    cWetSand: { value: new THREE.Color(LAND.sandWet.hex) },
    uWetSandBand: { value: 18 },
    // Negative control for the quantiser; 0 everywhere except `?foam=smooth`.
    uFoamSmoothSabotage: { value: 0 },
    uShoreDebug: { value: 0 },
    uFoamEnable: { value: 1 },
  };
}

/**
 * 02b §2.4: collapse the animated run-up to nothing past ~600 m and keep only the static ring,
 * because a metre-scale animated band under a high camera is sub-pixel and crawls.
 *
 * Computed CPU-side per frame from the camera, as the doc specifies — this is one uniform
 * write, where doing it per pixel would be a per-fragment distance-to-coast query.
 */
export function updateFoamLOD(uniforms: ShoreUniforms, cameraY: number): void {
  const t = Math.max(0, Math.min(1, (600 - cameraY) / (600 - 150)));
  uniforms.uFoamDetailLOD!.value = t * t * (3 - 2 * t);
}
