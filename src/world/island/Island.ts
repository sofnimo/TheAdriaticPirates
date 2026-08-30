import * as THREE from 'three';
import { globalUniforms, shadowUniforms } from '../../render/shading/ShadingUniforms';
import { SURFACES } from '../../art/surfaces';
import { ISLAND_COVER } from '../../art/islandCover';
import { buildIslandMesh, type IslandMeshResult } from './IslandMesh';
import { buildCanopy, type CanopyResult } from './Canopy';
import type { CoverField } from './CoverField';
import type { IslandBounds, IslandField } from './IslandField';
import type { IslandSpec } from './IslandSpec';
import type { CoverUniforms } from './coverUniforms';
import type { ShoreUniforms } from '../shore/shoreUniforms';

import TERRAIN_VERT from './terrain.vert.glsl';
import TERRAIN_FRAG from './terrain.frag.glsl';
import OVERLAY_VERT from './overlay.vert.glsl';
import OVERLAY_FRAG from './overlay.frag.glsl';
import CANOPY_VERT from './canopy.vert.glsl';
import CANOPY_DEPTH_VERT from './canopy.depth.vert.glsl';
import CANOPY_DEPTH_FRAG from './canopy.depth.frag.glsl';
import CANOPY_FRAG from './canopy.frag.glsl';

/**
 * ONE ISLAND'S DRAW CALLS — the four-tier stack of `05 §3`, assembled.
 *
 *   A0/A1  the terrain mesh, base colour and dried-grass sublayer   (`terrain.*.glsl`)
 *   B      the raised long-grass overlay, on the SAME geometry      (`overlay.*.glsl`)
 *   C      instanced oak canopy hulls                               (`canopy.*.glsl`)
 *
 * TIER B SHARES THE BUFFER, IT DOES NOT COPY IT. `overlayMesh` is a second `THREE.Mesh` over
 * the very same `BufferGeometry` object as the terrain. §5 lists "overlay seams or hovers" as
 * the tier's characteristic failure and gives its cause as the two layers disagreeing about
 * height or LOD; two meshes over one buffer cannot disagree, because there is one set of
 * vertices. The separation between them is the vertex shader's normal offset and nothing else.
 *
 * ALL THREE MATERIALS SHARE ONE UNIFORM OBJECT GRAPH. The cover block, the shore block and the
 * global sky/sun block are assigned by reference, so a debug-UI edit moves every tier in the
 * same frame. §5's "patch boundaries swim" has the same root cause as the seam: layers reading
 * different numbers for the same field.
 */

export interface IslandOptions {
  readonly field: IslandField;
  readonly cover: CoverField;
  readonly coverUniforms: CoverUniforms;
  /** Index into the field's layout order. Bounds and canopy ownership key off it. */
  readonly index: number;
  /** Metres per mesh segment. The triangle budget is spent through this. */
  readonly metresPerSegment?: number;
  readonly maxSegments?: number;
  readonly maxHulls?: number;
}

export class Island {
  readonly spec: IslandSpec;
  readonly group = new THREE.Group();
  readonly meshInfo: IslandMeshResult;
  readonly terrainMesh: THREE.Mesh;
  readonly overlayMesh: THREE.Mesh;
  readonly canopy: CanopyResult;

  readonly terrainMaterial: THREE.ShaderMaterial;
  readonly overlayMaterial: THREE.ShaderMaterial;
  readonly canopyMaterial: THREE.ShaderMaterial;
  readonly canopyDepthMaterial: THREE.ShaderMaterial;

