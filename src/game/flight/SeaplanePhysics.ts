import * as THREE from 'three';
import type { WaveSurface } from '../../world/ocean/waveSurface';
import type { SeaplaneConfig } from './SeaplaneConfig';

/**
 * SIX-DEGREE-OF-FREEDOM RIGID BODY, WITH A HULL IN THE WATER.
 *
 * Forces and moments are accumulated in BODY axes and integrated semi-implicitly. Body axes
 * because every term that matters is naturally expressed there — thrust along the propeller
 * shaft, lift perpendicular to the wing, buoyancy at a point on the hull — and converting
 * each one into world space separately is how sign errors get in. Only gravity is applied in
 * world space, which is the one force that genuinely is.
 *
 * SEMI-IMPLICIT EULER, and the choice is not lazy. The stiffest thing here by a wide margin
 * is the buoyancy spring: 62 kN per metre against nine tonnes is a natural period of about
 * 1.5 s, and it sits under a damper. Explicit Euler on a stiff spring-damper gains energy and
 * the aircraft pogos itself out of the water; updating velocity first and then integrating
 * position with the NEW velocity is what makes the same spring lose energy instead. The
 * substep loop below then keeps the timestep well inside the spring's period however badly
 * the frame rate behaves, because a dropped frame must not launch the aeroplane.
 *
 * ANGLE OF ATTACK IS MEASURED, NEVER TRACKED. It is the angle between where the wing is
 * pointing and where the aircraft is actually going, so it falls out of the velocity vector
 * in body axes and cannot drift out of step with the flight path.
 */

export interface ControlInput {
  /** 0-1 lever position. The engines lag it — see `spoolTime`. */
  throttle: number;
  /** -1 nose down to +1 nose up. */
  pitch: number;
  /** -1 left to +1 right. */
  roll: number;
  /** -1 left to +1 right. */
  yaw: number;
}

export interface FlightState {
  /** Metres per second through the air. */
  airspeed: number;
  /** Radians. Positive is nose-up relative to the flight path. */
  angleOfAttack: number;
  /** Radians of sideslip. */
  sideslip: number;
  /** Metres above the local sea surface, at the hull's reference point. */
  altitude: number;
  /** 0-1, how much of the hull is still in the water. 0 is airborne. */
  wetted: number;
  /** Newtons the wing is producing. */
  lift: number;
  /** Newtons the propellers are producing. */
  thrust: number;
  /** True once the wing is carrying the aircraft and the hull is clear. */
  airborne: boolean;
  /** True while the wing is past its stall angle. */
  stalled: boolean;
  /** Metres per second, vertical. */
  climbRate: number;
}

const AIR_DENSITY = 1.225;
const GRAVITY = 9.81;
/** Physics substep, seconds. Well inside the buoyancy spring's period. See the note above. */
const SUBSTEP = 1 / 240;

export class SeaplanePhysics {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  /** Radians per second, BODY axes: X pitch, Y yaw, Z roll. */
  readonly angularVelocity = new THREE.Vector3();

  /** What the engines are actually delivering, 0-1. Chases the lever. */
  engine = 0;

  readonly state: FlightState = {
    airspeed: 0,
    angleOfAttack: 0,
    sideslip: 0,
    altitude: 0,
    wetted: 1,
    lift: 0,
    thrust: 0,
    airborne: false,
    stalled: false,
    climbRate: 0,
  };

  private readonly config: SeaplaneConfig;
  private readonly sea: WaveSurface;

  /* Scratch, so the integrator allocates nothing per substep. */
  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();
  private readonly bodyVelocity = new THREE.Vector3();
  private readonly inverse = new THREE.Quaternion();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly spin = new THREE.Quaternion();
  private readonly normal = { x: 0, y: 1, z: 0 };

  constructor(config: SeaplaneConfig, sea: WaveSurface) {
    this.config = config;
    this.sea = sea;
  }

