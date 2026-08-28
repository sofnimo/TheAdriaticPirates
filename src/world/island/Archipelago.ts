import * as THREE from 'three';
import { ISLAND_COVER } from '../../art/islandCover';
import { generateArchipelago, footprintShare } from './ArchipelagoLayout';
import { CoverField } from './CoverField';
import { Island, hullBudget } from './Island';
import { IslandField } from './IslandField';
import { makeCoverUniforms, syncCoverUniforms, type CoverUniforms } from './coverUniforms';
import type { Archetype, IslandSpec } from './IslandSpec';
import type { ShoreUniforms } from '../shore/shoreUniforms';

/**
 * THE LAND SUBSYSTEM — everything above and below the waterline that is not water.
 *
 * ONE LATTICE FOR THE WHOLE TILE. The elevation field, the bathymetry and the shore atlas all
 * sample the same grid at the same origin. They could each have their own — they are logically
 * three different questions — but `02b §1.2` requires one owner for the shore signal, and the
 * strongest form of "one owner" is one array of numbers. Any two grids at different pitches
 * eventually disagree about where the coastline is by half a texel, and half a texel of
 * disagreement is a foam ribbon that runs slightly inland of the beach it belongs to.
 *
 * THE PIPELINE IS STRICTLY ORDERED AND EACH STAGE IS A PURE FUNCTION OF THE ONE BEFORE:
 *
 *   1. layout      seeds -> descriptors                (`ArchipelagoLayout`)
 *   2. elevation   descriptors -> one signed field     (`IslandField`)
 *   3. cover       elevation -> three masks            (`CoverField`)
 *   4. meshes      elevation + masks -> draw calls     (`Island`)
 *   5. shore       attached late, baked from stage 2   (`attachShore`)
 *
 * Stage 5 is the only one that runs backwards, and only because the shore atlas is baked from
 * the land mask this class produced — it cannot exist before stage 2, and the land materials
 * need it to know how far inland a fragment is.
 *
 * THE TRIANGLE BUDGET IS DIVIDED BY FOOTPRINT, NOT EQUALLY. A 6 km hero island and a 200 m
 * islet do not deserve the same mesh, and giving them one produces a hero at 9 m per segment
 * next to an islet resolved to centimetres. Both the mesh density and the canopy hull cap are
 * shared out by land area.
 */

export interface ArchipelagoConfig {
  readonly seed: number;
  readonly heroSeed?: number;
  readonly worldSize: number;
  readonly resolution: number;
  readonly heroArchetype?: Archetype;
  readonly heroName?: string;
  readonly islandCount?: number;
  /** Metres per mesh segment on the hero. Smaller islands get proportionally coarser. */
  readonly metresPerSegment?: number;
}

export class Archipelago {
  readonly group = new THREE.Group();
  readonly specs: readonly IslandSpec[];
  readonly field: IslandField;
  readonly cover: CoverField;
  readonly coverUniforms: CoverUniforms;
  readonly islands: Island[] = [];

  private shore: ShoreUniforms | null = null;

  constructor(scene: THREE.Scene, config: ArchipelagoConfig) {
    this.group.name = 'archipelago';

    this.specs = generateArchipelago({
      seed: config.seed,
      worldSize: config.worldSize,
      ...(config.heroSeed !== undefined ? { heroSeed: config.heroSeed } : {}),
      ...(config.heroArchetype !== undefined ? { heroArchetype: config.heroArchetype } : {}),
      ...(config.heroName !== undefined ? { heroName: config.heroName } : {}),
      ...(config.islandCount !== undefined ? { count: config.islandCount } : {}),
    });

    this.field = new IslandField(this.specs, {
      resolution: config.resolution,
      worldSize: config.worldSize,
      originX: -config.worldSize / 2,
      originZ: -config.worldSize / 2,
    });

    this.cover = new CoverField(this.field);
    this.coverUniforms = makeCoverUniforms(this.cover, this.field);

    const shares = footprintShare(this.specs);
    const base = config.metresPerSegment ?? 9;
    for (let i = 0; i < this.specs.length; i++) {
      // An island that generated entirely below sea level has no land box and nothing to draw.
      if (!this.field.islandBounds[i]) continue;
      const share = shares[i] ?? 0;
      const island = new Island({
        field: this.field,
        cover: this.cover,
        coverUniforms: this.coverUniforms,
        index: i,
        // The hero gets the authored density; a tenth of the land area gets a third again as
        // coarse. Not linear in share, or the islets end up at one quad each.
        metresPerSegment: base / Math.max(0.35, Math.pow(share, 0.25)),
        maxHulls: hullBudget(share),
      });
      this.islands.push(island);
      this.group.add(island.group);
    }

    scene.add(this.group);
  }

  /** The island the cameras and the acceptance gates frame. Always layout index 0. */
  get hero(): Island {
    return this.islands[0]!;
  }

  get triangles(): number {
    return this.islands.reduce((sum, island) => sum + island.triangles, 0);
  }

  get hulls(): number {
    return this.islands.reduce((sum, island) => sum + island.canopy.hulls, 0);
  }

  /** Bound so it can be handed to `DepthField` as a plain callback. */
  readonly landAt = (x: number, z: number): boolean => this.field.isLand(x, z);
  readonly heightAt = (x: number, z: number): number => this.field.heightAt(x, z);

  /** Stage 5. See the header for why this runs after construction rather than inside it. */
  attachShore(shore: ShoreUniforms): void {
    this.shore = shore;
    for (const island of this.islands) island.attachShore(shore);
  }

  /**
   * Re-read `ISLAND_COVER` after a debug edit.
   *
   * `structural` re-bakes the masks, which is the expensive path and the only one that can
   * move a patch outline; everything else is a uniform write. The split exists because the
   * debug UI edits both kinds of field from the same panel and the cheap ones want to be
   * live under the slider.
   */
  refreshCover(structural = false): void {
    if (structural) this.cover.bake();
    syncCoverUniforms(this.coverUniforms);
    if (structural) this.rebuildCanopy();
  }

  /** Hull placement is baked from the masks, so a structural edit has to re-scatter it. */
  private rebuildCanopy(): void {
    const shares = footprintShare(this.specs);
    const rebuilt: Island[] = [];
    for (const island of this.islands) {
      const index = this.specs.indexOf(island.spec);
      this.group.remove(island.group);
      island.dispose();
      const next = new Island({
        field: this.field,
        cover: this.cover,
        coverUniforms: this.coverUniforms,
        index,
        maxHulls: hullBudget(shares[index] ?? 0),
      });
      if (this.shore) next.attachShore(this.shore);
      rebuilt.push(next);
      this.group.add(next.group);
    }
    this.islands.length = 0;
    this.islands.push(...rebuilt);
  }

  setTierVisibility(overlay: boolean, canopy: boolean): void {
    for (const island of this.islands) island.setTierVisibility(overlay, canopy);
  }

  get hullCap(): number {
    return ISLAND_COVER.canopyMaxHulls;
  }

  dispose(): void {
    for (const island of this.islands) island.dispose();
    this.cover.dispose();
    this.field.characterTexture.dispose();
  }
}
