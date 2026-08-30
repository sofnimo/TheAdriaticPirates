import * as THREE from 'three';
import { ISLAND_COVER } from '../../art/islandCover';
import type { CoverField } from './CoverField';
import { BEACH_WIDTH_MAX, type IslandField } from './IslandField';

/**
 * ONE UNIFORM BLOCK, SHARED BY EVERY LAND MATERIAL.
 *
 * A0 base, tier B overlay and tier C canopy all read the SAME cover texture and the SAME shore
 * character texture. §5's failure table lists "overlay seams or hovers" and "patch boundaries
 * swim" as the two things that go wrong when they do not, and the cause it gives for both is
 * the layers evaluating different data. Sharing the uniform objects by reference makes that
 * impossible rather than merely unlikely — one edit in the debug UI moves every tier at once.
 */

export type CoverUniforms = Record<string, THREE.IUniform>;

export function makeCoverUniforms(cover: CoverField, island: IslandField): CoverUniforms {
  const c = ISLAND_COVER;
  const [ox, oz] = cover.mapOrigin;
  return {
    uCoverMap: { value: cover.texture },
    uCoverOrigin: { value: new THREE.Vector2(ox, oz) },
    uCoverSize: { value: cover.mapSize },

    uCharacterMap: { value: island.characterTexture },
    uCharacterOrigin: { value: new THREE.Vector2(island.originX, island.originZ) },
    uCharacterSize: { value: island.worldSize },
    uBeachWidthMax: { value: BEACH_WIDTH_MAX },

    cCliff: { value: new THREE.Color(c.cliff) },
    cCliffStrata: { value: new THREE.Color(c.cliffStrata) },
    cSand: { value: new THREE.Color(c.sand) },
    cGrass: { value: new THREE.Color(c.grass) },
    cGrassDry: { value: new THREE.Color(c.grassDry) },
    cLongGrass: { value: new THREE.Color(c.longGrass) },
    cCanopyDark: { value: new THREE.Color(c.canopyDark) },
    cCanopyMid: { value: new THREE.Color(c.canopyMid) },
    cCanopyLight: { value: new THREE.Color(c.canopyLight) },

    uDryBoost: { value: 1 },
    uDrySoftness: { value: c.drySoftness },

    uSandWidth: { value: c.sandWidth },
    uShoreSandWidth: { value: c.shoreSandWidth },
    uSandSeaward: { value: c.sandSeaward },
    uSandSoftness: { value: c.sandSoftness },
    uSandEdgeWobble: { value: c.sandEdgeWobble },
    uSandEdgeScale: { value: c.sandEdgeScale },

    uCliffSlopeStart: { value: c.cliffSlopeStart },
    uCliffSoftness: { value: c.cliffSoftness },
    uCoastRockNear: { value: c.coastRockNear },
    uCoastRockFar: { value: c.coastRockFar },
    uStrataMetres: { value: c.strataMetres },
    uStrataStrength: { value: c.strataStrength },

    uLongGrassOffset: { value: c.longGrassOffset },
    uLongGrassThreshold: { value: c.longGrassThreshold },
    uLongGrassBreakupScale: { value: c.longGrassBreakupScale },
    uLongGrassSandMargin: { value: c.longGrassSandMargin },

    uForestThreshold: { value: c.forestThreshold },
    uForestSandMargin: { value: c.forestSandMargin },

    uLeafSize: { value: c.leafSize },
    uLeafAspect: { value: c.leafAspect },
    uLeafFadeStart: { value: c.leafFadeStart },
    uLeafFadeEnd: { value: c.leafFadeEnd },
    uLeafNormalMix: { value: c.leafNormalMix },

    uNormalSpread: { value: c.normalSpread },
    uSplitMid: { value: c.splitMid },
    uSplitLit: { value: c.splitLit },
    uDabDensity: { value: c.dabDensity },
    uDabScale: { value: c.dabScale },
  };
}

/** Push the live half of `ISLAND_COVER` into an existing block. Structural edits re-bake. */
export function syncCoverUniforms(u: CoverUniforms): void {
  const c = ISLAND_COVER;
  (u.cCliff!.value as THREE.Color).set(c.cliff);
  (u.cCliffStrata!.value as THREE.Color).set(c.cliffStrata);
  (u.cSand!.value as THREE.Color).set(c.sand);
  (u.cGrass!.value as THREE.Color).set(c.grass);
  (u.cGrassDry!.value as THREE.Color).set(c.grassDry);
  (u.cLongGrass!.value as THREE.Color).set(c.longGrass);
  (u.cCanopyDark!.value as THREE.Color).set(c.canopyDark);
  (u.cCanopyMid!.value as THREE.Color).set(c.canopyMid);
  (u.cCanopyLight!.value as THREE.Color).set(c.canopyLight);

  u.uDrySoftness!.value = c.drySoftness;
  u.uSandWidth!.value = c.sandWidth;
  u.uShoreSandWidth!.value = c.shoreSandWidth;
  u.uSandSeaward!.value = c.sandSeaward;
  u.uSandSoftness!.value = c.sandSoftness;
  u.uSandEdgeWobble!.value = c.sandEdgeWobble;
  u.uSandEdgeScale!.value = c.sandEdgeScale;

  u.uCliffSlopeStart!.value = c.cliffSlopeStart;
  u.uCliffSoftness!.value = c.cliffSoftness;
  u.uCoastRockNear!.value = c.coastRockNear;
  u.uCoastRockFar!.value = c.coastRockFar;
  u.uStrataMetres!.value = c.strataMetres;
  u.uStrataStrength!.value = c.strataStrength;

  u.uLongGrassOffset!.value = c.longGrassOffset;
  u.uLongGrassThreshold!.value = c.longGrassThreshold;
  u.uLongGrassBreakupScale!.value = c.longGrassBreakupScale;
  u.uLongGrassSandMargin!.value = c.longGrassSandMargin;

  u.uForestThreshold!.value = c.forestThreshold;
  u.uForestSandMargin!.value = c.forestSandMargin;

  // Leaf SIZE and FADE are live: they only move existing blades. `leavesPerHull` and
  // `domeInset` are not here because they are baked into the crown geometry and need a rebake.
  u.uLeafSize!.value = c.leafSize;
  u.uLeafAspect!.value = c.leafAspect;
  u.uLeafFadeStart!.value = c.leafFadeStart;
  u.uLeafFadeEnd!.value = c.leafFadeEnd;
  u.uLeafNormalMix!.value = c.leafNormalMix;

  u.uNormalSpread!.value = c.normalSpread;
  u.uSplitMid!.value = c.splitMid;
  u.uSplitLit!.value = c.splitLit;
  u.uDabDensity!.value = c.dabDensity;
  u.uDabScale!.value = c.dabScale;
}
