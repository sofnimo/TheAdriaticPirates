import * as THREE from 'three';
import type { IslandField } from '../../world/island/IslandField';
import { assertProportions, buildHumanFigure, poseFigure, FIGURE_HEIGHT, type FigureParts } from './HumanFigure';

/**
 * ON FOOT — a six-foot person walking the islands, seen from behind.
 *
 * The world has been judged from a seaplane and from six fixed survey framings, and both are
 * views that look DOWN at it. This is the first one inside it, and it asks different questions
 * of the art: whether a 21 m oak crown reads as a tree when you are standing under it, whether
 * the long grass has a scale, whether a beach is a place rather than a band of colour. Things
 * that are perfectly convincing at 700 m are often not, and there is no way to find out from
 * the air.
 *
 * THIRD PERSON, and the body is the point. A first-person camera at eye height tells you what
 * the world looks like from 1.7 m; a figure of KNOWN HEIGHT standing in it tells you how big
 * everything else actually is, which nothing in this project has been able to answer. Every
 * judgement so far has been relative — a 21 m crown against a 300 m hill — and a person is the
 * absolute reference that says whether either is the size it claims. See HumanFigure.ts.
 *
 * The camera rides a boom behind and above the figure. What makes it read as a person rather
 * than as a slow free camera is the constraint set: gravity, a step limit that stops it
 * climbing cliffs, a body that turns to face where it is going, and no vertical control at all.
 *
 * IT USES THE HEIGHTFIELD, NOT THE MESH. Ground is `IslandField.heightAt`, the same bilinear
 * lookup the island mesh is built from and the canopy scatter stands on, rather than a raycast
 * against the rendered geometry. Three reasons: it is O(1) where a raycast is a BVH query per
 * frame; it is the same number every other system uses, so the walker cannot end up standing
 * at a height nothing else agrees with; and it works where the mesh has been decimated, which
 * for the smaller islands is most of them.
 */

export interface WalkerOptions {
  /** Metres the camera sits behind the figure. */
  boomLength?: number;
  /** Metres the camera sits above the figure's feet. */
  boomHeight?: number;
  /** Metres per second, walking. */
  speed?: number;
  /** Radians per pixel of mouse travel. */
  lookSensitivity?: number;
  /**
   * Steepest ground the walker will climb, as a gradient (rise over run).
   *
   * This is what keeps a person off the cliffs, and it is a movement rule rather than a
   * collision test: a step that would climb more steeply than this is refused before it
   * happens. 03 §3.5 makes the seaward flank of every island a cliff, so without it the walker
   * strolls up a vertical limestone face and the whole view stops being about being on foot.
   */
  maxClimb?: number;
}

const KEY_BINDINGS: Record<string, string> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

/** Gravity. Real, because a person's fall off a low wall is a readable amount of time. */
const GRAVITY = 18;
/** Metres per second, upward, on jump. Clears about 0.9 m — a rock, not a roof. */
const JUMP_SPEED = 5.4;

export class Walker {
  enabled = false;

  /** Where the feet are. The figure stands here and the camera looks at it from behind. */
  readonly position = new THREE.Vector3();

  /** The body. Public so the scene can hide it, and so its height is inspectable. */
  readonly figure: FigureParts;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly field: IslandField;
  private readonly pressed = new Set<string>();

  private yaw = 0;
  private pitch = 0;
  private verticalSpeed = 0;
  /** Radians of walk cycle, advanced by distance travelled rather than by time. */
  private gait = 0;
  /** 0 standing, 1 walking. Smoothed, so the cycle fades in rather than snapping on. */
  private stride = 0;
  /** The direction the BODY faces, which chases the direction it is moving. */
  private facing = 0;
  private grounded = true;
  private running = false;

  private readonly boomLength: number;
  private readonly boomHeight: number;
  private readonly speed: number;
  private readonly lookSensitivity: number;
  private readonly maxClimb: number;

