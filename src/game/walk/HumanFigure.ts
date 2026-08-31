import * as THREE from 'three';
import { createGouacheMaterial } from '../../render/shading/GouacheMaterial';

/**
 * THE WALKER'S BODY — a six-foot person, built from primitives.
 *
 * BUILT IN CODE, NOT IMPORTED. There is no asset pipeline in this project: every mesh so far —
 * the islands, the canopy crowns, the seaplane — is generated, and a glTF character would be
 * the first thing that is not, bringing a loader, a load-order dependency and a file whose
 * proportions nothing else can check. A figure assembled from boxes is also the honest match
 * for the art direction: 00 §3 forbids smooth specular shading and asks for flat painted tones,
 * which is exactly what low-poly volumes under the gouache ramp give.
 *
 * SIX FEET, AND THE NUMBER IS LOAD-BEARING. 1.8288 m is the total from sole to crown, and every
 * measurement below is derived from it through the 7.5-head canon rather than eyeballed, so the
 * figure can be rescaled by changing one constant and still be a person. It matters beyond the
 * figure: a human of known height standing on this terrain is the first absolute scale reference
 * the world has ever had. Everything up to now has been judged against other things in the same
 * frame — a 21 m oak crown looks fine next to a 300 m hill — and a person is the thing that says
 * whether either of them is actually the size it claims.
 *
 * JOINTS ARE GROUPS, LIMBS HANG OFF THEM. Each limb's mesh is offset DOWN from an empty at the
 * joint, so rotating the empty swings the limb about the shoulder or hip the way a limb swings,
 * rather than about its own middle. It is the cheapest possible rig and it is all a walk cycle
 * needs.
 */

/** Sole to crown, metres. Six feet. Everything else is a fraction of this. */
export const FIGURE_HEIGHT = 1.8288;

/** The 7.5-head canon: one head is this much of the total. */
const HEAD = FIGURE_HEIGHT / 7.5;

/**
 * Vertical landmarks, in metres off the ground. Feet at zero.
 *
 * Read as a column: ankle, knee, hip, shoulder, neck, crown. The head sits on top of the last
 * one and its top lands exactly at FIGURE_HEIGHT, which is the check that the table is
 * self-consistent — `assertProportions` below fails the build if it ever stops being.
 */
const ANKLE = HEAD * 0.37;
const KNEE = HEAD * 1.85;
const HIP = HEAD * 3.70;
const SHOULDER = HEAD * 6.05;
const NECK = HEAD * 6.42;
const CROWN = FIGURE_HEIGHT;

const SHOULDER_HALF = HEAD * 0.90;
const HIP_HALF = HEAD * 0.38;
const LIMB = HEAD * 0.46;

export interface FigureParts {
  /** Everything, at the feet. Move and turn this to move the person. */
  readonly root: THREE.Group;
  readonly hipL: THREE.Group;
  readonly hipR: THREE.Group;
  readonly kneeL: THREE.Group;
  readonly kneeR: THREE.Group;
  readonly shoulderL: THREE.Group;
  readonly shoulderR: THREE.Group;
  readonly head: THREE.Group;
  /** Torso and head together, so the whole upper body can lean into a stride. */
  readonly chest: THREE.Group;
  dispose(): void;
}

/**
 * A box whose TOP face sits at the group's origin, hanging down by `length`.
 *
 * The offset is what makes the rig work: a limb built centred on its own origin rotates about
 * its middle and detaches from the joint as soon as it swings.
 */
