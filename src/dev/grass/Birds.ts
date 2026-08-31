import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * THE BIRDS — `bird.fbx`, flying over the meadow.
 *
 * ── What is actually in the file, and why only one bird flew ───────────────────
 *
 * The asset looks like a five-bird flock: five `SkinnedMesh`es, five armatures,
 * and a 0.67 s clip carrying 105 tracks — which reads as 5 birds x 7 bones x 3
 * channels, one flap each.
 *
 * It is not. Every one of those five armatures uses the SAME SEVEN BONE NAMES
 * (`Bone`, `Bone001l`, `Bone002l`, `Bone003l`, `Bone001r`, `Bone002r`,
 * `Bone003r`), and an `AnimationMixer` binds a track to a node BY NAME, taking
 * the first match in a depth-first walk. So all fifteen tracks named
 * `Bone.quaternion` land on the first armature's `Bone` and fight over it, and the
 * other four armatures are never addressed at all. One bird flapped; four were
 * frozen in their bind pose, gliding.
 *
 * Renaming five armatures' worth of bones inside a binary FBX is not a fix this
 * project should be making. So the file is used for what it reliably contains —
 * ONE rigged, animated bird — and the flock is six clones of it, each with its own
 * skeleton, its own mixer and its own place in the flap cycle. That also buys
 * per-bird control of the flap that the original could never have given: five
 * birds sharing one armature share one wingbeat.
 *
 * ── Taking a bird apart ────────────────────────────────────────────────────────
 *
 * A skinned mesh cannot simply be moved. Its vertices come out as
 *
 *     mesh.matrixWorld · bindMatrix⁻¹ · Σ w·(bone.matrixWorld · boneInverse) · bindMatrix · p
 *
 * so translating the MESH alone applies its transform on top of a world-space
 * bone result and the bird tears away from its own skeleton. Translating the
 * ARMATURE alone leaves `mesh.matrixWorld` behind and does the same in reverse.
 *
 * Put both under one group `G` and the two `G`s in that product cancel to exactly
 * one. That is the whole trick: a bird is a group holding a mesh AND its armature,
 * and the group is what the flight path drives.
 */

/** Which way the model faces before any flight path turns it. Measured: -Z. */
const MODEL_FACES_NEGATIVE_Z = true;

/**
 * How far ahead on its own path a bird looks to work out which way it is pointing,
 * in seconds.
 *
 * One constant for two jobs — the heading AND the speed that heading implies —
 * because they are the same finite difference and letting them drift apart would
 * silently mis-scale the bank angle. Short enough that the chord it measures is a
 * few degrees of even the tightest 4.5 s lap.
 */
const HEADING_LOOKAHEAD = 0.05;

/**
 * Gull white — off-white, not `0xffffff`.
 *
 * The renderer is `NoToneMapping` (00 §5) and this scene runs the sun at 3 over an
 * ambient of 1, so a pure-white albedo clips well past 1.0 on every lit face and
 * the bird comes out as a flat white cut-out with no shading left in it. Backing
 * the albedo off to 0.88 keeps the top surface under the clip and lets the wing
 * still turn over.
 */
const GULL_WHITE = 0xe2ded4;

/**
 * One bird's lap. Everything is an ellipse around a centre because these birds
 * work one patch of meadow rather than going anywhere — the flock stays where the
 * trees were cleared for it, however fast it is moving.
 *
 * Laps run 4.5–7.5 s across the flock and 12 s for the loner, which puts them at
 * roughly 4–9 m/s. Real gulls cruise nearer 11, so there is headroom left in the
 * panel's `speed x` if they should go faster still.
 */
interface Orbit {
  /** Metres from the flock centre. */
  radius: number;
  /** Metres above the GROUND under the bird, not above sea level. */
  height: number;
  /** Seconds per lap. Negative laps the other way. */
  period: number;
  /** Where on the lap it starts, 0..1. */
  phase: number;
  /** How far it rises and falls across a lap, metres. */
  bob: number;
  /** Z radius as a fraction of X radius. 1 is a circle. */
  squash: number;
  /** Where in the wingbeat this bird starts, 0..1. */
  flapPhase: number;
  /**
   * Plumage. Omitted leaves the asset's own black, which is most of the flock —
   * a bird against a bright sky is a silhouette, and that is the whole reason
   * these read at all from the establishing camera.
   */
  bodyColor?: number;
}

/**
 * Five loose laps over the same meadow.
 *
 * The radii, periods and phases are mutually prime-ish on purpose: equal periods
 * would lock the five into a rigid formation that slides around as one piece,
 * which reads as a single object rather than as five birds. Drifting relative to
 * each other is most of what makes a flock look alive — and `flapPhase` is the
 * other half, since six clones of one clip would otherwise beat in lockstep.
 */
