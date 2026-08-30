import * as THREE from 'three';
import { SKY_VERT, SKY_FRAG } from './skyShader';

/**
 * VENDORED — stylized-components / skyDome. Christian Ortiz (Cortiz), MIT.
 *
 * The React component's runtime, rebuilt for plain three.js. Upstream carried four
 * sky presets, a Leva panel per uniform and a day-cycle blender; what survives here
 * is the part that draws a sky: the material, the uniform defaults, and the `day`
 * preset applied on top.
 *
 * Three renderer facts hold this together, and all three are load-bearing:
 *
 *   · BackSide, depthTest AND depthWrite off, renderOrder -100. The dome draws
 *     first, writes no depth, and every other object in the scene therefore paints
 *     over it regardless of distance. That is why a unit sphere can act as an
 *     infinitely distant sky without any camera far-plane arithmetic.
 *   · It follows the camera every frame, so the horizon never approaches.
 *   · The whole sky — gradient, sun disc, stars, clouds — is a function of the view
 *     direction in the fragment stage. There is no geometry to any of it.
 *
 * NOTE this is NOT `world/sky/SkyDome.ts`. That one is the game's own art-directed
 * sky, running the same `sky_gradient.glsl` the haze reads so the two can never
 * disagree. This one belongs to the grass scene it came with and shares nothing
 * with it. Two skies, deliberately.
 */

/** The `day` entry from upstream's SKY_PRESETS. The sun disc reuses the moon uniforms. */
const DAY_PRESET = {
  skyLow: '#4aa7e2',
  skyHigh: '#8ecef2',
  horizonLine: 0.05,
  horizonSpread: 0.15,

  sunElevDeg: 10,
  sunAzimDeg: 258,
  moonColor: '#fbfcd6',
  moonGlowColor: '#34a2ef',
  moonSize: 0.015,
  moonEdgeSoftness: 0.04,
  // > 1 = fully lit, so the disc reads as a sun rather than a phased moon.
  moonPhasePos: 2,
  moonPhaseSoftness: 0.45,
  moonPhaseAngleDeg: 150,
  moonEmission: 1.4,
  moonGlowFalloff: 53,
  moonGlowIntensity: 0.45,
  moonSpotStrength: 0,

  cloudDensity: 0.36,
  cloudScale: 8.5,
  cloudSharpness: 0.05,
  cloudAmplitude: 0.63,
  cloudOctaves: 7,
  cloudGrain: 0.13,
  cloudCore: '#dcdcdc',
  cloudEdge: '#ffffff',
  cloudRim: '#d2d2d2',
  cloudOpacity: 0.4,
  cloudEdgeWidth: 0.13,
  cloudRimStrength: 0.2,
  cloudDarkenFar: 1,
  cloudFloor: -0.03,
  cloudCeiling: 0.63,
  cloudSpeed: 0.005,
  cloudStretch: 0.5,
  cloudMorphSpeed: 0.06,
  moonLightRadius: 0.98,
  moonLightSoftness: 0.17,
} as const;

/** Elevation/azimuth in degrees to a unit direction, matching upstream's convention. */
export function skyDirection(elevationDeg: number, azimuthDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
}

export interface SkyDomeOptions {
  /** Radius of the dome mesh. Arbitrary — depth testing is off, so it only has to
   *  sit inside the far plane. */
  radius?: number;
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  /** World-space direction to the sun disc. The lighting rig aims at this. */
  readonly sunDirection = new THREE.Vector3();