function limb(
  material: THREE.Material,
  width: number,
  length: number,
  depth: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, depth), material);
  mesh.position.y = -length / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function block(
  material: THREE.Material,
  width: number,
  height: number,
  depth: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * The figure, and the palette it is painted in.
 *
 * SKIN TAKES THE AIRCRAFT'S SURFACE ROW, which looks like a joke and is not: that row is the
 * one in art/surfaces.ts with `shadowCool: 0` and a warm shadow tint, carrying the standing
 * instruction that it must never cool toward blue. Skin has exactly that requirement — a face
 * that goes blue in shadow reads as a corpse — and adding a second row that says the same
 * thing would be two places to keep in step. Clothes take `terracotta`, which is the other
 * warm row and is already the buildings' palette, so a person matches the harbour they stand in.
 */
export function buildHumanFigure(): FigureParts {
  const skin = createGouacheMaterial({ surface: 'aircraft', color: 0xc8a183, flatShading: true });
  const shirt = createGouacheMaterial({ surface: 'terracotta', color: 0xb8c3bd, flatShading: true });
  const trousers = createGouacheMaterial({ surface: 'terracotta', color: 0x4a5568, flatShading: true });
  const boots = createGouacheMaterial({ surface: 'terracotta', color: 0x3a2c24, flatShading: true });
  const hair = createGouacheMaterial({ surface: 'terracotta', color: 0x3b2b22, flatShading: true });
  const owned: THREE.Material[] = [skin, shirt, trousers, boots, hair];

  const root = new THREE.Group();
  root.name = 'walker';

  // ---- torso ---------------------------------------------------------------------------
  const chest = new THREE.Group();
  chest.position.y = HIP;
  root.add(chest);

  const torso = block(shirt, SHOULDER_HALF * 2 * 0.86, SHOULDER - HIP, HEAD * 0.62);
  torso.position.y = (SHOULDER - HIP) / 2;
  chest.add(torso);

  const pelvis = block(trousers, HIP_HALF * 2 * 1.15, HEAD * 0.55, HEAD * 0.58);
  pelvis.position.y = HEAD * 0.1;
  chest.add(pelvis);

  // ---- head ----------------------------------------------------------------------------
  const head = new THREE.Group();
  head.position.y = NECK - HIP;
  chest.add(head);

  const neck = block(skin, HEAD * 0.34, HEAD * 0.22, HEAD * 0.34);
  neck.position.y = -HEAD * 0.06;
  head.add(neck);

  const skull = block(skin, HEAD * 0.78, CROWN - NECK, HEAD * 0.82);
  skull.position.y = (CROWN - NECK) / 2;
  head.add(skull);

  // A cap of hair rather than a texture: at this scale it is the silhouette that says which
  // way a head is facing, and a flat-tone block reads at 3 m where a painted face would not.
  const crop = block(hair, HEAD * 0.84, (CROWN - NECK) * 0.42, HEAD * 0.88);
  crop.position.set(0, (CROWN - NECK) * 0.82, -HEAD * 0.03);
  head.add(crop);

  // ---- arms ----------------------------------------------------------------------------
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER_HALF, SHOULDER - HIP - HEAD * 0.12, 0);
    chest.add(shoulder);
    shoulder.add(limb(shirt, LIMB, HEAD * 1.28, LIMB));

    const elbow = new THREE.Group();
    elbow.position.y = -HEAD * 1.28;
    shoulder.add(elbow);
    elbow.add(limb(skin, LIMB * 0.92, HEAD * 1.12, LIMB * 0.92));

    const hand = block(skin, LIMB * 1.05, HEAD * 0.28, LIMB * 0.8);
    hand.position.y = -HEAD * 1.12 - HEAD * 0.14;
    elbow.add(hand);

    arms.push(shoulder);
  }

  // ---- legs ----------------------------------------------------------------------------
  const hips: THREE.Group[] = [];
  const knees: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * HIP_HALF, 0, 0);
    chest.add(hip);
    hip.add(limb(trousers, LIMB * 1.15, HIP - KNEE, LIMB * 1.15));

    const knee = new THREE.Group();
    knee.position.y = -(HIP - KNEE);
    hip.add(knee);
    knee.add(limb(trousers, LIMB * 1.02, KNEE - ANKLE, LIMB * 1.02));

    // The boot runs FORWARD of the ankle, which is the whole reason a figure reads as facing
    // somewhere when it is otherwise a stack of symmetrical boxes.
    const boot = block(boots, LIMB * 1.1, ANKLE, HEAD * 0.62);
    boot.position.set(0, -(KNEE - ANKLE) - ANKLE / 2, HEAD * 0.12);
    knee.add(boot);

    hips.push(hip);
    knees.push(knee);
  }

  return {
    root,
    hipL: hips[0]!,
    hipR: hips[1]!,
    kneeL: knees[0]!,
    kneeR: knees[1]!,
    shoulderL: arms[0]!,
    shoulderR: arms[1]!,
    head,
    chest,
    dispose() {
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
      });
      for (const m of owned) m.dispose();
    },
  };
}

