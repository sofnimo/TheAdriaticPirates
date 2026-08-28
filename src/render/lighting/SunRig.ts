import * as THREE from 'three';
import { TIME_OF_DAY, type TimeOfDayName } from '../../art/timeOfDay';
import { applyTimeOfDayUniforms, globalUniforms, sunDirectionFrom } from '../shading/ShadingUniforms';
import { ShadowCascades, type ShadowCascadeOptions } from './ShadowCascades';

/**
 * ONE SUN. `04 — Light and Shadow.md` §1: one directional shadow-casting light, no area
 * lights, no GI, no reflection probes.
 *
 * There is deliberately NO THREE.HemisphereLight here. 04 §1 recommends one for fake GI,
 * but the gouache chunk overwrites `outgoingLight` wholesale, so a hemisphere light would
 * contribute nothing and quietly mislead anyone reading the rig. The fill it stands for is
 * applied inside the chunk instead, as a flat band tint (see art/timeOfDay.ts) — a smooth
 * N.y gradient would un-flatten the very bands rule 1 exists to produce.
 *
 * THE SUN ITSELF DOES NOT CAST. Shadow casting belongs entirely to `ShadowCascades`, which this
 * class owns and drives: 04 §3.1 needs several frustums to cover a 200-1500 m camera, and one
 * light cannot have several. Leaving `castShadow` on here as well would render a fourth depth
 * map that nothing samples, and would change `NUM_DIR_LIGHT_SHADOWS` under the props' feet.
 *
 * What stays here is the LOOK of the light — colour, intensity, direction, time of day — and
 * the guarantee that the cascades are fitted along the same vector the shading terminator uses,
 * so the lit side of a hill and the shadow it throws can never disagree.
 */

export interface SunRigOptions {
  readonly cascades?: ShadowCascadeOptions;
}

export class SunRig {
  readonly light: THREE.DirectionalLight;
  readonly target: THREE.Object3D;
  readonly shadows: ShadowCascades;
  private preset: TimeOfDayName = 'lateMorning';
  private elevation = 50;
  private azimuth = 135;

  constructor(scene: THREE.Scene, options: SunRigOptions = {}) {
    this.light = new THREE.DirectionalLight(0xfff3dd, 2.0);
    // See the header: the cascades own every depth map in the world.
    this.light.castShadow = false;

    this.target = new THREE.Object3D();
    scene.add(this.target);
    this.light.target = this.target;
    scene.add(this.light);

    this.shadows = new ShadowCascades(scene, options.cascades ?? {});

    this.apply('lateMorning');
  }

  get presetName(): TimeOfDayName {
    return this.preset;
  }

  get elevationDeg(): number {
    return this.elevation;
  }

  get azimuthDeg(): number {
    return this.azimuth;
  }

  /**
   * Point the sun without changing what time of day it is.
   *
   * Colour, intensity and the band tints stay on whatever preset is loaded; only the bearing
   * moves. That split is what makes this useful for looking at shadows: the whole point of
   * dragging the sun around is to watch where the shadows go, and a control that also swung
   * the palette from morning to dusk while you did it would be changing two things at once.
   *
   * Everything downstream follows from the one shared uniform. The sky's own disc, the shading
   * terminator on every surface, and the cascade fit all read `uSunDirection`, so they cannot
   * disagree about where the sun is — the disc in the sky IS the direction the shadows fall.
   */
  setAngles(elevationDeg: number, azimuthDeg: number): void {
    this.elevation = elevationDeg;
    this.azimuth = azimuthDeg;
    const dir = sunDirectionFrom(elevationDeg, azimuthDeg);
    this.light.position.copy(dir).multiplyScalar(1000);
    globalUniforms.uSunDirection.value.copy(dir);
  }

  /** Apply a time-of-day preset to the light AND the shared uniforms, together. */
  apply(name: TimeOfDayName): void {
    this.preset = name;
    const p = TIME_OF_DAY[name];

    this.elevation = p.sun.elevationDeg;
    this.azimuth = p.sun.azimuthDeg;
    const dir = sunDirectionFrom(p.sun.elevationDeg, p.sun.azimuthDeg);
    this.light.position.copy(dir).multiplyScalar(1000);
    this.light.color.set(p.sun.color);
    this.light.intensity = p.sun.intensity;

    // 04 §1's overcast bora row: "shadow-casting on the directional light can be disabled...
    // the bora look is flat stepped bands with no cast shadow". The preset says so; the rig
    // does not decide it.
    this.shadows.setEnabled(p.sun.castShadow);

    // The shared uniform is the same vector the light uses — one source of truth, so the
    // sky's sun disc, the shading terminator and the cast shadow can never disagree.
    globalUniforms.uSunDirection.value.copy(dir);
    applyTimeOfDayUniforms(name);
  }

  /**
   * Refit the cascades. Call once per frame, before rendering.
   *
   * Driven by the CAMERA rather than by a point of interest: §3.1's whole argument is that the
   * shadow frustums should follow the view, because that is what decides which ground is on
   * screen and at what texel density it needs to be shadowed.
   */
  update(camera: THREE.PerspectiveCamera): void {
    this.shadows.update(camera, globalUniforms.uSunDirection.value);
  }
}
