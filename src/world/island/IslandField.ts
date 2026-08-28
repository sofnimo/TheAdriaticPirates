import * as THREE from 'three';
import { clamp01, smoothstep } from './noise';
import { Spine } from './Spine';
import {
  BEACH_WIDTH_MAX, CHANNEL_FLOOR, SHELF_REACH, buildFeatures, sampleTerrain,
  type FeatureSet, type TerrainSample,
} from './topography';
import type { IslandSpec } from './IslandSpec';

export { BEACH_WIDTH_MAX };

/**
 * THE RASTER PASS — one signed elevation over the whole map tile, baked once.
 *
 * ONE ARRAY, MANY READERS. The terrain mesh, the bathymetry, the shore atlas, the cover masks
 * and the aircraft's altimeter all read `height`. Giving any of them its own copy is how a
 * coastline ends up in two places at once, so there is exactly one and it is here.
 *
 * The land mask is DERIVED from the elevation (`height > 0`), never decided beside it. That is
 * what lets a doline breached by the sea become a harbour and a cut-through saddle become a
 * channel without either being special-cased: they are simply places where the composited
 * surface came out below zero.
 *
 * The compositor is a max over islands. Land wins over sea because it is higher; where two
 * shelves overlap, the shallower one wins, which is the correct answer for a strait between
 * two islands and costs nothing.
 */

export interface IslandFieldOptions {
  readonly resolution?: number;
  readonly worldSize?: number;
  readonly originX?: number;
  readonly originZ?: number;
}

export interface IslandBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * §5.2's talus angle, set at the top of its 60-65 degree "cliff guard" band.
 *
 * Not a soil angle of repose — the doc gives 30-38 degrees for scree and then says explicitly
 * to RAISE the threshold on the cliffed flank so the pass removes numerical spikes without
 * softening the sheer faces the art direction wants. 65 degrees is steeper than any real sea
 * cliff this generator authors, so anything the pass touches was an artefact.
 */
const TALUS_DEGREES = 65;
/** Gauss-Seidel sweeps. A handful, per §5.2; alternating direction, so few are needed. */
const TALUS_PASSES = 6;
/** Metres of the coarse max-height grid the back-cliff channel is measured on. */
const COARSE_METRES = 64;

