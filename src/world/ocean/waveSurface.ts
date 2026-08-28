import { SEA_STATES, waveDirection, type SeaStateName } from '../../art/seaStates';

/**
 * THE SEA SURFACE, ON THE CPU.
 *
 * `gerstner.glsl` transcribed line for line, because the hull has to float on the water the
 * player can SEE. A separate approximation — even a good one — puts the aircraft a few
 * centimetres out of the surface at the exact moment the camera is closest to it, which on a
 * flat-shaded gouache ocean reads immediately as the hull hovering or as the sea cutting
 * through it.
 *
 * The same four waves, the same steepness clamp, the same clock. `Ocean.update` feeds the
 * shader `uWaveTime = elapsed`; `WaveSurface.time` is set from the same number.
 *
 * GERSTNER IS NOT A HEIGHTFIELD. A point's displacement moves it horizontally as well as
 * vertically, so `heightAt(x, z)` is asking which SOURCE point ends up over `(x, z)` — an
 * inverse problem. Two fixed-point iterations solve it to well under the amplitude of the
 * waves anyone can see at hull scale, which is all the buoyancy probes need.
 */

const G = 9.8;

interface Wave {
  dx: number;
  dz: number;
  k: number;
  omega: number;
  amplitude: number;
  /** The GPU Gems steepness clamp, already divided through. */
  q: number;
}

export class WaveSurface {
  /** Seconds. Must be the same value the ocean material's `uWaveTime` is holding. */
  time = 0;

  /**
   * The same fetch field the shader scales its waves by, or null for open sea everywhere.
   *
   * Without it the hull rides a full sea inside a cove the shader is drawing flat — and that
   * is not a cosmetic mismatch. A sheltered anchorage is the one place a seaplane can actually
   * work (03 §4.3), so the calm has to be real to the physics, not just painted.
   */
  shelter: { exposureAt(x: number, z: number): number } | null = null;
  /** Matches the shader's `uShelterMin`: what is left of the waves in the deepest lee. */
  shelterMin = 0;

  private waves: Wave[] = [];

  constructor(state: SeaStateName) {
    this.setState(state);
  }

  /**
   * Rotation applied to the stack, in degrees. MUST match the ocean material's.
   *
   * The hull floats on this and the shader draws from `uWaves`; they are two readers of one
   * wave stack, and the scene keeps them equal by assignment for exactly the same reason it
   * assigns one wave clock to both. Let the two headings drift apart and the aircraft rides a
   * swell running at an angle to the one on screen — the failure would look like bad physics
   * rather than like a missing assignment, which is what makes it worth naming here.
   */
  setState(name: SeaStateName, headingOffsetDeg = 0): void {
    this.waves = SEA_STATES[name].waves.map((w) => {
      const [dx, dz] = waveDirection(w.directionDeg + headingOffsetDeg);
      const k = (Math.PI * 2) / Math.max(w.wavelength, 0.001);
      return {
        dx,
        dz,
        k,
        omega: Math.sqrt(G * k),
        amplitude: w.amplitude,
        q: w.steepness / Math.max(k * w.amplitude * 4, 1e-4),
      };
    });
  }

  /** Displacement of the source point at `(x, z)` — the shader's `gerstnerOffset`. */
  private offset(x: number, z: number, out: { x: number; y: number; z: number }): void {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    for (const w of this.waves) {
      const phase = w.k * (w.dx * x + w.dz * z) + w.omega * this.time;
      const c = Math.cos(phase);
      out.x += w.q * w.amplitude * w.dx * c;
      out.z += w.q * w.amplitude * w.dz * c;
      out.y += w.amplitude * Math.sin(phase);
    }
    // Scaled on the accumulated offset, not per wave, for the same reason `gerstner.glsl`
    // does it that way: `q` carries `1 / amplitude`, so scaling each wave's amplitude would
    // leave the horizontal term untouched and the hull would still slide about in flat water.
    if (this.shelter) {
      const s = this.shelterMin + (1 - this.shelterMin) * this.shelter.exposureAt(x, z);
      out.x *= s;
      out.y *= s;
      out.z *= s;
    }
  }

  /** Sea level in metres at a world XZ, with the horizontal displacement inverted out. */
  heightAt(x: number, z: number): number {
    const o = { x: 0, y: 0, z: 0 };
    let sx = x;
    let sz = z;
    for (let i = 0; i < 2; i++) {
      this.offset(sx, sz, o);
      sx = x - o.x;
      sz = z - o.z;
    }
    this.offset(sx, sz, o);
    return o.y;
  }

  /** Surface normal, for the hull's righting moment and for spray direction. */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }): void {
    let dx = 0;
    let dz = 0;
    let dy = 0;
    for (const w of this.waves) {
      const phase = w.k * (w.dx * x + w.dz * z) + w.omega * this.time;
      const wa = w.k * w.amplitude;
      dx += w.dx * wa * Math.cos(phase);
      dz += w.dz * wa * Math.cos(phase);
      dy += w.q * wa * Math.sin(phase);
    }
    const nx = -dx;
    const ny = 1 - dy;
    const nz = -dz;
    const len = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / len;
    out.y = ny / len;
    out.z = nz / len;
  }
}
