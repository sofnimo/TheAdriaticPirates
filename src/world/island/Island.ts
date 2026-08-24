import * as THREE from 'three';
import { LAND } from '../../art/palette';
import { SURFACES } from '../../art/surfaces';
import { globalUniforms } from '../../render/shading/ShadingUniforms';
import { BiomeField } from './BiomeField';
import { IslandField } from './IslandField';
import { buildIslandMesh, type IslandMeshResult } from './IslandMesh';
import { PUNTA_SEVERA, type IslandSpec } from './IslandSpec';
import type { ShoreUniforms } from '../shore/shoreUniforms';

import ISLAND_VERT from './island.vert.glsl';
import ISLAND_FRAG from './island.frag.glsl';

/**
 * ONE HAND-AUTHORED ISLAND — Step 3.
 *
 * Owns the baked field, the mesh and the material. The field is the interesting part: the
 * sea's bathymetry reads the SAME land mask this mesh was built from, so the shore the player
 * flies over and the shore the water shelves against cannot drift apart. `02b — Coastal
 * Waves.md` §1.2 makes that a requirement; here it is satisfied by there being one array.
 *
 * The shading is the shared gouache chunk, unforked. `terrain_color.glsl` supplies the base
 * colour and stops there.
 */
export class Island {
  readonly spec: IslandSpec;
  readonly field: IslandField;
  /** 03 §7's cover assignment, baked once. The vegetation placer reads this same object. */
  readonly biomes: BiomeField;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly meshInfo: IslandMeshResult;

  constructor(
    scene: THREE.Scene,
    spec: IslandSpec = PUNTA_SEVERA,
    worldSize = 4096,
  ) {
    this.spec = spec;
    this.field = new IslandField(spec, {
      // Matches the bathymetry's 1024 exactly. At 512 the two grids disagreed on 38 texels
      // along the coast — not a real difference of opinion about where the shore is, just
      // resampling: an 8 m island texel maps to four 4 m depth texels and `landAt`'s nearest
      // lookup can round to the neighbour. Equal resolutions make the agreement exact rather
      // than approximate, which is the only version of that claim worth gating on.
      resolution: 1024,
      worldSize,
      originX: -worldSize / 2,
      originZ: -worldSize / 2,
    });
    // Biome before mesh: the terrain material samples the baked map, so it has to exist
    // before the material that reads it. Same ordering rule as the shore atlas, one field on.
    this.biomes = new BiomeField(this.field, { cellSize: 55 });
    this.meshInfo = buildIslandMesh(this.field);

    const surface = SURFACES.limestone;

    this.material = new THREE.ShaderMaterial({
      uniforms: Object.assign(
        {
          // Shared gouache chunk, limestone row of 04 §2.3. Not a forked ramp — the same
          // chunk the sea, and later the clouds and foliage, run through.
          uRampSteps: { value: surface.rampSteps },
          uShadowTint: { value: new THREE.Color(surface.shadowTint) },
          uShadowTintMix: { value: surface.shadowTintMix },
          uRimColor: { value: new THREE.Color(surface.rimColor) },
          uRimPower: { value: surface.rimPower },
          uRimStrength: { value: surface.rimStrength },

          // 03 §7.2's palette anchors, verbatim from 00 §2.
          cBeach: { value: new THREE.Color(LAND.sand.hex) },
          cRockLit: { value: new THREE.Color(LAND.limestoneLit.hex) },
          cRockShadow: { value: new THREE.Color(LAND.limestoneStrata.hex) },
          cRockDark: { value: new THREE.Color(LAND.limestoneShadowDeep.hex) },
          cMacchia: { value: new THREE.Color(LAND.scrubOlivePale.hex) },
          cPasture: { value: new THREE.Color(LAND.pastureDry.hex) },
          cForest: { value: new THREE.Color(LAND.forestDense.hex) },
          cForestSparse: { value: new THREE.Color(LAND.forestSparse?.hex ?? 0x45764e) },
          cTerrace: { value: new THREE.Color(LAND.scrubOlive.hex) },

          // 03 §7.3: cells larger than any building or tree cluster, smaller than a hillside.
          // The cell ASSIGNMENT now lives in BiomeField; what stays in the shader is the
          // few-metre boundary wobble, which has to be sub-texel to be worth having.
          uBiomeCellSize: { value: this.biomes.cellSize },
          uBiomeEdgeWobble: { value: 5 },
          uBiomeMap: { value: this.biomes.texture },
          uBiomeMapOrigin: { value: new THREE.Vector2(...this.biomes.mapOrigin) },
          uBiomeMapSize: { value: this.biomes.mapSize },
          uStrataSpacing: { value: spec.strataSpacing },
          uPeakHeight: { value: spec.peakHeight },
        },
        globalUniforms as unknown as Record<string, THREE.IUniform>,
      ),
      vertexShader: ISLAND_VERT,
      fragmentShader: ISLAND_FRAG,
      side: THREE.FrontSide,
      toneMapped: false, // colour is authored end-to-end; see RendererConfig
    });

    this.mesh = new THREE.Mesh(this.meshInfo.geometry, this.material);
    this.mesh.name = 'Island:' + spec.name;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
  }

  get triangles(): number {
    return this.meshInfo.triangles;
  }

  /** The land mask query the depth field consumes. One owner, one array. */
  landAt = (x: number, z: number): boolean => this.field.isLand(x, z);

  /**
   * Attach the shoreline block after construction.
   *
   * Deferred rather than passed to the constructor because the atlas is baked FROM this
   * island's own field, so it cannot exist yet when the island is being built. 02b §7.1 calls
   * the shoreline system a post-process stage of the island pipeline, and this is that
   * ordering made explicit rather than worked around.
   */
  attachShore(shore: ShoreUniforms): void {
    Object.assign(this.material.uniforms, shore);
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.meshInfo.geometry.dispose();
    this.material.dispose();
    this.biomes.dispose();
  }
}
