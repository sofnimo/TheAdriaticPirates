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
    // The surf zone. 100 m offshore, per the brief; the atlas must be baked wide enough to
    // represent it, which is why ShoreAtlas is constructed with a larger maxShoreDistance.
    uFoamReach: { value: 100 },
    // Crest phase foam starts at, on the -1..1 wave. 0.45 puts it on the top quarter of the
    // wave rather than over the whole upper half, which is what reads as "the tips".
    uFoamCrest: { value: 0.45 },
    uFoamCrestSoft: { value: 0.18 },
    // Where the two readings hand over. Inside 180 m the foam rides the crests; past 600 m it
    // is a steady band. It blends between, so flying in never shows a switch.
    uFoamCrestNear: { value: 180 },
    uFoamCrestFar: { value: 600 },
    // Fetch below which a coast does not foam at all, and it is set high on purpose. The lee
    // is glassy, not lightly flecked, so this asks for a coast the swell plainly reaches
    // rather than one it merely wraps a little energy around.
    uFoamExposure: { value: 0.6 },
    uRunupSpeed: { value: 0.62 },
    uRunupFreq: { value: 0.12 },
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
