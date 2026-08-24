import * as THREE from 'three';
import { LAND } from '../../art/palette';
import { globalUniforms } from '../../render/shading/ShadingUniforms';
import type { BiomeField } from '../island/BiomeField';
import type { IslandField } from '../island/IslandField';
import { buildCanopyMass } from './CanopyMass';
import { buildSpeciesGeometry } from './species';
import { VegetationField } from './VegetationField';
import { FOLIAGE_TRIANGLE_CEILING, LOD, SPECIES, SPECIES_NAMES, type ColorMap, type SpeciesName } from './VegetationSpec';

import FOLIAGE_VERT from './foliage.vert.glsl';
import FOLIAGE_FRAG from './foliage.frag.glsl';
import CANOPY_VERT from './canopy.vert.glsl';

/**
 * VEGETATION — `03 — Procedural Islands.md` §8, shaded with craftzdog/ghibli-style-shader.
 *
 * One `InstancedMesh` per species (§8.2: "one draw call per species per chunk") plus one
 * canopy-mass hull, so the whole system is five draw calls against the 40 the world is
 * allowed. Nothing here is per-tree on the CPU after construction: the frame update writes
 * two uniforms.
 *
 * Instanced frustum culling is the known gotcha the doc quotes ("with InstancedMesh you lose
 * frustum culling unless you manually update the bounding box"). There is one island and one
 * chunk, so the bounding sphere is computed once from the placed instances and left alone —
 * per-chunk bounds become worth writing when islands stream, and nothing streams yet.
 */

export interface VegetationOptions {
  /** Global multiplier on the baked density field. The debug UI's main knob. */
  densityScale?: number;
  /** Metres per second of gust travel. */
  windSpeed?: number;
  /** Wind bearing as a unit XZ vector. */
  windDir?: readonly [number, number];
}

interface SpeciesMesh {
  name: SpeciesName;
  mesh: THREE.InstancedMesh;
  material: THREE.ShaderMaterial;
  trianglesPerInstance: number;
  count: number;
}

const toColors = (map: ColorMap): THREE.Color[] => map.map((hex) => new THREE.Color(hex));

export class Vegetation {
  readonly group = new THREE.Group();
  readonly field: VegetationField;
  readonly species: SpeciesMesh[] = [];
  readonly canopy: THREE.Mesh;
  readonly canopyMaterial: THREE.ShaderMaterial;
  readonly canopyTriangles: number;
  readonly canopyLandCoverFraction: number;

  private readonly uCameraPos = { value: new THREE.Vector3() };
  private readonly uWindDir: { value: THREE.Vector2 };
  private readonly uWindSpeed: { value: number };
  private readonly uLodEnabled = { value: 1 };

  constructor(
    scene: THREE.Scene,
    island: IslandField,
    biomes: BiomeField,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    options: VegetationOptions = {},
  ) {
    const windDir = options.windDir ?? [0.82, 0.57];
    this.uWindDir = { value: new THREE.Vector2(windDir[0], windDir[1]).normalize() };
    this.uWindSpeed = { value: options.windSpeed ?? 1.0 };

    this.field = new VegetationField(island, biomes, bounds, options.densityScale ?? 1);

    for (let i = 0; i < SPECIES_NAMES.length; i++) {
      this.species.push(this.buildSpecies(SPECIES_NAMES[i]!, i));
    }

    const mass = buildCanopyMass(island, biomes, bounds);
    this.canopyTriangles = mass.triangles;
    this.canopyLandCoverFraction = mass.landCoverFraction;
    this.canopyMaterial = this.makeMaterial(
      CANOPY_VERT,
      // The dense-forest map, one rung darker than the trees standing in it. A canopy seen
      // from above is the shaded mass those crowns sit on, and matching them exactly makes
      // the trees vanish into it at the very range they are supposed to be emerging from.
      [LAND.canopyMid.hex, LAND.forestDense.hex, LAND.forestDense.hex, LAND.forestDeep.hex],
      [LAND.forestDense.hex, LAND.forestDense.hex, LAND.forestDeep.hex, LAND.forestDeep.hex],
      [0.6, 0.35, 0.001],
      0.9,
      // The hull needs the LOD uniforms too — it is the far end of the same ladder, and it
      // has to retract over exactly the range the instances grow in.
      true,
      0.6,
    );
    this.canopy = new THREE.Mesh(mass.geometry, this.canopyMaterial);
    this.canopy.name = 'Vegetation:canopyMass';
    this.canopy.frustumCulled = true;
    this.group.add(this.canopy);

    this.group.name = 'Vegetation';
    scene.add(this.group);
  }

