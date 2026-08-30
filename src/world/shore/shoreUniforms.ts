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
    // THE ARRIVING WAVE, shared by the foam and the wet sand.
    //
    // These are wave 1 of the sea state — its travel direction, wave number and angular
    // frequency — pushed in by `syncShoreSwell` whenever the swell changes. They exist so that
    // both sides of the waterline can evaluate the SAME phase at the same world point: the
    // water uses it to run the surf up and back down the beach, the land uses it to darken the
    // sand the wave just covered.
    //
    // Before this the run-up was a free sine of its own (`uRunupSpeed`, `uRunupFreq`) with no
    // relation to the waves on screen. The block's own header promised the opposite — "both
    // materials read the same run-up phase ... or the damp band and the foam that made it will
    // visibly drift apart" — and drift apart is exactly what they did, because nothing tied
    // either of them to the swell. A wave could roll in while the foam was retreating.
    uSwashDir: { value: new THREE.Vector2(0, 1) },
    uSwashK: { value: 0.037 },
    uSwashOmega: { value: 0.6 },
    /** Metres the waterline travels up and back down the beach over one wave. */
    uSwashReach: { value: 9 },
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
 * Point the shore's swash at the swell that is actually running.
 *
 * Called whenever the sea state or the wave heading changes, from the same place that sets the
 * ocean's own wave stack — so the surf on the beach and the waves arriving at it are the same
 * wave, described once. `k` and `omega` are the deep-water relation the wave stack already
 * uses, `omega = sqrt(g*k)` with `k = 2*pi/L`; `dir` is the direction the crests TRAVEL, which
 * is the opposite of the authored bearing (see `swellTravelDirection` in art/seaStates.ts, and
 * the mirrored-world bug it documents).
 */
export function syncShoreSwell(
  uniforms: ShoreUniforms,
  travelDir: readonly [number, number],
  wavelengthMetres: number,
): void {
  const k = (Math.PI * 2) / Math.max(wavelengthMetres, 1);
  (uniforms.uSwashDir!.value as THREE.Vector2).set(travelDir[0], travelDir[1]).normalize();
  uniforms.uSwashK!.value = k;
  uniforms.uSwashOmega!.value = Math.sqrt(9.8 * k);
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
