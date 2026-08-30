import * as THREE from 'three';

/**
 * THE GROUND, GENERATED.
 *
 * The vendored scene ships one 14.8 m ground quad — a 12×12 grid, almost flat,
 * tilted a little. Repeating it is what made the field read as a grid of copies.
 * This replaces it with a single continuous heightfield of any size, cut into
 * patches purely for bookkeeping (see below), and hands back a `heightAt` sampler
 * so rocks, trees and the aircraft can all be put down ON it rather than at y=0.
 *
 * ── Why patches, when the point was to stop tiling ──────────────────────────
 *
 * The patches are NOT tiles. They carry no content of their own: the height
 * function is one continuous field evaluated in world space, so a patch boundary
 * is invisible — neighbouring patches sample the identical function at the
 * identical coordinates and their edge vertices land in exactly the same place.
 * They exist for two mechanical reasons:
 *
 *   · The blade shader's rock array is a fixed 24 entries and every blade loops
 *     over all of it in the vertex stage. A patch gives each blade batch a short
 *     list of the rocks that could actually reach it.
 *   · Frustum culling. One 60 m ground mesh with 100k blades welded to it is all
 *     or nothing; a dozen patches let the camera drop most of the field.
 *
 * ── The dirt mask ───────────────────────────────────────────────────────────
 *
 * `groundDirt` here is a CPU transcription of `groundMask.ts`'s GLSL. It is used
 * only to BIAS PLACEMENT — trees keep off bare earth, rocks prefer it — so it
 * wants to agree with the shader about roughly where the patches are, not
 * bit-for-bit. It will not match exactly: the GPU evaluates that noise at float32
 * and this runs at float64. Do not use it for anything that has to line up to the
 * pixel.
 */