  private buildSpecies(name: SpeciesName, index: number): SpeciesMesh {
    const spec = SPECIES[name];
    const { geometry, trianglesPerInstance } = buildSpeciesGeometry(spec, index * 17 + 3);
    const instances = this.field.placements[name].instances;
    const count = instances.length;

    const material = this.makeMaterial(
      FOLIAGE_VERT,
      spec.colorMaps[0],
      spec.colorMaps[1],
      spec.thresholds,
      // Scrub is a low mound with no underside to occlude; a tree has a whole crown of it.
      spec.shape === 'dome' ? 0.18 : 0.5,
      true,
      spec.sway,
    );

    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, 1));
    mesh.name = 'Vegetation:' + name;
    mesh.count = count;
    // No shadow flags. The island passes shadowFactor = 1.0 into the shared ramp and the
    // sun rig's frustum is 60 m wide; turning these on would light the shadow map budget on
    // fire for nothing. Cast shadows arrive with the cloud shadows in Step 5.
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    // Per-instance: colour-map index, wind phase, crown height in metres. Crown height is
    // per instance rather than per species because the scale varies, and the vertex shader
    // needs the ACTUAL height to weight the sway — using the species height would make a
    // small tree sway as though its crown were where a big one's is.
    const perInstance = new Float32Array(Math.max(count, 1) * 3);
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < count; i++) {
      const inst = instances[i]!;
      pos.set(inst.x, inst.y, inst.z);
      quat.setFromAxisAngle(up, inst.yaw);
      scale.setScalar(inst.scale);
      matrix.compose(pos, quat, scale);
      mesh.setMatrixAt(i, matrix);
      perInstance[i * 3 + 0] = inst.mapIndex;
      perInstance[i * 3 + 1] = inst.phase;
      perInstance[i * 3 + 2] = spec.height * inst.scale;
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.setAttribute('aInstance', new THREE.InstancedBufferAttribute(perInstance, 3));

    // The doc's InstancedMesh caveat: bounds have to be set by hand or every instance is
    // culled against the prototype geometry's own tiny sphere. One island, one chunk, so
    // this is computed once from the placement and never touched again.
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;

    this.group.add(mesh);
    return { name, mesh, material, trianglesPerInstance, count };
  }

  private makeMaterial(
    vertexShader: string,
    mapA: ColorMap,
    mapB: ColorMap,
    thresholds: readonly [number, number, number],
    aoStrength: number,
    lodAware: boolean,
    sway = 0.3,
  ): THREE.ShaderMaterial {
    const uniforms: Record<string, THREE.IUniform> = Object.assign(
      {
        uColorMapA: { value: toColors(mapA) },
        uColorMapB: { value: toColors(mapB) },
        uThresholds: { value: new THREE.Vector3(thresholds[0], thresholds[1], thresholds[2]) },
        uAoStrength: { value: aoStrength },
        uWindDir: this.uWindDir,
        uWindSpeed: this.uWindSpeed,
        uSway: { value: sway },
      },
      globalUniforms as unknown as Record<string, THREE.IUniform>,
    );
    if (lodAware) {
      uniforms.uCameraPos = this.uCameraPos;
      uniforms.uNearRange = { value: LOD.nearRange };
      uniforms.uFarRange = { value: LOD.farRange };
      uniforms.uLodEnabled = this.uLodEnabled;
    }

    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader: FOLIAGE_FRAG,
      side: THREE.FrontSide,
      toneMapped: false, // colour is authored end-to-end; see RendererConfig
    });
  }

  // ------------------------------------------------------------------ frame

  update(camera: THREE.Camera): void {
    camera.getWorldPosition(this.uCameraPos.value);
  }

  // ------------------------------------------------------------------ knobs

  setDensityVisible(fraction: number): void {
    for (const s of this.species) {
      s.mesh.count = Math.round(s.count * THREE.MathUtils.clamp(fraction, 0, 1));
    }
  }

  setLodEnabled(enabled: boolean): void {
    this.uLodEnabled.value = enabled ? 1 : 0;
  }

  setWind(speed: number): void {
    this.uWindSpeed.value = speed;
  }

  /**
   * The two ranges are set on the canopy hull as well as on the species, and they have to
   * be: the hull retracts over the same window the instances grow in, so moving one end
   * without the other opens a gap where neither representation is drawn — or, worse, a band
   * where both are and the hull swallows the trees.
   */
  setNearRange(m: number): void {
    this.forEachLodMaterial((u) => { u.uNearRange!.value = m; });
  }

  setFarRange(m: number): void {
    this.forEachLodMaterial((u) => { u.uFarRange!.value = m; });
  }

  private forEachLodMaterial(fn: (u: Record<string, THREE.IUniform | undefined>) => void): void {
    for (const s of this.species) fn(s.material.uniforms);
    fn(this.canopyMaterial.uniforms);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  setCanopyVisible(visible: boolean): void {
    this.canopy.visible = visible;
  }

  // ------------------------------------------------------------------ reporting

  get instanceCount(): number {
    return this.species.reduce((n, s) => n + s.count, 0);
  }

  /** Triangles at full instance count, which is what `renderer.info` will report. */
  get triangles(): number {
    return this.species.reduce((n, s) => n + s.count * s.trianglesPerInstance, 0) + this.canopyTriangles;
  }

  get drawCalls(): number {
    return this.species.filter((s) => s.count > 0).length + 1;
  }

  get withinBudget(): boolean {
    return this.triangles <= FOLIAGE_TRIANGLE_CEILING;
  }

  trianglesPerInstance(name: SpeciesName): number {
    return this.species.find((s) => s.name === name)?.trianglesPerInstance ?? 0;
  }

  dispose(): void {
    for (const s of this.species) {
      s.mesh.geometry.dispose();
      s.material.dispose();
    }
    this.canopy.geometry.dispose();
    this.canopyMaterial.dispose();
  }
}