  /**
   * Put the aircraft on the water, stationary, pointing along `heading`.
   *
   * Y is set from the wave surface less the hull's draught, so it starts already floating
   * rather than dropping in and bouncing.
   */
  moorAt(x: number, z: number, heading: number): void {
    // The equilibrium draught, so it starts already floating rather than dropping in and
    // bouncing. Derived from the same two numbers the buoyancy uses, not guessed.
    const draught = (this.config.mass * GRAVITY) / this.config.buoyancyStiffness;
    this.position.set(x, this.sea.heightAt(x, z) - this.config.contacts[1]!.y - draught, z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.engine = 0;
  }

  step(dt: number, controls: ControlInput): void {
    // A long frame is split rather than taken whole, and a very long one (a tab coming back
    // from the background) is dropped: catching up half a second of physics in one go is how
    // the aircraft ends up in orbit.
    const total = Math.min(dt, 0.25);
    let remaining = total;
    while (remaining > 1e-5) {
      const h = Math.min(SUBSTEP, remaining);
      this.substep(h, controls);
      remaining -= h;
    }
  }

  private substep(dt: number, controls: ControlInput): void {
    const c = this.config;

    // The lever is not the engine. Four radials take a couple of seconds to answer, and the
    // lag is most of what the takeoff run feels like from the pilot's seat.
    const target = Math.max(0, Math.min(1, controls.throttle));
    this.engine += (target - this.engine) * Math.min(1, dt / c.spoolTime);

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);

    this.inverse.copy(this.orientation).invert();
    this.bodyVelocity.copy(this.velocity).applyQuaternion(this.inverse);

    this.applyAerodynamics(controls);
    this.applyThrust();
    this.applyWater(dt);

    // Gravity is the one force that is genuinely world-space, so it is the one applied there.
    this.force.applyQuaternion(this.orientation);
    this.force.y -= c.mass * GRAVITY;

    // Semi-implicit: velocity first, then position from the NEW velocity. See the note above.
    this.velocity.addScaledVector(this.force, dt / c.mass);
    this.position.addScaledVector(this.velocity, dt);

    const inertia = c.inertia;
    this.angularVelocity.x += (this.torque.x / inertia[2]) * dt; // pitch about body X
    this.angularVelocity.y += (this.torque.y / inertia[1]) * dt; // yaw about body Y
    this.angularVelocity.z += (this.torque.z / inertia[0]) * dt; // roll about body Z

    // Quaternion derivative for a body-axis rate, first order, then renormalised. At 240 Hz
    // the truncation error is far below anything visible and it costs one multiply.
    this.spin.set(
      this.angularVelocity.x * dt * 0.5,
      this.angularVelocity.y * dt * 0.5,
      this.angularVelocity.z * dt * 0.5,
      1,
    );
    this.orientation.multiply(this.spin).normalize();

    this.publish();
  }

  /* ------------------------------------------------------------------------ the wing */

  private applyAerodynamics(controls: ControlInput): void {
    const c = this.config;
    const v = this.bodyVelocity;
    // Body axes: +Z forward, +Y up, +X right. Forward speed can go negative in a tail slide.
    const forward = v.z;
    const speed = v.length();
    if (speed < 0.05) {
      this.state.airspeed = speed;
      return;
    }

    // MEASURED, not tracked: where the wing points against where the aircraft is going.
    const alpha = Math.atan2(-v.y, Math.max(forward, 0.1));
    const beta = Math.atan2(v.x, Math.max(forward, 0.1));
    const q = 0.5 * AIR_DENSITY * speed * speed;

    // Lift is linear in alpha until the stall, then falls away rather than being clipped —
    // a clamp keeps full lift at 40 degrees, which lets the aircraft hang on its wing.
    let cl = c.liftAtZero + c.liftSlope * alpha;
    const over = Math.abs(alpha) - c.stallAngle;
    const stalled = over > 0;
    if (stalled) {
      const decay = Math.max(0, 1 - over / 0.35);
      cl *= decay * decay;
    }
    const lift = q * c.wingArea * cl;
    const drag = q * c.wingArea * (c.dragAtZero + c.inducedDrag * cl * cl + (stalled ? 0.9 : 0));
    const side = -q * c.sideArea * Math.sin(beta) * 1.1;

    // Lift acts perpendicular to the airflow, not to the wing. Building it in the body's
    // velocity frame and rotating in is what makes an aircraft in a steep climb lose speed
    // rather than gain free height.
    const inv = 1 / speed;
    const dx = v.x * inv;
    const dy = v.y * inv;
    const dz = v.z * inv;
    // Lift direction: perpendicular to airflow, in the body's vertical plane.
    const lx = -dx * dy;
    const ly = dx * dx + dz * dz;
    const lz = -dz * dy;
    const ln = Math.hypot(lx, ly, lz) || 1;

    this.force.x += (lift * lx) / ln - drag * dx + side;
    this.force.y += (lift * ly) / ln - drag * dy;
    this.force.z += (lift * lz) / ln - drag * dz;

    // Control power goes with dynamic pressure, so the stick is dead on the water and stiff
    // at speed. That is the single most important thing about flying an aeroplane and the
    // easiest to leave out.
    const ref = c.controlReferenceSpeed;
    const authority = Math.min(2.2, (speed * speed) / (ref * ref));
    this.torque.x += c.pitchAuthority * controls.pitch * authority;
    this.torque.z -= c.rollAuthority * controls.roll * authority;
    this.torque.y -= c.yawAuthority * controls.yaw * authority;

    // The fin. Without this the aircraft has no directional stability and flies sideways
    // quite happily, which reads as ice rather than as air.
    this.torque.y -= c.weathercock * Math.sin(beta) * authority;

    this.torque.x -= c.pitchDamping * this.angularVelocity.x * authority;
    this.torque.y -= c.yawDamping * this.angularVelocity.y * authority;
    this.torque.z -= c.rollDamping * this.angularVelocity.z * authority;

    this.state.angleOfAttack = alpha;
    this.state.sideslip = beta;
    this.state.airspeed = speed;
    this.state.lift = lift;
    this.state.stalled = stalled;
  }

