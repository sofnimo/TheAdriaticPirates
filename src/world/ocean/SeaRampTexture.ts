import * as THREE from 'three';
import { SEA_RAMP, type RampStop } from '../../art/seaRamp';

/**
 * Bakes the sampled depth stops into a 1-D lookup texture.
 *
 * A LUT rather than a chain of `mix()` calls in GLSL for three reasons: the stops are
 * unevenly spaced in `t` (dense through the shelf event, sparse in open water) which is
 * awkward to express as nested mixes; hardware LINEAR filtering gives exact continuity
 * between stops for free, which is the property this whole rework is about; and the ramp
 * stays data, so re-sampling a reference frame is a table edit, not a shader edit.
 *
 * 256 entries so that adjacent screen pixels can never land more than 1/255 apart on an
 * 8-bit ramp — the smoothness gate measures exactly that, and a coarser LUT would show its
 * own interpolation kinks as false plateaus.
 */
const LUT_SIZE = 256;

export function buildSeaRampTexture(stops: readonly RampStop[] = SEA_RAMP): THREE.DataTexture {
  const data = new Uint8Array(LUT_SIZE * 4);

  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const [r, g, b] = sampleRamp(stops, t);
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, LUT_SIZE, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // The stops were sampled off sRGB frames, so they are sRGB. Tagging it lets the GPU decode
  // to linear on fetch, which is the space the ocean shader works in; `colorspace_fragment`
  // encodes back on the way out. Getting this wrong is invisible on a single flat colour and
  // very visible across a ramp, which is why it is stated rather than assumed.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Piecewise-linear interpolation between stops, in sRGB bytes. Exported for the gate. */
export function sampleRamp(stops: readonly RampStop[], t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  if (c <= stops[0]!.t) return unpack(stops[0]!.hex);
  const last = stops[stops.length - 1]!;
  if (c >= last.t) return unpack(last.hex);

  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i]!;
    if (c > hi.t) continue;
    const lo = stops[i - 1]!;
    const f = (c - lo.t) / (hi.t - lo.t);
    const a = unpack(lo.hex);
    const b = unpack(hi.hex);
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ];
  }
  return unpack(last.hex);
}

function unpack(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}
