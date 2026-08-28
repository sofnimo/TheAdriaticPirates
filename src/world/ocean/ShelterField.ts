import * as THREE from 'three';
import type { IslandField } from '../island/IslandField';

/**
 * THE FETCH FIELD — how much open water the swell crossed to reach each point.
 *
 * `art/seaRamp.ts` has been carrying the note "depth is the stand-in for shelter until Step 4
 * brings a fetch/wind field" since the sea ramp was written. This is that field.
 *
 * WHAT IT MEASURES. Fetch is the distance a wave has run unobstructed. Stand in the lee of an
 * island and the swell arriving at you has just been stopped by several hundred metres of
 * limestone; there is nothing left to arrive. So for every water texel this marches UPWIND —
 * back along the swell's own bearing, toward where it came from — and asks how far it gets
 * before hitting land. A long run means open sea and full waves; a short one means the island
 * is in the way and the water goes glassy.
 *
 * WHY IT IS BAKED AND COARSE. The answer changes over hundreds of metres, never over five, so
 * a 32 m grid holds it exactly as well as the elevation field would and bakes in a few
 * milliseconds instead of a few seconds. That matters because the swell heading is a slider:
 * turn it and this has to be rebuilt, so the bake has to be cheap enough to sit inside a
 * drag's `onFinishChange` without the frame hitching.
 *
 * ONE FIELD, THREE READERS. The ocean material scales its wave amplitude by it, the glints
 * thin out over it, and `WaveSurface` floats the hull on it. Same rule as the wave stack and
 * the wave clock: they read one array rather than three approximations of it, or the aircraft
 * ends up bobbing in water the shader is drawing flat.
 */

export interface ShelterFieldOptions {
  /** Samples per side. 32 m at the default 8 km tile — see the header on why coarse. */
  readonly resolution?: number;
  /**
   * Metres of unobstructed upwind run needed for a fully developed sea.
   *
   * Not a physical fetch length — a real one is kilometres. This is the distance over which
   * the lee of an island recovers, which is set by how far the swell needs to bend in behind
   * the obstruction, and that is comparable to the obstruction's own width.
   */
  readonly fullFetch?: number;
}

/** Half-angle of the arrival fan, radians. About twenty degrees either side of the mean. */
const SPREAD_RAD = 0.35;

export class ShelterField {
  readonly resolution: number;
  fullFetch: number;
  readonly worldSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly metresPerSample: number;

  /** 0 = fully sheltered, 1 = open sea. Read by the hull; uploaded for the shader. */
  readonly exposure: Float32Array;
  readonly texture: THREE.DataTexture;

  private readonly island: IslandField;