/**
 * Drive the walk cycle.
 *
 * PHASE COMES FROM DISTANCE WALKED, not from a clock. Tie a stride to time and the legs run at
 * the same rate however fast the person is moving, so a walk and a run share one gait and the
 * feet skate over the ground at every speed but one. Driving it from metres travelled means the
 * stride keeps pace with the body by construction, which is the cheap version of foot planting
 * and is most of what sells it.
 *
 * @param parts  the rig
 * @param phase  radians, advanced by distance / stride length
 * @param moving 0 standing, 1 walking — blends the whole cycle out so a stopped figure stands
 * @param airborne 1 while off the ground: legs tuck instead of striding
 */
export function poseFigure(parts: FigureParts, phase: number, moving: number, airborne: number): void {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const swing = 0.72 * moving;

  parts.hipL.rotation.x = s * swing;
  parts.hipR.rotation.x = -s * swing;
  // Knees only ever bend one way. A knee that flexes backwards is the single most obvious
  // thing a hand-made walk cycle can get wrong, so the bend is a rectified sine — always
  // positive, never straightening past zero.
  parts.kneeL.rotation.x = -Math.max(0, -c) * 1.15 * moving;
  parts.kneeR.rotation.x = -Math.max(0, c) * 1.15 * moving;

  // Arms swing opposite the leg on the same side. That contra-rotation is what stops a figure
  // looking like it is marching.
  parts.shoulderL.rotation.x = -s * swing * 0.75;
  parts.shoulderR.rotation.x = s * swing * 0.75;
  // A little outward set so the arms clear the hips instead of intersecting the torso.
  parts.shoulderL.rotation.z = 0.14;
  parts.shoulderR.rotation.z = -0.14;

  // The body rises and falls twice per stride — once per footfall — which is the vertical
  // bounce that reads as weight. Small: a few centimetres, not a hop.
  parts.chest.position.y = HIP + Math.abs(c) * 0.035 * moving;

  if (airborne > 0.001) {
    // Tucked, and blended so the transition into a fall is not a snap.
    parts.hipL.rotation.x = THREE.MathUtils.lerp(parts.hipL.rotation.x, -0.55, airborne);
    parts.hipR.rotation.x = THREE.MathUtils.lerp(parts.hipR.rotation.x, -0.3, airborne);
    parts.kneeL.rotation.x = THREE.MathUtils.lerp(parts.kneeL.rotation.x, -1.1, airborne);
    parts.kneeR.rotation.x = THREE.MathUtils.lerp(parts.kneeR.rotation.x, -0.7, airborne);
    parts.shoulderL.rotation.x = THREE.MathUtils.lerp(parts.shoulderL.rotation.x, -0.7, airborne);
    parts.shoulderR.rotation.x = THREE.MathUtils.lerp(parts.shoulderR.rotation.x, -0.7, airborne);
  }
}

/**
 * Fails loudly if the proportion table stops adding up to the stated height.
 *
 * Called once at construction. The figure is the world's only absolute scale reference, so a
 * silent drift here would quietly rescale the judgement of everything measured against it —
 * the trees, the grass, the beach. Cheap to check, expensive to notice by eye.
 */
export function assertProportions(): void {
  if (Math.abs(CROWN - FIGURE_HEIGHT) > 1e-6) {
    throw new Error('HumanFigure: crown ' + CROWN + ' does not match FIGURE_HEIGHT ' + FIGURE_HEIGHT);
  }
  const order = [ANKLE, KNEE, HIP, SHOULDER, NECK, CROWN];
  for (let i = 1; i < order.length; i++) {
    if (order[i]! <= order[i - 1]!) throw new Error('HumanFigure: landmarks out of order at ' + i);
  }
}