  constructor(scene: THREE.Scene, options: SkyDomeOptions = {}) {
    const radius = options.radius ?? 900;

    this.uniforms = {
      uSkyLow: { value: new THREE.Color('#011851') },
      uSkyHigh: { value: new THREE.Color('#011f9d') },
      uHorizonLine: { value: 0.1 },
      uHorizonSpread: { value: 0.35 },
      uMoonDir: { value: new THREE.Vector3(0, 0.6, -0.8).normalize() },
      uMoonColor: { value: new THREE.Color('#fff8d0') },
      uMoonGlowColor: { value: new THREE.Color('#1a3580') },
      uMoonSize: { value: 0.06 },
      uMoonGlowFalloff: { value: 8 },
      uMoonGlowIntensity: { value: 0.6 },
      uMoonEdgeSoftness: { value: 0.02 },
      uMoonPhasePos: { value: 0.3 },
      uMoonPhaseSoftness: { value: 0.2 },
      uMoonPhaseAngle: { value: 0.0 },
      uMoonEmission: { value: 0.35 },
      uMoonSpotColor: { value: new THREE.Color('#3a6ab5') },
      uMoonSpotScale: { value: 1.8 },
      uMoonSpotStrength: { value: 0.8 },
      uMoonSpotThreshold: { value: 0.55 },
      uMoonSpotSharpness: { value: 0.04 },
      uMoonSpotOctaves: { value: 4 },
      uSideWarp: { value: 0 },
      uSideTwist: { value: 0 },
      uAuroraIntensity: { value: 0 },
      uAuroraColor1: { value: new THREE.Color('#3affd8') },
      uAuroraColor2: { value: new THREE.Color('#7b5bff') },
      uAuroraFloor: { value: 0.15 },
      uAuroraCeil: { value: 0.75 },
      uAuroraScale: { value: 3.0 },
      uAuroraSpeed: { value: 0.02 },
      uAuroraThresh: { value: 0.55 },
      uAuroraSoft: { value: 0.25 },
      uAuroraWav: { value: 1.5 },
      // Day has no stars. Density 0 leaves the branch dormant rather than removed,
      // so a night preset is a uniform write away.
      uStarDensity: { value: 0 },
      uStarSize: { value: 0.03 },
      uStarBrightness: { value: 2.0 },
      uStarFloor: { value: 0.0 },
      uStarDriftY: { value: 0.002 },
      uStarDriftZ: { value: 0.0 },
      uStarTwinkleSpeed: { value: 1.2 },
      uStarTwinkleAmount: { value: 0.5 },
      uTime: { value: 0 },
      uCloudMorphSpeed: { value: 0.03 },
      uCloudSpeed: { value: 0 },
      uCloudScale: { value: 2.2 },
      uCloudDensity: { value: 0.45 },
      uCloudSharpness: { value: 0.06 },
      uCloudCore: { value: new THREE.Color('#030d1f') },
      uCloudEdge: { value: new THREE.Color('#2a5299') },
      uCloudRim: { value: new THREE.Color('#8bbfee') },
      uCloudEdgeWidth: { value: 0.35 },
      uCloudRimStrength: { value: 1.7 },
      uMoonLightRadius: { value: 0.06 },
      uMoonLightSoftness: { value: 0.5 },
      uCloudDarkenFar: { value: 0.25 },
      uCloudStretch: { value: 0.6 },
      uCloudFloor: { value: 0.04 },
      uCloudCeiling: { value: 1.0 },
      uCloudOpacity: { value: 0.9 },
      uCloudOctaves: { value: 6 },
      uCloudAmplitude: { value: 0.5 },
      uCloudGrain: { value: 0.08 },
      uCloudSkew: { value: 0.6 },
    };

    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), this.material);
    // Behind everything, and it must never be culled: the dome is centred on the
    // camera, so its bounding sphere always contains the camera and three's
    // frustum test on a camera-centred sphere is not something to rely on.
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    scene.add(this.mesh);

    this.applyDay();
  }

  /** Push the `day` preset into the uniforms. */
  applyDay(): void {
    const p = DAY_PRESET;
    const u = this.uniforms;
    const color = (name: string, hex: string): void => {
      (u[name]!.value as THREE.Color).set(hex);
    };
    const num = (name: string, v: number): void => {
      u[name]!.value = v;
    };

    color('uSkyLow', p.skyLow);
    color('uSkyHigh', p.skyHigh);
    num('uHorizonLine', p.horizonLine);
    num('uHorizonSpread', p.horizonSpread);

    skyDirection(p.sunElevDeg, p.sunAzimDeg, this.sunDirection);
    (u.uMoonDir!.value as THREE.Vector3).copy(this.sunDirection);
    color('uMoonColor', p.moonColor);
    color('uMoonGlowColor', p.moonGlowColor);
    num('uMoonSize', p.moonSize);
    num('uMoonEdgeSoftness', p.moonEdgeSoftness);
    num('uMoonPhasePos', p.moonPhasePos);
    num('uMoonPhaseSoftness', p.moonPhaseSoftness);
    num('uMoonPhaseAngle', THREE.MathUtils.degToRad(p.moonPhaseAngleDeg));
    num('uMoonEmission', p.moonEmission);
    num('uMoonGlowFalloff', p.moonGlowFalloff);
    num('uMoonGlowIntensity', p.moonGlowIntensity);
    num('uMoonSpotStrength', p.moonSpotStrength);

    num('uCloudDensity', p.cloudDensity);
    num('uCloudScale', p.cloudScale);
    num('uCloudSharpness', p.cloudSharpness);
    num('uCloudAmplitude', p.cloudAmplitude);
    num('uCloudOctaves', p.cloudOctaves);
    num('uCloudGrain', p.cloudGrain);
    color('uCloudCore', p.cloudCore);
    color('uCloudEdge', p.cloudEdge);
    color('uCloudRim', p.cloudRim);
    num('uCloudOpacity', p.cloudOpacity);
    num('uCloudEdgeWidth', p.cloudEdgeWidth);
    num('uCloudRimStrength', p.cloudRimStrength);
    num('uCloudDarkenFar', p.cloudDarkenFar);
    num('uCloudFloor', p.cloudFloor);
    num('uCloudCeiling', p.cloudCeiling);
    num('uCloudSpeed', p.cloudSpeed);
    num('uCloudStretch', p.cloudStretch);
    num('uCloudMorphSpeed', p.cloudMorphSpeed);
    num('uMoonLightRadius', p.moonLightRadius);
    num('uMoonLightSoftness', p.moonLightSoftness);
  }

  /** Aim the sun disc. The lighting rig reads `sunDirection` so the two agree. */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    skyDirection(elevationDeg, azimuthDeg, this.sunDirection);
    (this.uniforms.uMoonDir!.value as THREE.Vector3).copy(this.sunDirection);
  }

  update(camera: THREE.Camera, elapsed: number): void {
    this.uniforms.uTime!.value = elapsed;
    // Pinned to the camera, so the sky is always the same distance away.
    this.mesh.position.setFromMatrixPosition(camera.matrixWorld);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
