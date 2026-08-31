import * as THREE from 'three';
import { globalUniforms, shadowUniforms } from '../../render/shading/ShadingUniforms';
import { SKY } from '../../art/palette';
import { SURFACES } from '../../art/surfaces';
import { buildIslandMesh, type IslandMeshResult } from './IslandMesh';
import type { IslandBounds, IslandField } from './IslandField';
import type { IslandSpec } from './IslandSpec';
import type { CoverUniforms } from './coverUniforms';
import type { ShoreUniforms } from '../shore/shoreUniforms';

import TERRAIN_VERT from './terrain.vert.glsl';
import TERRAIN_FRAG from './terrain.frag.glsl';
import OVERLAY_VERT from './overlay.vert.glsl';
import OVERLAY_FRAG from './overlay.frag.glsl';

/**
 * ONE ISLAND'S DRAW CALLS — the ground tiers of `05 §3`, assembled.
 *
 *   A0/A1  the terrain mesh, base colour and dried-grass sublayer   (`terrain.*.glsl`)
 *   B      the raised long-grass overlay, on the SAME geometry      (`overlay.*.glsl`)
 *
 * TIER C, THE INSTANCED OAK CANOPY, HAS BEEN REMOVED. The islands carry no trees at all: no
 * hulls, no leaves, no forest cover mask, and no forest tint baked into the ground colour.
 * What is left is rock, grass, and the long-grass overlay standing in it.
 *
 * TIER B SHARES THE BUFFER, IT DOES NOT COPY IT. `overlayMesh` is a second `THREE.Mesh` over
 * the very same `BufferGeometry` object as the terrain. §5 lists "overlay seams or hovers" as
 * the tier's characteristic failure and gives its cause as the two layers disagreeing about
 * height or LOD; two meshes over one buffer cannot disagree, because there is one set of
 * vertices. The separation between them is the vertex shader's normal offset and nothing else.
 *
 * BOTH MATERIALS SHARE ONE UNIFORM OBJECT GRAPH. The cover block, the shore block and the
 * global sky/sun block are assigned by reference, so a debug-UI edit moves every tier in the
 * same frame. §5's "patch boundaries swim" has the same root cause as the seam: layers reading
 * different numbers for the same field.
 */

export interface IslandOptions {
  readonly field: IslandField;
  readonly coverUniforms: CoverUniforms;
  /** Index into the field's layout order. Bounds key off it. */
  readonly index: number;
  /** Metres per mesh segment. The triangle budget is spent through this. */
  readonly metresPerSegment?: number;
  readonly maxSegments?: number;
}

export class Island {
  readonly spec: IslandSpec;
  readonly group = new THREE.Group();
  readonly meshInfo: IslandMeshResult;
  readonly terrainMesh: THREE.Mesh;
  readonly overlayMesh: THREE.Mesh;

  readonly terrainMaterial: THREE.ShaderMaterial;
  readonly overlayMaterial: THREE.ShaderMaterial;

  constructor(options: IslandOptions) {
    const { field, coverUniforms, index } = options;
    this.spec = field.specs[index] ?? field.spec;

    const bounds: IslandBounds | undefined = field.islandBounds[index] ?? undefined;
    this.meshInfo = buildIslandMesh(field, {
      ...(bounds ? { bounds } : {}),
      ...(options.metresPerSegment !== undefined ? { metresPerSegment: options.metresPerSegment } : {}),
      ...(options.maxSegments !== undefined ? { maxSegments: options.maxSegments } : {}),
    });

    const surface = SURFACES.limestone ?? SURFACES.openSea;
    // The ramp row both land tiers share.
    const rampUniforms: CoverUniforms = {
      uRampSteps: { value: surface.rampSteps },
      uShadowTint: { value: new THREE.Color(surface.shadowTint) },
      uShadowTintMix: { value: surface.shadowTintMix },
      uShadowDeep: { value: new THREE.Color(SKY.shadowDeep.hex) },
      uShadowCool: { value: surface.shadowCool },
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

    this.terrainMesh = new THREE.Mesh(this.meshInfo.geometry, this.terrainMaterial);
    this.terrainMesh.castShadow = true;
    this.terrainMesh.receiveShadow = true;

    // The same geometry object, deliberately. See the header.
    this.overlayMesh = new THREE.Mesh(this.meshInfo.geometry, this.overlayMaterial);
    this.overlayMesh.castShadow = false;
    this.overlayMesh.receiveShadow = true;
    // Drawn after the base, so its discarded fragments leave the base's depth untouched.
    this.overlayMesh.renderOrder = 1;

    this.group.name = this.spec.name;
    this.group.add(this.terrainMesh, this.overlayMesh);
  }

  get bounds(): IslandMeshResult['bounds'] {
    return this.meshInfo.bounds;
  }

  get triangles(): number {
    return this.meshInfo.triangles;
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
    for (const material of [this.terrainMaterial, this.overlayMaterial]) {
      Object.assign(material.uniforms, shore);
      material.needsUpdate = true;
    }
  }

  /** Tier B is expensive and the debug UI turns it off. */
  setTierVisibility(overlay: boolean): void {
    this.overlayMesh.visible = overlay;
  }

  dispose(): void {
    this.meshInfo.geometry.dispose();
    this.terrainMaterial.dispose();
    this.overlayMaterial.dispose();
  }
}
