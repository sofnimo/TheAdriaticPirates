import * as THREE from 'three';
import { globalUniforms } from '../../render/shading/ShadingUniforms';
import SKY_GRADIENT_GLSL from '../../render/shading/chunks/sky_gradient.glsl';

/**
 * Sky dome — `01 — Sky and Clouds.md` §1.
 *
 * A BackSide sphere that follows the camera, running the SAME `sky_gradient.glsl` the
 * haze chunk calls. Retune the gradient and both move together; there is no second copy
 * of the horizon colour anywhere in the codebase.
 *
 * Not three's `Sky` addon — that is physical Preetham scattering, which fights a flat
 * saturated cyan and needs heavy exposure tuning even for an ordinary blue (01 §1.1).
 */

const VERTEX = /* glsl */ `
varying vec3 vWorldDir;

void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldDir = worldPosition.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vWorldDir;

${SKY_GRADIENT_GLSL}

void main() {
  gl_FragColor = vec4( skyWithSun( normalize( vWorldDir ) ), 1.0 );
  #include <colorspace_fragment>
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, radius = 8000) {
    this.material = new THREE.ShaderMaterial({
      uniforms: globalUniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000; // behind everything
    this.mesh.name = 'SkyDome';
    scene.add(this.mesh);
  }

  /** Keep the dome centred on the camera so it can never be flown out of. */
  update(camera: THREE.Camera): void {
    this.mesh.position.setFromMatrixPosition(camera.matrixWorld);
  }

  /**
   * CPU-side evaluation of the same gradient, for code that needs the sky colour without
   * a GPU readback (haze debug, the horizon-convergence probe). Mirrors sky_gradient.glsl
   * — if you edit one, edit both; the probe in dev/RampProbe.ts checks they agree.
   */
  static evaluateGradient(dir: THREE.Vector3, out = new THREE.Color()): THREE.Color {
    const sunDir = globalUniforms.uSunDirection.value;
    const sunDot = dir.dot(sunDir);
    const h = dir.y + 0.05 * Math.max(sunDot, 0);

    const t1 = smoothstep(-0.02, 0.28, h);
    const t2 = smoothstep(0.2, 0.75, h);

    out.copy(globalUniforms.uSkyHorizon.value).lerp(globalUniforms.uSkyMid.value, t1);
    out.lerp(globalUniforms.uSkyZenith.value, t2);
    return out;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
