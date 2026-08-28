import * as THREE from 'three';
import { globalUniforms } from '../../render/shading/ShadingUniforms';
import GOUACHE_VERT from './aircraft.vert.glsl';
import GOUACHE_FRAG from './aircraft.frag.glsl';

/**
 * THE AIRCRAFT, AS FLAT-SHADED MASSES.
 *
 * Built from primitives rather than loaded, and deliberately so at this stage: the flight
 * model is the thing being judged, and a placeholder that reads correctly in silhouette
 * against the gouache sky tells you more about whether the takeoff run works than a detailed
 * mesh would. What matters is that the proportions are the ones the physics is using — the
 * span, the hull length and the float positions here are the same numbers `SeaplaneConfig`
 * puts its contact points at, so what the hull looks like it is doing IS what it is doing.
 *
 * Body axes match the physics exactly: +X right, +Y up, +Z forward.
 *
 * FOUR COLOURS, and they are the island's. A fifth would break the palette contract the
 * whole world is built on — see `00 — Art Direction Bible.md` §2. The aircraft is hull red,
 * a paler upper surface, dark metal for the engines and one glass tone for the cockpit.
 */

export interface AircraftParts {
  readonly root: THREE.Group;
  /** The four propeller discs, spun by the engine's own rate. */
  readonly propellers: THREE.Object3D[];
  readonly materials: THREE.ShaderMaterial[];
}

const HULL_RED = 0x8c3b2f;
const HULL_PALE = 0xc7c1ab;
const METAL = 0x3f4a4d;
const GLASS = 0x2b4b57;

