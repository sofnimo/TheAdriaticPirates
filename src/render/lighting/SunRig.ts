import * as THREE from 'three';
import { LIGHT } from '../../art/budgets';
import { TIME_OF_DAY, type TimeOfDayName } from '../../art/timeOfDay';
import { applyTimeOfDayUniforms, globalUniforms, sunDirectionFrom } from '../shading/ShadingUniforms';

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
 * Shadow settings target HARD edges (00 §3 rule 3): near-zero radius, tight frustum,
 * tiny bias. Cascades arrive in Step 5 via three/addons/csm.
 */

export interface SunRigOptions {
  /** Half-extent of the shadow frustum, world units. Keep tight: a wide near/far is the
   *  #1 cause of both peter-panning and acne (04 §3.2). */
  shadowExtent?: number;
  shadowMapSize?: number;
  /** Distance the light is placed along its direction. Only affects the shadow camera. */
  distance?: number;
}

export class SunRig {
  readonly light: THREE.DirectionalLight;
  readonly target: THREE.Object3D;
  private preset: TimeOfDayName = 'lateMorning';
  private readonly distance: number;

  constructor(scene: THREE.Scene, options: SunRigOptions = {}) {
    const shadowExtent = options.shadowExtent ?? 40;
    const shadowMapSize = options.shadowMapSize ?? 2048;
    this.distance = options.distance ?? 200;

    this.light = new THREE.DirectionalLight(0xfff3dd, 2.0);
    this.light.castShadow = true;

    const shadow = this.light.shadow;
    shadow.mapSize.set(shadowMapSize, shadowMapSize);
    shadow.radius = LIGHT.shadowRadiusRange[0]; // 0 — hard edge, not a penumbra
    shadow.bias = LIGHT.shadowBiasRange[0]; // -0.0005
    shadow.normalBias = 0.02;

    const cam = shadow.camera;
    cam.left = -shadowExtent;
    cam.right = shadowExtent;
    cam.top = shadowExtent;
    cam.bottom = -shadowExtent;
    cam.near = this.distance - shadowExtent * 2;
    cam.far = this.distance + shadowExtent * 2;
    cam.updateProjectionMatrix();

    this.target = new THREE.Object3D();
    scene.add(this.target);
    this.light.target = this.target;
    scene.add(this.light);

    this.apply('lateMorning');
  }

  get presetName(): TimeOfDayName {
    return this.preset;
  }

  /** Apply a time-of-day preset to the light AND the shared uniforms, together. */
  apply(name: TimeOfDayName): void {
    this.preset = name;
    const p = TIME_OF_DAY[name];

    const dir = sunDirectionFrom(p.sun.elevationDeg, p.sun.azimuthDeg);
    this.light.position.copy(dir).multiplyScalar(this.distance);
    this.light.color.set(p.sun.color);
    this.light.intensity = p.sun.intensity;
    this.light.castShadow = p.sun.castShadow;

    // The shared uniform is the same vector the light uses — one source of truth, so the
    // sky's sun disc, the shading terminator and the cast shadow can never disagree.
    globalUniforms.uSunDirection.value.copy(dir);
    applyTimeOfDayUniforms(name);
  }

  /** Keep the shadow frustum centred on a point of interest (the plane, later). */
  followTarget(point: THREE.Vector3): void {
    this.target.position.copy(point);
    this.light.position.copy(globalUniforms.uSunDirection.value).multiplyScalar(this.distance).add(point);
  }
}
