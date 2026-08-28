import * as THREE from 'three';
import type { WaveSurface } from '../../world/ocean/waveSurface';
import { PilotInput } from './PilotInput';
import { BOMBER, type SeaplaneConfig } from './SeaplaneConfig';
import { SeaplanePhysics, type FlightState } from './SeaplanePhysics';
import { buildSeaplane, type AircraftParts } from './SeaplaneModel';

/**
 * THE AIRCRAFT IN THE WORLD — physics, model, propellers and the chase camera.
 *
 * IT STARTS ON THE WATER, ENGINES OFF. `moorAt` puts the hull at its floating draught in a
 * sheltered spot rather than dropping it in from a height, so the first thing the player sees
 * is an aeroplane riding the swell — which is the shot the whole reference set is built
 * around. Everything from there is the flight model's doing: opening the throttle digs the
 * bow in, the hull fights through its own bow wave, it climbs onto the step, and the wing
 * takes over. None of that is scripted; see the note at the top of `SeaplaneConfig`.
 *
 * THE CAMERA IS SPRUNG, NOT WELDED. A chase camera rigidly attached to the airframe rolls
 * with it, which turns a roll into the world rotating around a stationary aeroplane and
 * makes the horizon useless as a reference. So the boom follows the aircraft's HEADING and
 * takes only a fraction of its bank, and the camera itself lags on a critically damped
 * spring — the aircraft moves inside the frame, which is what reads as speed.
 */

export interface SeaplaneOptions {
  readonly config?: SeaplaneConfig;
  /** Where the hull is moored at the start, world XZ. */
  readonly startX: number;
  readonly startZ: number;
  /** Radians. Which way the nose points at the start — down the takeoff run. */
  readonly heading: number;
}

/** Metres behind, above and the look-ahead of the chase boom. */
const BOOM_BACK = 46;
const BOOM_UP = 15;
const LOOK_AHEAD = 26;
/** How much of the aircraft's bank the boom takes. All of it is unflyable. */
const BOOM_ROLL_SHARE = 0.35;
/** Chase spring, per second. Higher is tighter. */
const CHASE_STIFFNESS = 4.5;

export class Seaplane {
  readonly physics: SeaplanePhysics;
  readonly input = new PilotInput();
  readonly parts: AircraftParts;
  readonly group: THREE.Group;

  private readonly config: SeaplaneConfig;
  private readonly startHeading: number;
  private readonly startX: number;
  private readonly startZ: number;

  private propAngle = 0;
  private readonly chasePosition = new THREE.Vector3();
  private readonly chaseTarget = new THREE.Vector3();
  private chaseSeeded = false;

  /* Scratch. */
  private readonly tmp = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly flat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, sea: WaveSurface, options: SeaplaneOptions) {
    this.config = options.config ?? BOMBER;
    this.startX = options.startX;
    this.startZ = options.startZ;
    this.startHeading = options.heading;

    this.physics = new SeaplanePhysics(this.config, sea);
    this.parts = buildSeaplane();
    this.group = this.parts.root;
    scene.add(this.group);

    this.reset();
  }

  get state(): FlightState {
    return this.physics.state;
  }

  /** Back to the mooring, engines off. */
  reset(): void {
    this.physics.moorAt(this.startX, this.startZ, this.startHeading);
    this.input.controls.throttle = 0;
    this.input.controls.pitch = 0;
    this.input.controls.roll = 0;
    this.input.controls.yaw = 0;
    this.chaseSeeded = false;
    this.sync();
  }

  update(dt: number): void {
    const controls = this.input.update(dt);
    this.physics.step(dt, controls);
    this.sync();

    // Propeller rate follows the engines, not the lever — so the discs spin up through the
    // spool and the eye reads the delay the same way the seat of the pants does.
    this.propAngle += (6 + this.physics.engine * 78) * dt;
    for (const p of this.parts.propellers) p.rotation.z = this.propAngle;
  }

  private sync(): void {
    this.group.position.copy(this.physics.position);
    this.group.quaternion.copy(this.physics.orientation);
  }

  /**
   * Drive a camera from the chase boom.
   *
   * Called after `update` so the camera lags this frame's pose rather than last frame's.
   */
  driveCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    // The boom's frame: the aircraft's heading, plus a share of its bank. Pitch is dropped
    // outright — a boom that follows the nose down puts the camera in the sea on every dive.
    const e = new THREE.Euler().setFromQuaternion(this.physics.orientation, 'YXZ');
    this.flat.setFromAxisAngle(this.up, e.y);
    const roll = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      e.z * BOOM_ROLL_SHARE,
    );
    this.flat.multiply(roll);

    this.desired.set(0, BOOM_UP, -BOOM_BACK).applyQuaternion(this.flat).add(this.physics.position);
    // Never below the swell: the boom sits behind an aircraft that spends its life at zero
    // altitude, so without a floor the camera spends the takeoff run underwater.
    this.desired.y = Math.max(this.desired.y, this.physics.position.y + 4);

    this.tmp.set(0, 2, LOOK_AHEAD).applyQuaternion(this.flat).add(this.physics.position);

    if (!this.chaseSeeded) {
      this.chasePosition.copy(this.desired);
      this.chaseTarget.copy(this.tmp);
      this.chaseSeeded = true;
    } else {
      // Frame-rate independent exponential approach. A raw lerp factor makes the camera
      // tighter at high frame rates, which is a bug you only notice on someone else's machine.
      const k = 1 - Math.exp(-CHASE_STIFFNESS * dt);
      this.chasePosition.lerp(this.desired, k);
      this.chaseTarget.lerp(this.tmp, k);
    }

    camera.position.copy(this.chasePosition);
    camera.up.copy(this.up);
    camera.lookAt(this.chaseTarget);
    camera.updateMatrixWorld(true);
  }

  dispose(): void {
    this.input.dispose();
    this.group.removeFromParent();
    for (const m of this.parts.materials) m.dispose();
  }
}