const FLOCK_ORBITS: readonly Orbit[] = [
  { radius: 4.2, height: 3.4, period: 5.0, phase: 0.00, bob: 0.7, squash: 0.85, flapPhase: 0.00 },
  { radius: 6.8, height: 5.1, period: 6.5, phase: 0.31, bob: 1.1, squash: 0.70, flapPhase: 0.37, bodyColor: GULL_WHITE },
  { radius: 3.1, height: 6.3, period: -4.5, phase: 0.62, bob: 0.5, squash: 1.00, flapPhase: 0.61 },
  { radius: 8.4, height: 4.2, period: 7.5, phase: 0.18, bob: 0.9, squash: 0.78, flapPhase: 0.19, bodyColor: GULL_WHITE },
  { radius: 5.6, height: 7.0, period: -5.5, phase: 0.77, bob: 1.3, squash: 0.92, flapPhase: 0.82 },
];

/** The loner: wider, higher, slower, and going the other way round. */
const LONER_ORBIT: Orbit = {
  radius: 21, height: 13.5, period: -12, phase: 0.4, bob: 2.2, squash: 0.62, flapPhase: 0.5,
};

/**
 * Wingbeats per second at `flapRate` 1, from the clip: 0.67 s a cycle is 1.5 Hz.
 * A herring gull cruises nearer 3, which is where the default rate comes from.
 */
export const BIRD_DEFAULT_FLAP_RATE = 2.2;

export interface BirdsOptions {
  /** Where the flock hangs. Should be the meadow the trees were cleared from. */
  centre: THREE.Vector3;
  /** Where the loner's much wider circuit is centred. */
  lonerCentre: THREE.Vector3;
  /** Wingspan of one bird, metres, wings fully spread. */
  wingspan?: number;
  /** Wingbeat multiplier. 1 is the clip's own 1.5 Hz. */
  flapRate?: number;
  /** Ground height under a world point, so the birds clear the terrain. */
  groundAt?: (x: number, z: number) => number;
}

interface Bird {
  /** Driven by the flight path. Holds the mesh and its armature, nothing else. */
  root: THREE.Group;
  orbit: Orbit;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
}

export class Birds {
  readonly group = new THREE.Group();
  readonly flock: Bird[] = [];
  loner!: Bird;

  /** Flight-path speed multiplier, for the panel. Wingbeat is separate. */
  speed = 1;

  private readonly options: {
    centre: THREE.Vector3;
    lonerCentre: THREE.Vector3;
    wingspan: number;
    flapRate: number;
    groundAt: ((x: number, z: number) => number) | undefined;
  };

  private time = 0;
  /** Authored wingspan in file units, so the panel can rescale without reloading. */
  private nativeWingspan = 1;

  private constructor(options: BirdsOptions) {
    this.group.name = 'birds';
    this.options = {
      centre: options.centre.clone(),
      lonerCentre: options.lonerCentre.clone(),
      wingspan: options.wingspan ?? 1.3,
      flapRate: options.flapRate ?? BIRD_DEFAULT_FLAP_RATE,
      groundAt: options.groundAt,
    };
  }

  static async load(scene: THREE.Scene, url: string, options: BirdsOptions): Promise<Birds> {
    const birds = new Birds(options);
    const root = await new FBXLoader().loadAsync(url);
    root.updateMatrixWorld(true);

    const template = liveBird(root);
    const clip = oneBirdClip(root.animations?.[0]);
    birds.nativeWingspan = new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3()).x || 1;

    for (const orbit of FLOCK_ORBITS) birds.flock.push(birds.hatch(template, clip, orbit));
    birds.loner = birds.hatch(template, clip, LONER_ORBIT);