export function buildSeaplane(): AircraftParts {
  const root = new THREE.Group();
  root.name = 'Seaplane';
  const propellers: THREE.Object3D[] = [];
  const materials: THREE.ShaderMaterial[] = [];

  const material = (colour: number): THREE.ShaderMaterial => {
    const m = new THREE.ShaderMaterial({
      uniforms: Object.assign(
        { uBaseColor: { value: new THREE.Color(colour) } },
        globalUniforms as unknown as Record<string, THREE.IUniform>,
      ),
      vertexShader: GOUACHE_VERT,
      fragmentShader: GOUACHE_FRAG,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    materials.push(m);
    return m;
  };

  const hullMat = material(HULL_RED);
  const paleMat = material(HULL_PALE);
  const metalMat = material(METAL);
  const glassMat = material(GLASS);

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    root.add(mesh);
    return mesh;
  };

  // --- hull ------------------------------------------------------------------------------
  // A boat, not a fuselage. The waterline sits about 0.6 m up from the planing bottom at
  // rest — see `buoyancyStiffness` — so the topsides above y = -1.0 are what is seen, and
  // the vee bottom below it is what the physics is pushing through the water.
  add(new THREE.BoxGeometry(3.2, 2.0, 13.0), hullMat, 0, 0.1, 0.8);
  // The vee planing bottom, rotated 45 degrees about its length so it reads as a chine.
  const vee = add(new THREE.BoxGeometry(2.0, 2.0, 9.6), hullMat, 0, -1.0, 3.0);
  vee.rotation.z = Math.PI / 4;
  vee.scale.set(1.15, 0.62, 1);
  // Aft of the step the bottom lifts clear of the water — the reason a flying boat can rotate.
  const afterbody = add(new THREE.BoxGeometry(2.4, 1.5, 7.0), hullMat, 0, -0.5, -4.6);
  afterbody.rotation.x = -0.16;
  // Bow, flared and rising.
  const bow = add(new THREE.ConeGeometry(1.7, 4.2, 4), paleMat, 0, 0.0, 8.0);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.z = Math.PI / 4;
  bow.scale.set(1, 1, 0.75);
  // Deck stripe, so the hull has a waterline and reads as a boat from the air.
  add(new THREE.BoxGeometry(3.3, 0.35, 12.0), paleMat, 0, 0.95, 0.8);

  // --- cockpit and the four seats' glasshouse ---------------------------------------------
  // Pilot and navigator forward under the long canopy, front gunner in the nose, rear gunner
  // in the dorsal position aft of the wing.
  add(new THREE.BoxGeometry(2.5, 1.4, 4.6), glassMat, 0, 1.85, 3.4);
  add(new THREE.BoxGeometry(1.6, 1.1, 1.6), glassMat, 0, 0.9, 7.6);
  add(new THREE.BoxGeometry(1.7, 1.0, 2.2), glassMat, 0, 1.7, -3.6);

  // --- wing --------------------------------------------------------------------------------
  // A parasol on a pylon and two struts, which is what keeps four propellers out of the
  // spray. Centre section plus tapered outer panels — one box would read as a plank.
  add(new THREE.BoxGeometry(9.0, 0.6, 4.6), paleMat, 0, 3.3, 0.8);
  for (const side of [-1, 1]) {
    const panel = add(new THREE.BoxGeometry(9.0, 0.5, 4.2), paleMat, side * 8.6, 3.28, 0.9);
    panel.scale.set(1, 1, 0.86);
    panel.rotation.z = -side * 0.035; // a little dihedral
    const tip = add(new THREE.BoxGeometry(2.0, 0.4, 2.6), paleMat, side * 13.6, 3.35, 1.1);
    tip.rotation.z = -side * 0.035;
    // Pylon struts down to the hull.
    const strut = add(new THREE.BoxGeometry(0.28, 2.4, 0.6), metalMat, side * 2.4, 2.1, 0.8);
    strut.rotation.z = side * 0.22;
  }
  add(new THREE.BoxGeometry(2.2, 2.2, 3.0), metalMat, 0, 2.2, 0.8);

  // --- engines and propellers ---------------------------------------------------------------
  for (const ex of [-8.9, -4.3, 4.3, 8.9]) {
    add(new THREE.BoxGeometry(1.6, 1.5, 4.6), metalMat, ex, 3.35, 2.0);
    const cowl = add(new THREE.CylinderGeometry(0.95, 0.85, 1.5, 8), hullMat, ex, 3.35, 4.1);
    cowl.rotation.x = Math.PI / 2;
    // The blades only. A filled disc reads as a dark plate bolted to the wing, which is what
    // the first pass of this model looked like from every angle except dead ahead.
    const hub = new THREE.Object3D();
    hub.position.set(ex, 3.35, 5.0);
    root.add(hub);
    propellers.push(hub);
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.8, 0.12), metalMat);
      blade.rotation.z = (b / 3) * Math.PI * 2;
      blade.castShadow = true;
      hub.add(blade);
    }
  }

  // --- tail ----------------------------------------------------------------------------------
  // Carried high on the upswept afterbody, clear of the spray.
  add(new THREE.BoxGeometry(10.5, 0.45, 2.8), paleMat, 0, 1.9, -9.4);
  for (const side of [-1, 1]) {
    const endplate = add(new THREE.BoxGeometry(0.4, 3.2, 2.4), paleMat, side * 4.9, 3.2, -9.5);
    endplate.rotation.x = 0.06;
  }
  const fin = add(new THREE.BoxGeometry(0.45, 3.4, 2.6), paleMat, 0, 3.3, -9.6);
  fin.rotation.x = 0.06;

  // --- wingtip floats -----------------------------------------------------------------------
  // At the same X the physics puts its outboard contacts, so what holds the aircraft level
  // is visibly the thing holding it level.
  for (const fx of [-8.6, 8.6]) {
    const floatHull = add(new THREE.BoxGeometry(1.2, 1.1, 4.6), hullMat, fx, -1.5, 0.8);
    floatHull.rotation.x = 0.05;
    add(new THREE.BoxGeometry(0.26, 4.6, 0.26), metalMat, fx - 0.4, 0.9, 0.8);
    add(new THREE.BoxGeometry(0.26, 4.6, 0.26), metalMat, fx + 0.4, 0.9, 0.8);
  }

  return { root, propellers, materials };
}
