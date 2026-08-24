import * as THREE from 'three';

/**
 * FREE FLY CAMERA — a debug camera you can take anywhere in the world.
 *
 * Every camera in this project so far is a fixed view: `OceanTestScene`'s `VIEWS` table
 * exists so the probes measure the same framing every run, which is what makes the gate
 * numbers comparable. That is the right call for a gate and the wrong one for looking at an
 * island — you cannot judge a silhouette from six angles somebody else chose.
 *
 * So this does not replace the views, it borrows from them: enabling it seeds the camera
 * from wherever the last preset left it, and disabling it hands the camera back. The probes
 * still move the camera to their own framings when they run; the pose is restored afterwards
 * so a gate re-run does not teleport the pilot.
 *
 * Yaw/pitch are stored explicitly rather than read back off the quaternion. Reading them
 * back accumulates error and, worse, lets roll creep in — a flight camera that slowly tilts
 * is disorienting in a way that is hard to attribute to its cause.
 */

export interface FreeCameraOptions {
  /** Metres per second at neutral throttle. */
  speed?: number;
  /** Radians per pixel of mouse travel. */
  lookSensitivity?: number;
  /** Clamp, in metres. The world is 4 km across and the sky dome is at 10 km. */
  maxAltitude?: number;
  minAltitude?: number;
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
  KeyE: 'up',
  Space: 'up',
  KeyQ: 'down',
  KeyC: 'down',
};

export class FreeCamera {
  enabled = false;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly pressed = new Set<string>();

  private yaw = 0;
  private pitch = 0;
  private speed: number;
  private readonly lookSensitivity: number;
  private readonly maxAltitude: number;
  private readonly minAltitude: number;
  private boost = false;
  private crawl = false;
  private pointerLocked = false;
  /** Set while the mouse is held down, for drag-look when pointer lock is unavailable. */
  private dragging = false;