    birds.setWingspan(birds.options.wingspan);
    birds.setFlapRate(birds.options.flapRate);
    scene.add(birds.group);
    birds.update(0);
    return birds;
  }

  /**
   * One more bird from the template, with its own skeleton and its own mixer.
   *
   * The nesting is three deep and each layer earns it:
   *   root     — the flight path writes position and rotation here
   *     fit    — wingspan, one uniform scale
   *       body — the clone: cancels where the bird sat inside the FBX, so the
   *              layers above turn about the BIRD and not about the file's origin
   */
  private hatch(template: THREE.Object3D, clip: THREE.AnimationClip | null, orbit: Orbit): Bird {
    const body = cloneSkinned(template);
    body.updateMatrixWorld(true);
    const centre = new THREE.Box3().setFromObject(body).getCenter(new THREE.Vector3());
    body.position.sub(centre);

    const fit = new THREE.Group();
    fit.name = 'bird-fit';
    fit.add(body);

    const root = new THREE.Group();
    root.name = 'bird';
    root.rotation.order = 'YXZ';
    root.add(fit);
    this.group.add(root);

    body.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      // No shadow. The scene bakes its shadow map once and freezes it (see
      // GrassWorldScene.setStaticShadows) because re-rendering 192k blades of
      // grass every frame is what that switch exists to avoid — so a moving caster
      // would leave its shadow printed on the grass where it used to be. A bird
      // dragging a stale silhouette behind it is worse than a bird with no shadow.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      tameGloss(mesh);
      if (orbit.bodyColor !== undefined) paintBody(mesh, orbit.bodyColor);
    });

    // One mixer per bird, bound to that bird's own clone: this is the whole reason
    // the flock is clones rather than the file's five armatures. Each mixer sees
    // exactly one set of seven bones, so the name-based binding that collapsed the
    // original into a single flapping bird now resolves the way it reads.
    const mixer = new THREE.AnimationMixer(body);
    const action = mixer.clipAction(clip ?? new THREE.AnimationClip('still', 0, []));
    action.play();
    if (clip) action.time = orbit.flapPhase * clip.duration;

    return { root, orbit, mixer, action };
  }

  /** Rescale every bird. Cheap — one scale per bird, no reload. */
  setWingspan(metres: number): void {
    this.options.wingspan = metres;
    const scale = metres / this.nativeWingspan;
    for (const bird of this.all()) bird.root.children[0]?.scale.setScalar(scale);
  }

  get wingspan(): number {
    return this.options.wingspan;
  }

  /** Wingbeat rate, independent of how fast the bird crosses the sky. */
  setFlapRate(rate: number): void {
    this.options.flapRate = rate;
    for (const bird of this.all()) bird.action.timeScale = rate;
  }

  get flapRate(): number {
    return this.options.flapRate;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  /** Where the flock hangs. Follows the meadow if that is ever moved. */
  setCentre(centre: THREE.Vector3): void {
    this.options.centre.copy(centre);
  }

  all(): Bird[] {
    return this.loner ? [...this.flock, this.loner] : [...this.flock];
  }

  update(dt: number): void {
    this.time += dt * this.speed;
    // The wingbeat runs on real time, not on path time: slowing the flock's
    // circuit to a crawl should not put the birds into slow motion.
    for (const bird of this.all()) bird.mixer.update(dt);
    if (!this.group.visible) return;

    for (const bird of this.flock) this.fly(bird, this.options.centre);
    if (this.loner) this.fly(this.loner, this.options.lonerCentre);
  }

  /**
   * Put one bird where its lap says it should be, facing where it is going.
   *
   * Heading comes from sampling the path a moment ahead rather than from a stored
   * previous position: it is stateless, correct on the very first frame, and it
   * does not go undefined when `dt` is 0 (which it is on the frame the scene
   * loads).
   */
  private fly(bird: Bird, centre: THREE.Vector3): void {
    const here = this.sample(bird.orbit, centre, this.time);
    const ahead = this.sample(bird.orbit, centre, this.time + HEADING_LOOKAHEAD);

    bird.root.position.copy(here);

    const dx = ahead.x - here.x;
    const dy = ahead.y - here.y;
    const dz = ahead.z - here.z;
    const flat = Math.hypot(dx, dz);

    // The model is drawn facing -Z, and an object yawed by θ points its own -Z at
    // ( -sinθ, -cosθ ). Solving that for the travel direction is the + PI.
    const yaw = Math.atan2(dx, dz) + (MODEL_FACES_NEGATIVE_Z ? Math.PI : 0);

    // Nose follows the climb, but only a little: these are gliding birds, and a
    // bird pitched to match a 2 m bob over a 30 s lap looks like it is falling.
    const pitch = THREE.MathUtils.clamp(Math.atan2(dy, flat) * 0.6, -0.35, 0.35);

    // Bank into the turn, the way anything flying a circle has to: atan( v·ω / g )
    // is the coordinated-turn angle, and 1.2 is a light stylisation on top of it.
    //
    // The exaggeration used to be 2.2, which was tuned when the laps took 22–41 s
    // and the physical angle was almost nothing. At these speeds the real angle is
    // already 30-40°, and keeping 2.2 pinned every bird to the cap — a flock all
    // banked identically, which reads as a bug rather than as a turn.
    const speed = flat / HEADING_LOOKAHEAD;
    const turnRate = (2 * Math.PI) / bird.orbit.period;
    const roll = THREE.MathUtils.clamp(Math.atan2(speed * turnRate, 9.81) * 1.2, -0.75, 0.75);

    bird.root.rotation.set(pitch, yaw, roll);
  }

  private sample(orbit: Orbit, centre: THREE.Vector3, t: number): THREE.Vector3 {
    const angle = (t / orbit.period + orbit.phase) * Math.PI * 2;
    const x = centre.x + Math.cos(angle) * orbit.radius;
    const z = centre.z + Math.sin(angle) * orbit.radius * orbit.squash;
    const ground = this.options.groundAt?.(x, z) ?? centre.y;
    const y = ground + orbit.height + Math.sin(angle * 2 + orbit.phase * 6.283) * orbit.bob;
    return new THREE.Vector3(x, y, z);
  }

  dispose(): void {
    for (const bird of this.all()) bird.mixer.stopAllAction();
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    });
    this.group.removeFromParent();
  }
}