  constructor(options: IslandOptions) {
    const { field, cover, coverUniforms, index } = options;
    this.spec = field.specs[index] ?? field.spec;

    const bounds: IslandBounds | undefined = field.islandBounds[index] ?? undefined;
    this.meshInfo = buildIslandMesh(field, {
      ...(bounds ? { bounds } : {}),
      ...(options.metresPerSegment !== undefined ? { metresPerSegment: options.metresPerSegment } : {}),
      ...(options.maxSegments !== undefined ? { maxSegments: options.maxSegments } : {}),
    });

    const surface = SURFACES.limestone ?? SURFACES.openSea;
    // The ramp row every land tier shares. Terrain and overlay both read it; the canopy does
    // not go through the ramp at all (§8.2), so it never sees these.
    const rampUniforms: CoverUniforms = {
      uRampSteps: { value: surface.rampSteps },
      uShadowTint: { value: new THREE.Color(surface.shadowTint) },
      uShadowTintMix: { value: surface.shadowTintMix },
      uRimColor: { value: new THREE.Color(surface.rimColor) },
      uRimPower: { value: surface.rimPower },
      uRimStrength: { value: surface.rimStrength },
    };

    // The cascade block joins the globals: same objects, every land material, so a shadow
    // cannot fall in one place on the ground and another on the grass standing in it.
    const shared = (): CoverUniforms => Object.assign(
      {},
      globalUniforms as unknown as CoverUniforms,
      shadowUniforms as CoverUniforms,
      rampUniforms,
      coverUniforms,
    );

    this.terrainMaterial = new THREE.ShaderMaterial({
      uniforms: shared(),
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      side: THREE.FrontSide,
      toneMapped: false,
    });

    this.overlayMaterial = new THREE.ShaderMaterial({
      uniforms: shared(),
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      side: THREE.FrontSide,
      toneMapped: false,
      // §5's fix order: the geometric offset in the vertex shader does the real work, and this
      // is the small safety bias on top for the places the taper has pulled the offset to zero.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.canopyMaterial = new THREE.ShaderMaterial({
      uniforms: shared(),
      vertexShader: CANOPY_VERT,
      fragmentShader: CANOPY_FRAG,
      // A dome has no back faces worth drawing, but its rim is open and a hull straddling a
      // ridge can be seen through that opening from below. Cheaper to draw both sides of a
      // seven-sided dome than to close it.
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.terrainMesh = new THREE.Mesh(this.meshInfo.geometry, this.terrainMaterial);
    this.terrainMesh.castShadow = true;
    this.terrainMesh.receiveShadow = true;

    // The same geometry object, deliberately. See the header.
    this.overlayMesh = new THREE.Mesh(this.meshInfo.geometry, this.overlayMaterial);
    this.overlayMesh.castShadow = false;
    this.overlayMesh.receiveShadow = true;
    // Drawn after the base, so its discarded fragments leave the base's depth untouched.
    this.overlayMesh.renderOrder = 1;

    // THE SHADOW PASS SHARES THE UNIFORM BLOCK. It has to: leaf placement reads `uLeafSize`
    // and `uLeafAspect`, and a depth material with its own copies would drift the moment
    // anything moved one of them — leaves would cast shadows from a size they are not drawn
    // at. Built here rather than inside buildCanopy because this is where the block lives.
    this.canopyDepthMaterial = new THREE.ShaderMaterial({
      uniforms: shared(),
      vertexShader: CANOPY_DEPTH_VERT,
      fragmentShader: CANOPY_DEPTH_FRAG,
      side: THREE.DoubleSide,
    });

    this.canopy = buildCanopy(cover, {
      material: this.canopyMaterial,
      depthMaterial: this.canopyDepthMaterial,
      owner: index,
      ...(options.maxHulls !== undefined ? { maxHulls: options.maxHulls } : {}),
    });
    this.canopy.mesh.renderOrder = 2;

    this.group.name = this.spec.name;
    this.group.add(this.terrainMesh, this.overlayMesh, this.canopy.mesh);
  }

  get bounds(): IslandMeshResult['bounds'] {
    return this.meshInfo.bounds;
  }

  get triangles(): number {
    return this.meshInfo.triangles + this.canopy.triangles;
  }

  /**
   * Give the land materials the shoreline block.
   *
   * Late, because the atlas is baked FROM this island — `land_cover.glsl` reads the signed
   * shore distance to know how far inland a fragment is, and that field cannot exist until the
   * land mask does. Assigned by reference into the live uniform objects, so the water and the
   * land are reading the same run-up phase rather than two copies of it.
   */
  attachShore(shore: ShoreUniforms): void {
    for (const material of [this.terrainMaterial, this.overlayMaterial, this.canopyMaterial]) {
      Object.assign(material.uniforms, shore);
      material.needsUpdate = true;
    }
  }

  /** Tier B is expensive and the debug UI turns it off; tier C likewise. */
  setTierVisibility(overlay: boolean, canopy: boolean): void {
    this.overlayMesh.visible = overlay;
    this.canopy.mesh.visible = canopy;
  }

  dispose(): void {
    this.meshInfo.geometry.dispose();
    this.canopy.mesh.geometry.dispose();
    this.terrainMaterial.dispose();
    this.overlayMaterial.dispose();
    this.canopyMaterial.dispose();
    // The shadow-pass material is owned here too. Missed, it leaks a compiled program per
    // island on every structural edit — and the canopy is re-scattered by a slider, so that is
    // once per drag, not once per session.
    this.canopyDepthMaterial.dispose();
  }
}

/** The hull count the whole tile is allowed, divided by land area. Used by `Archipelago`. */
export function hullBudget(share: number): number {
  return Math.max(200, Math.floor(ISLAND_COVER.canopyMaxHulls * share));
}