  private applyThrust(): void {
    const c = this.config;
    // A propeller loses thrust as the aircraft catches its own slipstream. This is what gives
    // the aeroplane a top speed instead of a velocity clamp.
    const fade = Math.max(0, 1 - Math.max(this.bodyVelocity.z, 0) / c.propWashSpeed);
    const thrust = c.staticThrust * this.engine * fade;
    this.force.z += thrust;
    this.state.thrust = thrust;
  }

  /* ----------------------------------------------------------------------- the water */

  /**
   * Buoyancy, displacement drag and planing, per contact point.
   *
   * The feedback loop the takeoff run is made of lives in `wet`: submersion sets how much
   * drag and how much planing lift a point makes, planing lift pushes the point up, and less
   * submersion means less of both. Thrust breaks the hump by winning that loop.
   */
  private applyWater(dt: number): void {
    const c = this.config;
    let wettedTotal = 0;
    let hullPoints = 0;

    for (const p of c.contacts) {
      if (p.hull) hullPoints++;

      // Contact point in world space, and its own velocity including the rotation of the
      // airframe — a point out on a float is moving much faster than the centre of mass when
      // the aircraft rolls, and that is exactly what stops it rolling further.
      this.tmpA.set(p.x, p.y, p.z).applyQuaternion(this.orientation);
      const worldX = this.position.x + this.tmpA.x;
      const worldY = this.position.y + this.tmpA.y;
      const worldZ = this.position.z + this.tmpA.z;

      const seaY = this.sea.heightAt(worldX, worldZ);
      const submersion = seaY - worldY;
      if (submersion <= 0) continue;

      const wet = Math.min(1, submersion / c.hullDepth);
      if (p.hull) wettedTotal += wet;

      // Velocity of this point in world space: v + omega x r, with omega taken back to world.
      this.tmpB.copy(this.angularVelocity).applyQuaternion(this.orientation);
      this.tmpB.cross(this.tmpA).add(this.velocity);

      // --- buoyancy, along the wave normal so a swell rolls the hull ---------------------
      this.sea.normalAt(worldX, worldZ, this.normal);
      const lift = c.buoyancyStiffness * p.buoyancy * Math.min(submersion, c.hullDepth * 2.2);
      const damp = c.heaveDamping * p.buoyancy * this.tmpB.y * wet;
      const up = Math.max(0, lift - damp);

      let fx = this.normal.x * up;
      let fy = this.normal.y * up;
      let fz = this.normal.z * up;

      if (p.hull) {
        // --- displacement drag: the hump -----------------------------------------------
        // Along the surface only. Scaled by how much hull is wetted, which is the term
        // planing lift is about to reduce.
        const surfaceSpeed = Math.hypot(this.tmpB.x, this.tmpB.z);
        if (surfaceSpeed > 0.01) {
          const share = p.buoyancy;
          const d = c.hullDrag * share * wet * surfaceSpeed;
          fx -= this.tmpB.x * d;
          fz -= this.tmpB.z * d;
          // Sideways the hull is a keel, not a boat: it resists far harder than it does
          // fore and aft, which is what stops the aircraft sliding across the water.
          this.tmpA.set(0, 0, 1).applyQuaternion(this.orientation);
          const alongX = this.tmpA.x;
          const alongZ = this.tmpA.z;
          const lateralX = this.tmpB.x - alongX * (this.tmpB.x * alongX + this.tmpB.z * alongZ);
          const lateralZ = this.tmpB.z - alongZ * (this.tmpB.x * alongX + this.tmpB.z * alongZ);
          fx -= lateralX * d * (c.hullLateralDrag - 1);
          fz -= lateralZ * d * (c.hullLateralDrag - 1);

          // --- planing: the surge ------------------------------------------------------
          const along = this.tmpB.x * alongX + this.tmpB.z * alongZ;
          if (along > 0) fy += c.planingLift * share * wet * along * along;
        }
      }

      // Into body axes to be accumulated with everything else.
      this.tmpB.set(fx, fy, fz).applyQuaternion(this.inverse);
      this.force.add(this.tmpB);

      this.tmpA.set(p.x, p.y, p.z).cross(this.tmpB);
      this.torque.add(this.tmpA);
    }

    const wetted = hullPoints > 0 ? wettedTotal / hullPoints : 0;
    this.state.wetted = wetted;

    // The keel and the water rudder. Dropped as the hull comes out, or the aircraft would
    // still be steering off the water in the air.
    if (wetted > 0) {
      this.torque.y -= c.hullYawDamping * this.angularVelocity.y * wetted;
      // Water damps the roll far harder than air does; without this the hull rocks for ever.
      this.torque.z -= c.hullYawDamping * 0.8 * this.angularVelocity.z * wetted;
      this.torque.x -= c.hullYawDamping * 0.5 * this.angularVelocity.x * wetted;
    }
    // Suppress dt-only lint concerns: the substep length is already folded into the caller.
    void dt;
  }

  private publish(): void {
    const s = this.state;
    s.altitude = this.position.y - this.sea.heightAt(this.position.x, this.position.z);
    s.climbRate = this.velocity.y;
    s.airborne = s.wetted <= 0.001 && s.altitude > 1.5;
  }
}
