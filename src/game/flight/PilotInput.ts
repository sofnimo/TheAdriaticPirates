import type { ControlInput } from './SeaplanePhysics';

/**
 * THE PILOT'S SEAT.
 *
 * One of the four crew positions — the others (front gunner, rear gunner, navigator) will
 * read from the same input layer when they exist, which is why this owns a control block
 * rather than writing straight into the physics.
 *
 * THE THROTTLE IS A LEVER, THE STICK IS SPRUNG. That difference is the whole feel of the
 * aircraft. The throttle holds where it is put and is moved by held keys at a fixed rate,
 * because a pilot sets power and leaves it; the stick returns to centre when released, at a
 * rate slower than it moves out, because control surfaces do not snap back. Wiring both to
 * raw key state gives an aeroplane that flies like a cursor.
 */

const BINDINGS: Record<string, keyof PressedKeys> = {
  KeyW: 'throttleUp',
  KeyS: 'throttleDown',
  ArrowUp: 'noseDown',
  ArrowDown: 'noseUp',
  ArrowLeft: 'rollLeft',
  ArrowRight: 'rollRight',
  KeyA: 'yawLeft',
  KeyD: 'yawRight',
};

interface PressedKeys {
  throttleUp: boolean;
  throttleDown: boolean;
  noseUp: boolean;
  noseDown: boolean;
  rollLeft: boolean;
  rollRight: boolean;
  yawLeft: boolean;
  yawRight: boolean;
}

/** Lever travel per second, as a fraction of full. Roughly four seconds stop to stop. */
const THROTTLE_RATE = 0.55;
/** Stick travel per second when held, and when released. */
const STICK_OUT = 3.2;
const STICK_RETURN = 2.1;

export class PilotInput {
  enabled = false;

  readonly controls: ControlInput = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };

  private readonly keys: PressedKeys = {
    throttleUp: false,
    throttleDown: false,
    noseUp: false,
    noseDown: false,
    rollLeft: false,
    rollRight: false,
    yawLeft: false,
    yawRight: false,
  };

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.release);
  }

  /** Cut the engines and centre everything. What switching out of the cockpit calls. */
  release = (): void => {
    for (const k of Object.keys(this.keys) as (keyof PressedKeys)[]) this.keys[k] = false;
  };

  update(dt: number): ControlInput {
    const c = this.controls;
    const k = this.keys;

    if (this.enabled) {
      if (k.throttleUp) c.throttle = Math.min(1, c.throttle + THROTTLE_RATE * dt);
      if (k.throttleDown) c.throttle = Math.max(0, c.throttle - THROTTLE_RATE * dt);
    }

    const axis = (positive: boolean, negative: boolean, current: number): number => {
      if (!this.enabled) return approach(current, 0, STICK_RETURN * dt);
      if (positive && !negative) return Math.min(1, current + STICK_OUT * dt);
      if (negative && !positive) return Math.max(-1, current - STICK_OUT * dt);
      return approach(current, 0, STICK_RETURN * dt);
    };

    c.pitch = axis(k.noseUp, k.noseDown, c.pitch);
    c.roll = axis(k.rollRight, k.rollLeft, c.roll);
    c.yaw = axis(k.yawRight, k.yawLeft, c.yaw);
    return c;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const binding = BINDINGS[e.code];
    if (!binding) return;
    this.keys[binding] = true;
    e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const binding = BINDINGS[e.code];
    if (binding) this.keys[binding] = false;
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.release);
  }
}

function approach(value: number, target: number, step: number): number {
  if (value > target) return Math.max(target, value - step);
  return Math.min(target, value + step);
}