  private pointerLocked = false;
  private dragging = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    field: IslandField,
    scene: THREE.Scene,
    options: WalkerOptions = {},
  ) {
    assertProportions();
    this.figure = buildHumanFigure();
    this.figure.root.visible = false;
    scene.add(this.figure.root);
    this.camera = camera;
    this.canvas = canvas;
    this.field = field;
    this.boomLength = options.boomLength ?? 4.2;
    this.boomHeight = options.boomHeight ?? 2.3;
    this.speed = options.speed ?? 4.2;
    this.lookSensitivity = options.lookSensitivity ?? 0.0022;
    this.maxClimb = options.maxClimb ?? 1.0;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseKeys);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  /**
   * Ground height under a point — terrain, or the waterline where the terrain is below it.
   *
   * Clamping at zero rather than refusing to enter the water is deliberate: the shoreline is
   * one of the things this view exists to look at, and a walker who cannot get to the water's
   * edge cannot look at the surf from the sand. Standing on the sea floor at a metre of depth
   * reads as wading; the step limit below stops it going anywhere genuinely deep, because the
   * sea bed falls away faster than the walker can follow it.
   */
  private groundAt(x: number, z: number): number {
    return Math.max(this.field.heightAt(x, z), 0);
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.figure.root.visible = true;
    this.canvas.style.cursor = 'crosshair';
    this.snapToGround();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.figure.root.visible = false;
    this.releaseKeys();
    if (this.pointerLocked) document.exitPointerLock();
    this.canvas.style.cursor = '';
  }

  /**
   * Put the walker somewhere and face them at a bearing, in degrees clockwise from north.
   *
   * NOTE THE `+ PI`. A three camera looks down -Z, so after `rotateY(yaw)` its forward is
   * `(-sin yaw, -cos yaw)`, while a compass bearing `h` is `(sin h, cos h)` — the convention
   * `waveDirection` uses and therefore the one every heading in this project is written in.
   * Those two differ by half a turn, so `yaw = -h` (which is what FreeCamera uses, correctly,
   * for its own inverse mapping) faces a walker in exactly the wrong direction. Spawned facing
   * the island's centre, that put the sea in front of them and the island at their back.
   */
  placeAt(x: number, z: number, headingDeg = 0): void {
    this.position.set(x, this.groundAt(x, z), z);
    this.yaw = (headingDeg * Math.PI) / 180 + Math.PI;
    // The BODY takes the bearing directly, with no half turn. Its local forward is +Z (the
    // boots run that way), so `rotation.y = h` points it along (sin h, cos h) — the compass
    // convention, and the same one `update` turns it toward while walking. Only the camera
    // needs the extra half turn, because it looks down -Z; setting both from the same number
    // would spawn the figure facing the camera.
    this.facing = (headingDeg * Math.PI) / 180;
    this.pitch = 0;
    this.verticalSpeed = 0;
    this.grounded = true;
    this.applyToCamera();
  }

  private snapToGround(): void {
    this.position.y = this.groundAt(this.position.x, this.position.z);
    this.verticalSpeed = 0;
    this.grounded = true;
    this.applyToCamera();
  }

  update(dt: number): void {
    if (!this.enabled || dt <= 0) return;

    let travelled = 0;
    const move = new THREE.Vector3(
      (this.pressed.has('right') ? 1 : 0) - (this.pressed.has('left') ? 1 : 0),
      0,
      (this.pressed.has('back') ? 1 : 0) - (this.pressed.has('forward') ? 1 : 0),
    );

    if (move.lengthSq() > 0) {
      // Normalised, so walking diagonally is not 1.4x faster than walking forward.
      move.normalize();
      // HEADING ONLY, never the pitch. Looking at your feet must not walk you into the
      // ground, and looking at the sky must not lift you off it — that is the difference
      // between a person and the free camera, which deliberately does the opposite.
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const step = this.speed * (this.running ? 2.4 : 1) * dt;
      const delta = new THREE.Vector3()
        .addScaledVector(forward, -move.z)
        .addScaledVector(right, move.x)
        .multiplyScalar(step);

      const nx = this.position.x + delta.x;
      const nz = this.position.z + delta.z;

      // THE STEP LIMIT, and it is tested against the ground at the DESTINATION rather than
      // against a slope sampled where the walker stands. Sampling the gradient underfoot says
      // nothing about what is a pace ahead — on this terrain a cliff edge is one sample wide,
      // so a walker checking the slope beneath their own feet walks straight off it.
      const here = this.groundAt(this.position.x, this.position.z);
      const there = this.groundAt(nx, nz);
      const run = Math.hypot(delta.x, delta.z);
      const climbable = run < 1e-5 || (there - here) / run <= this.maxClimb;

      // Only upward moves are refused. Walking DOWN a cliff is allowed and becomes a fall,
      // which gravity below then handles — being able to jump off a headland into the sea is
      // the correct behaviour, and blocking it would trap the walker on plateaus.
      if (climbable) {
        this.position.x = nx;
        this.position.z = nz;
        travelled = run;
        // THE BODY FACES WHERE IT WALKS, not where the camera looks — that separation is most
        // of what distinguishes third person from a camera with a mannequin bolted to it. It
        // TURNS toward the new heading rather than snapping, so strafing swings the figure
        // round over a few frames the way a person pivots.
        const want = Math.atan2(delta.x, delta.z);
        let diff = want - this.facing;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.facing += diff * Math.min(1, dt * 12);
      }
    }

    // Gravity and ground contact. The walker is pinned to the ground while on it and falls
    // when the ground drops away faster than they are walking.
    const ground = this.groundAt(this.position.x, this.position.z);
    if (this.grounded && this.position.y <= ground + 0.01) {
      this.position.y = ground;
      this.verticalSpeed = 0;
    } else {
      this.verticalSpeed -= GRAVITY * dt;
      this.position.y += this.verticalSpeed * dt;
      if (this.position.y <= ground) {
        this.position.y = ground;
        this.verticalSpeed = 0;
        this.grounded = true;
      }
    }

    // THE GAIT ADVANCES ON DISTANCE, not on the clock — see poseFigure. Stride length is a
    // little over half the figure's height, which is about right for a human pace, so one full
    // cycle covers two steps.
    const strideLength = FIGURE_HEIGHT * 0.62;
    this.gait += (travelled / strideLength) * Math.PI * 2;
    // Smoothed toward walking or standing so the legs ease in and out instead of snapping to
    // a pose the instant a key goes down.
    const want = travelled > 1e-5 ? 1 : 0;
    this.stride += (want - this.stride) * Math.min(1, dt * 9);
    poseFigure(this.figure, this.gait, this.stride, this.grounded ? 0 : 1);

    this.applyToCamera();
  }

  /**
   * Put the body where the walker is and the camera on its boom.
   *
   * THE BOOM IS PUSHED OUT OF THE GROUND, not swung around it. On a hillside the camera sits
   * behind and below the figure and would otherwise end up inside the slope, which renders as
   * the world turning inside out. Lifting it to clear the terrain under its own feet is the
   * cheap fix and behaves well: on flat ground it does nothing at all, and on a steep bank it
   * raises the shot into something like a high-angle framing rather than burying it.
   */
  private applyToCamera(): void {
    this.figure.root.position.copy(this.position);
    this.figure.root.rotation.y = this.facing;

    const back = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const eye = new THREE.Vector3(
      this.position.x + back.x * this.boomLength,
      this.position.y + this.boomHeight - Math.sin(this.pitch) * this.boomLength,
      this.position.z + back.z * this.boomLength,
    );
    const floor = this.groundAt(eye.x, eye.z) + 0.5;
    if (eye.y < floor) eye.y = floor;

    this.camera.position.copy(eye);
    // Aimed at the chest rather than the feet: looking at the feet puts the horizon at the top
    // of the frame and the figure at the bottom, which is a photograph of the ground.
    this.camera.lookAt(
      this.position.x,
      this.position.y + FIGURE_HEIGHT * 0.62,
      this.position.z,
    );
    this.camera.updateMatrixWorld(true);
  }

  /** One line for the on-screen readout. */
  status(): string {
    const p = this.position;
    // The inverse of placeAt's mapping, and it has to stay its inverse: heading is the compass
    // bearing of the forward vector, which is yaw turned half a circle. Reading it back the
    // free camera's way would print a bearing 180 degrees from the one you are walking.
    // The +360 is not decoration: yaw accumulates negatively as you turn left and is
    // unbounded, so a single `% 360` prints negative bearings after a few turns.
    const heading = ((((this.yaw * 180) / Math.PI + 180) % 360) + 360) % 360;
    const ground = this.groundAt(p.x, p.z);
    return (
      'on foot (3rd)  x ' + p.x.toFixed(0) + '  z ' + p.z.toFixed(0) +
      '   ground ' + ground.toFixed(1) + ' m' +
      '   hdg ' + heading.toFixed(0) + 'deg' +
      (this.grounded ? '' : '  falling') +
      (this.running ? '  running' : '')
    );
  }

  dispose(): void {
    // The figure owns five materials and a couple of dozen box geometries, and the scene keeps
    // a reference to its root — dropping the Walker without this leaks all of it.
    this.figure.root.removeFromParent();
    this.figure.dispose();
    this.disable();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseKeys);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  // ------------------------------------------------------------------ input

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.running = true;
    if (e.code === 'Space') {
      if (this.grounded) {
        this.verticalSpeed = JUMP_SPEED;
        this.grounded = false;
      }
      e.preventDefault();
    }
    const action = KEY_BINDINGS[e.code];
    if (action) {
      this.pressed.add(action);
      e.preventDefault();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.running = false;
    const action = KEY_BINDINGS[e.code];
    if (action) this.pressed.delete(action);
  };

  private readonly releaseKeys = (): void => {
    this.pressed.clear();
    this.running = false;
  };

  private readonly onMouseDown = (): void => {
    if (!this.enabled) return;
    this.dragging = true;
    // Pointer lock is the right control for a first-person view, but it needs a user gesture
    // and can be refused; drag-look is the fallback, which is why `dragging` exists at all.
    if (!this.pointerLocked) void this.canvas.requestPointerLock?.();
  };

  private readonly onMouseUp = (): void => {
    this.dragging = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (!this.pointerLocked && !this.dragging) return;
    this.yaw -= e.movementX * this.lookSensitivity;
    this.pitch -= e.movementY * this.lookSensitivity;
    // Just short of straight up and down. Reaching either exactly makes the heading
    // indeterminate and the view rolls as it passes through.
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    this.applyToCamera();
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
  };
}