/**
 * The one bird in the file that the clip actually drives, as a self-contained
 * group holding its mesh and its armature.
 *
 * "The one that flies" is not a guess: `AnimationMixer` resolves a track's target
 * with a depth-first search by name, so the armature that wins is whichever one
 * holds the first node matching the first track. Finding it the same way the
 * mixer does is what makes this correct rather than a hardcoded `Armature002`.
 */
function liveBird(root: THREE.Object3D): THREE.Group {
  const trackName = root.animations?.[0]?.tracks[0]?.name.split('.')[0];
  const driven = trackName ? root.getObjectByName(trackName) : undefined;

  let armature: THREE.Object3D | undefined = driven;
  while (armature?.parent && armature.parent !== root) armature = armature.parent;

  // The mesh skinned to that armature: the one whose skeleton contains its bones.
  let mesh: THREE.SkinnedMesh | undefined;
  root.traverse((child) => {
    const candidate = child as THREE.SkinnedMesh;
    if (!candidate.isSkinnedMesh || mesh) return;
    if (!armature || candidate.skeleton.bones.some((bone) => isDescendant(bone, armature!))) mesh = candidate;
  });

  if (!mesh) throw new Error('bird.fbx: no skinned mesh found');

  const template = new THREE.Group();
  template.name = 'bird-template';
  if (armature) template.add(armature);
  template.add(mesh);
  template.updateMatrixWorld(true);
  return template;
}

function isDescendant(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/**
 * The clip cut down to one bird's worth of tracks.
 *
 * The file's 105 tracks are five copies of the same seven bones, three channels
 * each, and every copy carries the identical target name — so on a single-armature
 * clone all five would bind to the same bone and fight, at real cost for no
 * visible difference. Keeping the first of each `bone.channel` leaves 21 tracks
 * that describe exactly one wingbeat.
 */
function oneBirdClip(clip: THREE.AnimationClip | undefined): THREE.AnimationClip | null {
  if (!clip) return null;
  const seen = new Set<string>();
  const tracks = clip.tracks.filter((track) => {
    if (seen.has(track.name)) return false;
    seen.add(track.name);
    return true;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Repaint one bird's plumage without touching its beak.
 *
 * `SkeletonUtils.clone` shares materials with the template by reference, so a
 * clone that recoloured in place would recolour the whole flock. Only the body
 * slot is cloned — the beak stays shared, which is correct: nothing ever writes
 * to it, and one material for six beaks is one less program to compile.
 *
 * Which slot is the body is decided by GEOMETRY, not by material name or colour:
 * the body is whichever group covers more of the mesh. `Material` / `Material.001`
 * are names an exporter chose, and "the darkest one" stops being true the moment
 * this function has run once.
 */
function paintBody(mesh: THREE.Mesh, color: number): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (materials.length < 2) {
    (materials[0] as THREE.MeshPhongMaterial | undefined)?.color.setHex(color);
    return;
  }

  const covered = new Map<number, number>();
  for (const group of mesh.geometry.groups) {
    covered.set(group.materialIndex ?? 0, (covered.get(group.materialIndex ?? 0) ?? 0) + group.count);
  }
  let bodyIndex = 0;
  let most = -1;
  for (const [index, count] of covered) {
    if (count > most) {
      most = count;
      bodyIndex = index;
    }
  }

  const repainted = materials.slice();
  const body = materials[bodyIndex]?.clone() as THREE.MeshPhongMaterial | undefined;
  if (!body) return;
  body.color.setHex(color);
  body.name = 'bird-body-white';
  repainted[bodyIndex] = body;
  mesh.material = repainted;
}

/**
 * Flatten the imported specular, for the same reason `ModelStage` does it: the
 * renderer runs `NoToneMapping`, so a stock FBX's white specular under this
 * scene's sun goes past 1.0 and the bird gets a hard white blob on its back. The
 * body is pure black — a highlight is the only thing that would show on it, and
 * it is the one thing that should not.
 */
function tameGloss(mesh: THREE.Mesh): void {
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    const phong = material as THREE.MeshPhongMaterial;
    const standard = material as unknown as THREE.MeshStandardMaterial;
    if (phong.specular) phong.specular.setScalar(0.02);
    if (phong.shininess !== undefined) phong.shininess = 4;
    if (standard.metalness !== undefined) standard.metalness = 0;
    if (standard.roughness !== undefined) standard.roughness = 1;
    material.needsUpdate = true;
  }
}