interface Entry {
  readonly spec: IslandSpec;
  readonly spine: Spine;
  readonly features: FeatureSet;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export class IslandField {
  /** The hero island's descriptor. Cameras and probes normalise against it. */
  readonly spec: IslandSpec;
  readonly specs: readonly IslandSpec[];
  readonly resolution: number;
  readonly worldSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly metresPerSample: number;

  /** Signed elevation in metres. Positive above sea level, negative below it. */
  readonly height: Float32Array;
  /** 1 where land, 0 where sea. Read off `height`, never decided separately. */
  readonly land: Uint8Array;
  /** §3.5's exposure scalar: +1 fully windward, -1 fully sheltered. */
  readonly exposure: Float32Array;
  /** 0-1 how far the sand runs up the land here. */
  readonly sandReach: Float32Array;
  /** Metres of deposited beach, shore-normal. */
  readonly beachWidth: Float32Array;
  /** 0-1 how abruptly the ground rises out of the water. 1 is sheer. */
  readonly cliffiness: Float32Array;
  /** 0-1 high ground standing behind the beach rather than at the waterline. */
  readonly backCliff: Float32Array;
  /** Which island owns each texel, -1 for open water. The gates measure ONE island. */
  readonly owner: Int16Array;

  /** R = sand reach, G = cliffiness, B = back-cliff, A = beach width / BEACH_WIDTH_MAX. */
  readonly characterTexture: THREE.DataTexture;
  readonly characterResolution: number;

  /** The hero's skeleton, kept so downstream systems can reason in island space. */
  readonly spine: Spine;
  readonly features: FeatureSet;
  readonly spineLength: number;

  /** Each island's land bounding box in layout order, or null if it drowned. */
  readonly islandBounds: (IslandBounds | null)[] = [];

  /** The highest point in the tile, for camera framing. */
  readonly summit: { x: number; z: number; height: number } = { x: 0, z: 0, height: 0 };

  private readonly islands: Entry[];

  constructor(specs: IslandSpec | readonly IslandSpec[], options: IslandFieldOptions = {}) {
    const list = Array.isArray(specs) ? (specs as IslandSpec[]) : [specs as IslandSpec];
    this.specs = list;
    this.spec = list[0]!;
    this.resolution = options.resolution ?? 1024;
    this.worldSize = options.worldSize ?? 8192;
    this.originX = options.originX ?? -this.worldSize / 2;
    this.originZ = options.originZ ?? -this.worldSize / 2;
    this.metresPerSample = this.worldSize / this.resolution;

    const n = this.resolution;
    const count = n * n;
    // The floor every shelf resolves to at `SHELF_REACH`, so the composite is continuous
    // across each island's affect box rather than stepping at its edge.
    this.height = new Float32Array(count).fill(-CHANNEL_FLOOR);
    this.land = new Uint8Array(count);
    this.exposure = new Float32Array(count);
    this.sandReach = new Float32Array(count);
    this.beachWidth = new Float32Array(count);
    this.cliffiness = new Float32Array(count);
    this.backCliff = new Float32Array(count);
    this.owner = new Int16Array(count).fill(-1);

    // §13.3: the non-local pass runs once per island, before any texel is touched.
    this.islands = list.map((s) => {
      const spine = new Spine(s);
      const reach = Math.max(s.halfWidthWindward, s.halfWidthLeeward) + s.coastWarpAmp + SHELF_REACH;
      return {
        spec: s,
        spine,
        features: buildFeatures(s, spine),
        minX: spine.minX - reach,
        maxX: spine.maxX + reach,
        minZ: spine.minZ - reach,
        maxZ: spine.maxZ + reach,
      };
    });
    this.spine = this.islands[0]!.spine;
    this.features = this.islands[0]!.features;
    this.spineLength = this.spine.length;

    this.characterResolution = Math.max(64, Math.floor(this.resolution / 2));
    const m = this.characterResolution;
    this.characterTexture = new THREE.DataTexture(
      new Uint8Array(m * m * 4), m, m, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    this.characterTexture.minFilter = THREE.LinearFilter;
    this.characterTexture.magFilter = THREE.LinearFilter;
    this.characterTexture.generateMipmaps = false;
    this.characterTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.characterTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.characterTexture.colorSpace = THREE.NoColorSpace;

    this.raster();
    this.relaxTalus();
    this.measureBounds();
    this.measureBackCliff();
    this.bakeCharacter();
  }

  private raster(): void {
    const n = this.resolution;
    const mps = this.metresPerSample;
    const sample: TerrainSample = {
      height: 0, exposure: 0, cliffiness: 0, sandReach: 0, beachWidth: 0, inland: 0,
    };

    for (let k = 0; k < this.islands.length; k++) {
      const island = this.islands[k]!;
      const ix0 = Math.max(0, Math.floor((island.minX - this.originX) / mps));
      const ix1 = Math.min(n - 1, Math.ceil((island.maxX - this.originX) / mps));
      const iz0 = Math.max(0, Math.floor((island.minZ - this.originZ) / mps));
      const iz1 = Math.min(n - 1, Math.ceil((island.maxZ - this.originZ) / mps));

      for (let iz = iz0; iz <= iz1; iz++) {
        const z = this.originZ + iz * mps;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = this.originX + ix * mps;
          sampleTerrain(island.spec, island.spine, island.features, x, z, sample);
          const i = iz * n + ix;
          if (sample.height <= this.height[i]!) continue;
          this.height[i] = sample.height;
          this.exposure[i] = sample.exposure;
          this.cliffiness[i] = sample.cliffiness;
          this.sandReach[i] = sample.sandReach;
          this.beachWidth[i] = sample.beachWidth;
          this.owner[i] = k;
        }
      }
    }

    for (let i = 0; i < this.height.length; i++) this.land[i] = this.height[i]! > 0 ? 1 : 0;
  }

  /**
   * §5.2's THERMAL EROSION, run purely as the cliff guard the doc describes.
   *
   * "Set talus to your maximum allowed steepness... so it only sands off numerical spikes
   * without softening intentional cliffs." That is exactly the job here. The talus angle is
   * `TALUS_DEGREES`, at the top of §5.2's 60-65 degree cliff-guard band, so a genuine sea
   * cliff is left alone and only geometry steeper than any real cliff is touched.
   *
   * WHY A FIELD PASS AND NOT MORE CARE IN THE SAMPLER. The over-steep places do not come from
   * one mistake with one fix. `inland` is `halfWidth - dist`, which is only an approximate
   * signed distance: wherever the half-width varies along the coast its gradient is not 1 but
   * `1 + |d halfWidth / ds|`, so a profile authored at a legitimate 3 m per metre arrives on
   * the grid at 15. Cut edges, doline rims and the taper at a terminus each compound it
   * differently. Normalising every one of them at sample time means finite-differencing the
   * mask in the inner loop; one relaxation pass over the baked grid answers all of them at
   * once, costs a few milliseconds, and is what the spec asked for in the first place.
   *
   * Gauss-Seidel in place, alternating sweep direction so the relaxation does not drift down
   * one diagonal.
   *
   * IT RUNS UNDERWATER TOO, AND IT NEVER MOVES A TEXEL ACROSS THE WATERLINE. The shelf is
   * smooth by construction, so the pass has nothing to do on it — a metre and a half per texel
   * against an eleven metre threshold. But a deep transverse cut carves a channel whose walls
   * are as steep as any cliff, and those are underwater; skipping the seabed left 80 degree
   * submarine walls in exactly the places the doc's guard exists to catch. What the seabed
   * must not do is change SIGN: the land mask, the bathymetry and the shore atlas have all
   * agreed on one coastline by this point, so each exchange is clamped to leave both texels on
   * the side of zero they started on.
   */
  private relaxTalus(): void {
    const n = this.resolution;
    const maxStep = Math.tan((TALUS_DEGREES * Math.PI) / 180) * this.metresPerSample;
    const h = this.height;

    for (let pass = 0; pass < TALUS_PASSES; pass++) {
      const forward = pass % 2 === 0;
      const z0 = forward ? 1 : n - 2;
      const zEnd = forward ? n - 1 : 0;
      const dz = forward ? 1 : -1;
      for (let iz = z0; iz !== zEnd; iz += dz) {
        const x0 = forward ? 1 : n - 2;
        const xEnd = forward ? n - 1 : 0;
        const dx = forward ? 1 : -1;
        for (let ix = x0; ix !== xEnd; ix += dx) {
          const i = iz * n + ix;
          for (let k = 0; k < 4; k++) {
            const j = k === 0 ? i - 1 : k === 1 ? i + 1 : k === 2 ? i - n : i + n;
            const drop = h[i]! - h[j]!;
            if (drop <= maxStep) continue;
            // Half the excess, the standard under-relaxation: moving all of it makes the pair
            // oscillate against each other across successive sweeps.
            let move = (drop - maxStep) * 0.5;
            // Neither end may cross zero. The margin keeps a texel that is only just land from
            // being planed down to exactly sea level, where a rounding error decides the mask.
            if (h[i]! > 0) move = Math.min(move, h[i]! * 0.9);
            if (h[j]! < 0) move = Math.min(move, -h[j]! * 0.9);
            if (move <= 0) continue;
            h[i] = h[i]! - move;
            h[j] = h[j]! + move;
          }
        }
      }
    }
  }

  private measureBounds(): void {
    const n = this.resolution;
    const mps = this.metresPerSample;
    const boxes = this.islands.map(() => ({
      minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
    }));
    let best = -Infinity;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        if (this.land[i] !== 1) continue;
        const x = this.originX + ix * mps;
        const z = this.originZ + iz * mps;
        const b = boxes[this.owner[i]!];
        if (b) {
          if (x < b.minX) b.minX = x;
          if (x > b.maxX) b.maxX = x;
          if (z < b.minZ) b.minZ = z;
          if (z > b.maxZ) b.maxZ = z;
        }
        if (this.height[i]! > best) {
          best = this.height[i]!;
          this.summit.x = x;
          this.summit.z = z;
          this.summit.height = this.height[i]!;
        }
      }
    }
    for (const b of boxes) {
      this.islandBounds.push(Number.isFinite(b.minX) ? b : null);
    }
  }

  /**
   * "Is there high ground standing behind this beach?"
   *
   * Measured off a coarse max-height grid rather than a per-texel neighbourhood search: the
   * question is about a hillside, the answer changes over tens of metres, and a 64 m grid
   * answers it for the cost of one extra pass instead of a 27-tap filter over two million
   * texels.
   */
  private measureBackCliff(): void {
    const n = this.resolution;
    const mps = this.metresPerSample;
    const stride = Math.max(1, Math.round(COARSE_METRES / mps));
    const cn = Math.ceil(n / stride);
    const coarse = new Float32Array(cn * cn).fill(-Infinity);
    for (let iz = 0; iz < n; iz++) {
      const cz = Math.min(cn - 1, (iz / stride) | 0);
      for (let ix = 0; ix < n; ix++) {
        const c = cz * cn + Math.min(cn - 1, (ix / stride) | 0);
        const h = this.height[iz * n + ix]!;
        if (h > coarse[c]!) coarse[c] = h;
      }
    }
    for (let iz = 0; iz < n; iz++) {
      const cz = Math.min(cn - 1, (iz / stride) | 0);
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        if (this.sandReach[i]! <= 0) continue;
        const cx = Math.min(cn - 1, (ix / stride) | 0);
        let peak = -Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = coarse[Math.min(cn - 1, Math.max(0, cz + dz)) * cn + Math.min(cn - 1, Math.max(0, cx + dx))]!;
            if (v > peak) peak = v;
          }
        }
        this.backCliff[i] = this.sandReach[i]! * smoothstep(14, 55, peak);
      }
    }
  }

  private bakeCharacter(): void {
    const m = this.characterResolution;
    const n = this.resolution;
    const data = this.characterTexture.image.data as Uint8Array;
    const scale = n / m;
    for (let jz = 0; jz < m; jz++) {
      const iz = Math.min(n - 1, Math.round(jz * scale));
      for (let jx = 0; jx < m; jx++) {
        const ix = Math.min(n - 1, Math.round(jx * scale));
        const i = iz * n + ix;
        const o = (jz * m + jx) * 4;
        data[o + 0] = Math.round(clamp01(this.sandReach[i]!) * 255);
        data[o + 1] = Math.round(clamp01(this.cliffiness[i]!) * 255);
        data[o + 2] = Math.round(clamp01(this.backCliff[i]!) * 255);
        data[o + 3] = Math.round(clamp01(this.beachWidth[i]! / BEACH_WIDTH_MAX) * 255);
      }
    }
    this.characterTexture.needsUpdate = true;
  }

  private index(x: number, z: number): number {
    const ix = Math.max(0, Math.min(this.resolution - 1, Math.round((x - this.originX) / this.metresPerSample)));
    const iz = Math.max(0, Math.min(this.resolution - 1, Math.round((z - this.originZ) / this.metresPerSample)));
    return iz * this.resolution + ix;
  }

  /** Bilinear elevation lookup in world space. */
  heightAt(x: number, z: number): number {
    const fx = (x - this.originX) / this.metresPerSample;
    const fz = (z - this.originZ) / this.metresPerSample;
    const x0 = Math.max(0, Math.min(this.resolution - 1, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(this.resolution - 1, Math.floor(fz)));
    const x1 = Math.min(this.resolution - 1, x0 + 1);
    const z1 = Math.min(this.resolution - 1, z0 + 1);
    const tx = clamp01(fx - x0);
    const tz = clamp01(fz - z0);
    const r = this.resolution;
    const h00 = this.height[z0 * r + x0]!;
    const h10 = this.height[z0 * r + x1]!;
    const h01 = this.height[z1 * r + x0]!;
    const h11 = this.height[z1 * r + x1]!;
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  isLand(x: number, z: number): boolean {
    return this.land[this.index(x, z)] === 1;
  }

  /** Which island owns this point, -1 for open water. Layout order, as `specs`. */
  ownerAt(x: number, z: number): number {
    return this.owner[this.index(x, z)]!;
  }
}