  constructor(island: IslandField, options: ShelterFieldOptions = {}) {
    this.island = island;
    this.resolution = options.resolution ?? 256;
    this.fullFetch = options.fullFetch ?? 1400;
    this.worldSize = island.worldSize;
    this.originX = island.originX;
    this.originZ = island.originZ;
    this.metresPerSample = this.worldSize / this.resolution;

    const n = this.resolution;
    this.exposure = new Float32Array(n * n);

    this.texture = new THREE.DataTexture(
      new Uint8Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    // Linear, deliberately: this is a smooth scalar and the whole point is that the water
    // eases out of shelter rather than stepping out of it at a texel boundary.
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;

    this.bake(0, 1);
  }

  /**
   * March upwind from every texel and record how far the swell ran before land stopped it.
   *
   * @param dirX swell TRAVEL direction, unit XZ. Upwind is the other way.
   * @param dirZ
   */
  bake(dirX: number, dirZ: number): void {
    const n = this.resolution;
    const mps = this.metresPerSample;
    const len = Math.hypot(dirX, dirZ) || 1;
    // Upwind: back toward where the swell came from.
    const bx = -dirX / len;
    const bz = -dirZ / len;

    // ARRIVAL BEARINGS, not one. Real swell reaches a point across a spread of directions, so
    // a place just past the end of a headland is shadowed for part of that spread even though
    // the centre bearing runs clear past the rock. Taking the SHORTEST fetch over the fan is
    // what widens a wind shadow around the tips of an island, which is exactly where the last
    // of the lee foam was surviving — on a single bearing those points read as open sea,
    // because along that one line they are.
    const bearings: Array<[number, number]> = [];
    for (const a of [-SPREAD_RAD, 0, SPREAD_RAD]) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      bearings.push([bx * c - bz * s, bx * s + bz * c]);
    }

    // One sample per grid cell along the ray. Finer buys nothing — the land mask it is asking
    // about is itself only resolved to a few metres, and the answer is a distance in hundreds.
    const step = mps;
    const maxSteps = Math.ceil(this.fullFetch / step);

    for (let iz = 0; iz < n; iz++) {
      const z0 = this.originZ + iz * mps;
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const x0 = this.originX + ix * mps;

        // LAND IS MARCHED TOO, and that is not a detail.
        //
        // Land has no sea state of its own, so the first version simply stamped it as fully
        // exposed. That is a constant, and this texture is sampled bilinearly on a 32 m grid —
        // so every shoreline texel dragged "open sea" into the water beside it, on BOTH sides
        // of an island. The innermost thirty metres of the surf band is exactly where that
        // bleed lands, so the lee of an island grew a rim of foam around a shore the swell
        // never reaches.
        //
        // Marching land like anything else makes the value continuous across the coastline in
        // the right direction: a texel on the windward shore marches out to open sea and reads
        // exposed, matching the water in front of it; one on the lee marches straight into the
        // island behind it and reads sheltered, matching the water there. Nothing to bleed.
        // THE RAY HAS WIDTH, and without it the shadows leak.
        //
        // A zero-width ray stepping 32 m at a time slips past anything narrow or obliquely
        // presented — a spit, a headland the march grazes, the tapering end of an island — and
        // the water behind comes back reading as open sea. That put foam on lee shores which
        // no amount of raising the exposure threshold could remove, because the field was not
        // reporting weak shelter there, it was reporting none.
        //
        // Testing a lateral offset either side closes it, and is the better physics anyway:
        // swell is stopped by an obstruction of some width, not by a mathematical line, and it
        // spreads as it passes one. The width grows with distance for the same reason.
        let fetch = this.fullFetch;
        for (const [ux, uz] of bearings) {
          for (let s = 1; s <= maxSteps; s++) {
            const d = s * step;
            if (d >= fetch) break;
            const width = step * 0.5 + d * 0.08;
            for (let k = -1; k <= 1; k++) {
              if (this.island.isLand(x0 + ux * d - uz * width * k, z0 + uz * d + ux * width * k)) {
                fetch = d;
                break;
              }
            }
            if (fetch === d) break;
          }
        }

        // Smooth, so the edge of a wind shadow is a gradient rather than a line drawn on the
        // sea. Squared because recovery is slow at first — just behind the island there is
        // almost nothing, and the sea builds as the run lengthens.
        const t = Math.min(1, fetch / this.fullFetch);
        this.exposure[i] = t * t;
      }
    }

    this.upload();
  }

  /** 0-1 exposure at a world point, bilinear. What the hull reads. */
  exposureAt(x: number, z: number): number {
    const n = this.resolution;
    const fx = (x - this.originX) / this.metresPerSample;
    const fz = (z - this.originZ) / this.metresPerSample;
    const x0 = Math.max(0, Math.min(n - 1, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(n - 1, Math.floor(fz)));
    const x1 = Math.min(n - 1, x0 + 1);
    const z1 = Math.min(n - 1, z0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const tz = Math.max(0, Math.min(1, fz - z0));
    const a = this.exposure[z0 * n + x0]!;
    const b = this.exposure[z0 * n + x1]!;
    const c = this.exposure[z1 * n + x0]!;
    const d = this.exposure[z1 * n + x1]!;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  private upload(): void {
    const data = this.texture.image.data as Uint8Array;
    for (let i = 0; i < this.exposure.length; i++) {
      const v = Math.round(Math.max(0, Math.min(1, this.exposure[i]!)) * 255);
      data[i * 4 + 0] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