  private readonly onChange: (() => void)[] = [];

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, options: FreeCameraOptions = {}) {
    this.camera = camera;
    this.canvas = canvas;
    this.speed = options.speed ?? 120;
    this.lookSensitivity = options.lookSensitivity ?? 0.0022;
    this.maxAltitude = options.maxAltitude ?? 4000;
    // Not zero: at sea level the camera sits inside the ocean's near ring and the frame
    // fills with backfaces. Half a metre of clearance is enough and still reads as "on the
    // water", which is the altitude the seaplane cares about.
    this.minAltitude = options.minAltitude ?? 0.5;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseKeys);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  /** Called whenever the camera is moved by this controller, so the HUD can repaint. */
  onMove(cb: () => void): void {
    this.onChange.push(cb);
  }

  /**
   * Take control, starting from the camera's current pose.
   *
   * The seeding is the point. Switching to the free camera from the `island` view should put
   * you exactly where that view was looking, not at some fixed spawn — the preset framings
   * are the interesting places to start from, which is why they exist.
   */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.readPoseFromCamera();
    this.canvas.style.cursor = 'crosshair';
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.releaseKeys();
    this.exitPointerLock();
    this.canvas.style.cursor = '';
  }

  /** Adopt the camera's current orientation as the controller's yaw/pitch. */
  readPoseFromCamera(): void {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.applyRotation();
  }

  /** Remember the pose so a probe can move the camera and this can put it back. */
  capturePose(): { position: THREE.Vector3; yaw: number; pitch: number } {
    return { position: this.camera.position.clone(), yaw: this.yaw, pitch: this.pitch };
  }

  restorePose(pose: { position: THREE.Vector3; yaw: number; pitch: number }): void {
    this.camera.position.copy(pose.position);
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    this.applyRotation();
    this.camera.updateMatrixWorld(true);
  }

  update(dt: number): void {
    if (!this.enabled) return;

    const move = new THREE.Vector3(
      (this.pressed.has('right') ? 1 : 0) - (this.pressed.has('left') ? 1 : 0),
      (this.pressed.has('up') ? 1 : 0) - (this.pressed.has('down') ? 1 : 0),
      (this.pressed.has('back') ? 1 : 0) - (this.pressed.has('forward') ? 1 : 0),
    );
    if (move.lengthSq() === 0) return;

    // Horizontal movement follows the heading, vertical is world-up. Flying "forward" while
    // looking down should not drive you into the sea, and Q/E should be a lift whatever the
    // camera is pointed at — this is a survey camera, not an aircraft.
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const pitchedForward = forward.clone().multiplyScalar(Math.cos(this.pitch));
    pitchedForward.y = Math.sin(this.pitch);

    const step = this.speed * dt * (this.boost ? 6 : 1) * (this.crawl ? 0.18 : 1);
    const delta = new THREE.Vector3()
      .addScaledVector(pitchedForward, -move.z)
      .addScaledVector(right, move.x)
      .addScaledVector(new THREE.Vector3(0, 1, 0), move.y)
      .multiplyScalar(step);

    this.camera.position.add(delta);
    this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, this.minAltitude, this.maxAltitude);
    this.camera.updateMatrixWorld(true);
    this.emit();
  }

  /** One line for the on-screen readout. */
  status(): string {
    const p = this.camera.position;
    const heading = ((-this.yaw * 180) / Math.PI + 360) % 360;
    const mult = this.boost ? ' x6' : this.crawl ? ' x0.18' : '';
    return (
      'x ' + p.x.toFixed(0) + '  y ' + p.y.toFixed(0) + '  z ' + p.z.toFixed(0) +
      '   hdg ' + heading.toFixed(0) + 'deg  pitch ' + ((this.pitch * 180) / Math.PI).toFixed(0) + 'deg' +
      '   speed ' + this.speed.toFixed(0) + ' m/s' + mult
    );
  }

  setSpeed(v: number): void {
    this.speed = THREE.MathUtils.clamp(v, 2, 2000);
  }

  get currentSpeed(): number {
    return this.speed;
  }

  dispose(): void {
    this.disable();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseKeys);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  // ------------------------------------------------------------------ input

  private applyRotation(): void {
    // YXZ order with roll pinned at zero. Building the quaternion from an Euler in this
    // order is what guarantees the horizon stays level however far the look drifts.
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private emit(): void {
    for (const cb of this.onChange) cb();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    // Never swallow typing in the debug panel's number fields.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    this.boost = e.shiftKey;
    this.crawl = e.altKey;
    const action = KEY_BINDINGS[e.code];
    if (!action) return;
    this.pressed.add(action);
    e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.boost = e.shiftKey;
    this.crawl = e.altKey;
    const action = KEY_BINDINGS[e.code];
    if (action) this.pressed.delete(action);
  };

  private readonly releaseKeys = (): void => {
    this.pressed.clear();
    this.boost = false;
    this.crawl = false;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    this.dragging = true;
    // Pointer lock is the good path — unbounded look, no cursor. It can be refused (no user
    // gesture, an existing lock elsewhere, a browser that declines), so drag-look is kept as
    // the fallback rather than assumed away; without it a refused lock leaves a camera that
    // moves but cannot turn, which reads as a broken build.
    if (document.pointerLockElement !== this.canvas) {
      const request = this.canvas.requestPointerLock?.bind(this.canvas);
      try {
        const result = request?.() as unknown;
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        /* drag-look handles it */
      }
    }
  };

  private readonly onMouseUp = (): void => {
    this.dragging = false;
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
  };

  private exitPointerLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (!this.pointerLocked && !this.dragging) return;

    this.yaw -= e.movementX * this.lookSensitivity;
    this.pitch -= e.movementY * this.lookSensitivity;
    // Just short of straight up/down. At exactly +-90 deg the heading becomes undefined and
    // the camera spins when the mouse is nudged sideways.
    const limit = Math.PI / 2 - 0.02;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
    this.applyRotation();
    this.camera.updateMatrixWorld(true);
    this.emit();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    // Multiplicative, so the same flick is a useful change at 10 m/s and at 800 m/s.
    this.setSpeed(this.speed * (e.deltaY > 0 ? 0.85 : 1.18));
    this.emit();
  };
}