/** GLSL `smoothstep` on an already-normalised t. */
function smoothstep01(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

/** GLSL `fract`. */
const fract = (x: number): number => x - Math.floor(x);

/** `_gmHash` from groundMask.ts. */
function gmHash(x: number, y: number): number {
  let px = fract(x * 127.1);
  let py = fract(y * 311.7);
  const d = px * (px + 19.19) + py * (py + 19.19);
  px += d;
  py += d;
  return fract(px * py);
}

/** `_gmNoise` — value noise with a smoothstep fade. */
function gmNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = gmHash(ix, iy);
  const b = gmHash(ix + 1, iy);
  const c = gmHash(ix, iy + 1);
  const d = gmHash(ix + 1, iy + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}

/** `_gmFbm` — four octaves, normalised. Same lacunarity and offsets as the GLSL. */
export function gmFbm(x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  let n = 0;
  let px = x;
  let py = y;
  for (let i = 0; i < 4; i++) {
    v += a * gmNoise(px, py);
    n += a;
    px = px * 2.03 + 3.1;
    py = py * 2.03 + 7.7;
    a *= 0.5;
  }
  return v / Math.max(n, 0.001);
}

export interface DirtSettings {
  scale: number;
  coverage: number;
  softness: number;
  warp: number;
  /** The shore band, mirroring groundMask.ts. 0 = off. */
  shoreStart?: number;
  shoreEnd?: number;
  shore?: number;
}

/** `groundDirt` — 0 = full grass, 1 = bare earth. */
export function groundDirt(x: number, z: number, d: DirtSettings): number {
  let px = x * d.scale;
  let py = z * d.scale;
  if (d.warp > 0.001) {
    const wx = gmFbm(px + 11.3, py + 2.7);
    const wy = gmFbm(px + 5.9, py + 17.1);
    px += (wx - 0.5) * d.warp;
    py += (wy - 0.5) * d.warp;
  }
  const n = gmFbm(px, py);
  const threshold = 1 - d.coverage;
  const e0 = threshold - d.softness;
  const e1 = threshold + d.softness;
  const t = Math.min(1, Math.max(0, (n - e0) / Math.max(e1 - e0, 1e-6)));
  const dirt = t * t * (3 - 2 * t);

  const shoreAmount = d.shore ?? 0;
  if (shoreAmount <= 0) return dirt;
  const s0 = d.shoreStart ?? 0;
  const s1 = d.shoreEnd ?? 0;
  const u = Math.min(1, Math.max(0, (z - s0) / Math.max(s1 - s0, 1e-6)));
  return Math.max(dirt, u * u * (3 - 2 * u) * shoreAmount);
}

export interface TerrainOptions {
  /** Land footprint, metres. */
  width: number;
  depth: number;
  /** Centre of the land, world XZ. */
  centreX?: number;
  centreZ?: number;
  /** Ground quads per metre. The blade scatter is area-weighted over triangles,
   *  so this also sets how evenly blades follow the relief. */
  cellsPerMetre?: number;
  /** Peak-to-trough of the rolling relief, metres. */
  relief?: number;
  /** World units per noise cycle for the relief. Bigger = broader hills. */
  reliefScale?: number;
  /** Patches across and down. Bookkeeping only — see the module header. */
  patchesX?: number;
  patchesZ?: number;
  /** World Z at which the ground is exactly at `waterLevel` — the waterline. */
  shoreZ?: number;
  /** How far inland the beach ramp reaches from the waterline. */
  shoreFalloff?: number;
  /** Sea level. The beach passes through this height exactly at `shoreZ`. */
  waterLevel?: number;
  /** How far the ground keeps descending past the waterline, and how deep. */
  submergedRun?: number;
  submergedDrop?: number;
  seed?: number;
}

export interface TerrainPatch {
  geometry: THREE.BufferGeometry;
  /** Patch centre, world. */
  centre: THREE.Vector3;
  bounds: THREE.Box3;
}

export class ProceduralTerrain {
  readonly bounds = new THREE.Box3();
  readonly patches: TerrainPatch[] = [];

  private readonly relief: number;
  private readonly reliefScale: number;
  private readonly shoreZ: number;
  private readonly shoreFalloff: number;
  private readonly waterLevel: number;
  private readonly submergedRun: number;
  private readonly submergedDrop: number;
  private readonly offsetX: number;
  private readonly offsetZ: number;

  constructor(options: TerrainOptions) {
    const centreX = options.centreX ?? 0;
    const centreZ = options.centreZ ?? 0;
    const cellsPerMetre = options.cellsPerMetre ?? 1.2;
    this.relief = options.relief ?? 0.55;
    this.reliefScale = options.reliefScale ?? 0.045;
    this.shoreZ = options.shoreZ ?? centreZ + options.depth / 2;
    this.shoreFalloff = options.shoreFalloff ?? 7;
    this.waterLevel = options.waterLevel ?? -0.6;
    this.submergedRun = options.submergedRun ?? 9;
    this.submergedDrop = options.submergedDrop ?? 2.2;
    // The seed just slides the noise domain — a different offset is a different
    // world, and it costs nothing.
    const seed = options.seed ?? 1;
    this.offsetX = seed * 37.19;
    this.offsetZ = seed * 91.73;

    const patchesX = options.patchesX ?? 4;
    const patchesZ = options.patchesZ ?? 2;
    const patchW = options.width / patchesX;
    const patchD = options.depth / patchesZ;
    const minX = centreX - options.width / 2;
    const minZ = centreZ - options.depth / 2;

    for (let pz = 0; pz < patchesZ; pz++) {
      for (let px = 0; px < patchesX; px++) {
        const x0 = minX + px * patchW;
        const z0 = minZ + pz * patchD;
        const patch = this.buildPatch(x0, z0, patchW, patchD, cellsPerMetre);
        this.patches.push(patch);
        this.bounds.union(patch.bounds);
      }
    }
  }

  /**
   * Land height at a world point.
   *
   * Three terms, in order of what they decide:
   *
   *   · rolling fbm relief, which is the land away from the sea;
   *   · a BEACH ramp that takes that relief down to exactly `waterLevel` at
   *     `shoreZ`, so the waterline is a property of the terrain rather than of
   *     where a water plane happens to have been cut;
   *   · a submerged run past it, descending another `submergedDrop`, so the sand
   *     carries on under the surface instead of ending at a wall. The sea is
   *     opaque, so none of that is seen — but it is what makes the beach read as
   *     going INTO the water rather than stopping at it.
   *
   * The waterline lands where the ramp crosses `waterLevel`, and the ramp is
   * steepest there (smoothstep's midpoint), which keeps the coplanar band with
   * the water plane down to a few centimetres of Z rather than a shimmering
   * stretch of sand.
   */
  heightAt(x: number, z: number): number {
    const n = gmFbm((x + this.offsetX) * this.reliefScale, (z + this.offsetZ) * this.reliefScale);
    // Second, finer octave for local lumpiness the broad one is too smooth to give.
    const n2 = gmFbm((x + this.offsetX) * this.reliefScale * 3.7, (z + this.offsetZ) * this.reliefScale * 3.7);
    const relief = (n - 0.5) * this.relief + (n2 - 0.5) * this.relief * 0.35;

    if (z <= this.shoreZ) {
      const t = smoothstep01((z - (this.shoreZ - this.shoreFalloff)) / this.shoreFalloff);
      return relief * (1 - t) + this.waterLevel * t;
    }
    const t = smoothstep01((z - this.shoreZ) / this.submergedRun);
    return this.waterLevel - this.submergedDrop * t;
  }

  /** Surface normal, by central differences. Used to keep props off steep ground. */
  slopeAt(x: number, z: number, epsilon = 0.5): number {
    const hL = this.heightAt(x - epsilon, z);
    const hR = this.heightAt(x + epsilon, z);
    const hD = this.heightAt(x, z - epsilon);
    const hU = this.heightAt(x, z + epsilon);
    const dx = (hR - hL) / (2 * epsilon);
    const dz = (hU - hD) / (2 * epsilon);
    return Math.hypot(dx, dz);
  }

  private buildPatch(x0: number, z0: number, width: number, depth: number, cellsPerMetre: number): TerrainPatch {
    const cols = Math.max(2, Math.round(width * cellsPerMetre));
    const rows = Math.max(2, Math.round(depth * cellsPerMetre));

    const geometry = new THREE.PlaneGeometry(width, depth, cols, rows);
    geometry.rotateX(-Math.PI / 2);
    // Positioned by displacing the vertices rather than by moving the mesh: the
    // blade and flower scatter, the dirt mask and the ground material all work in
    // WORLD XZ, and a mesh whose vertices already carry world coordinates keeps
    // every one of them reading the same numbers.
    geometry.translate(x0 + width / 2, 0, z0 + depth / 2);

    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      position.setY(i, this.heightAt(x, z));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    const bounds = geometry.boundingBox!.clone();
    return { geometry, centre: bounds.getCenter(new THREE.Vector3()), bounds };
  }

  dispose(): void {
    for (const patch of this.patches) patch.geometry.dispose();
  }
}

/** Seeded LCG, matching the one the vendored scatter uses. */
export function seededRandom(seed: number): () => number {
  let s = (seed * 1664525 + 1013904223) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export interface ScatterSpec {
  count: number;
  /** Minimum world distance between two placements. */
  minDistance: number;
  /** Rejection test — return true to refuse the point. */
  reject?: (x: number, z: number) => boolean;
  /** 0..1 acceptance weight; the point is kept with this probability. */
  weight?: (x: number, z: number) => number;
}

/**
 * Dart-throwing with a spatial hash — Poisson-ish placement without the bookkeeping
 * of a real Bridson sampler.
 *
 * A plain random scatter clumps, and clumping is exactly what reads as "randomly
 * placed" rather than as a wood. The minimum-distance test is what turns a spray
 * of points into something that looks grown. Attempts are capped so an impossible
 * `minDistance` returns fewer points instead of hanging.
 */
export function scatterPoints(
  area: THREE.Box3,
  spec: ScatterSpec,
  rng: () => number,
): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  const cell = Math.max(spec.minDistance, 0.001);
  const grid = new Map<string, THREE.Vector2[]>();
  const key = (x: number, z: number): string => Math.floor(x / cell) + ',' + Math.floor(z / cell);

  const minSq = spec.minDistance * spec.minDistance;
  const maxAttempts = spec.count * 40;
  let attempts = 0;

  while (points.length < spec.count && attempts < maxAttempts) {
    attempts++;
    const x = area.min.x + rng() * (area.max.x - area.min.x);
    const z = area.min.z + rng() * (area.max.z - area.min.z);

    if (spec.reject?.(x, z)) continue;
    if (spec.weight && rng() > spec.weight(x, z)) continue;

    let tooClose = false;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let dz = -1; dz <= 1 && !tooClose; dz++) {
      for (let dx = -1; dx <= 1 && !tooClose; dx++) {
        const bucket = grid.get(cx + dx + ',' + (cz + dz));
        if (!bucket) continue;
        for (const p of bucket) {
          if ((p.x - x) ** 2 + (p.y - z) ** 2 < minSq) {
            tooClose = true;
            break;
          }
        }
      }
    }
    if (tooClose) continue;

    const point = new THREE.Vector2(x, z);
    points.push(point);
    const k = key(x, z);
    const bucket = grid.get(k);
    if (bucket) bucket.push(point);
    else grid.set(k, [point]);
  }

  return points;
}
