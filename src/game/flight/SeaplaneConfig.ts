/**
 * THE FLYING BOAT — mass, wing, propeller and hull, as one parameter block.
 *
 * A four-engine patrol bomber on a boat hull: the Adriatic pirates' aircraft, not a light
 * float plane. Every number below is in SI and every one of them is load-bearing, because the
 * takeoff run is an emergent result of the balance between them rather than a scripted
 * animation. Changing the mass without changing the wing changes the speed the hull unsticks
 * at, and that is correct.
 *
 * THE HULL IS WHAT MAKES IT A SEAPLANE. A wheeled aircraft accelerates on a rolling-friction
 * term that barely changes with speed. A flying boat does something much more interesting and
 * much more visible:
 *
 *   1. DISPLACEMENT. At rest and at low speed the hull sits deep, pushing its own weight of
 *      water aside. Drag is enormous and rises with the square of speed; the aircraft feels
 *      glued down and the nose rides high on its own bow wave.
 *   2. THE HUMP. Around a third of flying speed the bow wave and the drag peak together. This
 *      is the wall the throttle has to break through, and it is the moment the run either
 *      works or does not.
 *   3. PLANING. Past the hump the hull climbs onto its step, the wetted length collapses to a
 *      few metres, and drag falls off a cliff. Acceleration roughly doubles for no change in
 *      thrust — the characteristic surge every seaplane takeoff has.
 *   4. UNSTICK. The wing is already carrying most of the weight by then; the last of the hull
 *      leaves the water and the aircraft is flying.
 *
 * `hullDrag` and `planingLift` below are what produce that curve. They are not a friction
 * fudge — the drag term is scaled by how much hull is still wetted, and the wetted depth is
 * itself reduced by the planing lift, so the two feed back into each other and the hump falls
 * out of the loop instead of being placed on it.
 */
export interface SeaplaneConfig {
  readonly mass: number;
  /** Diagonal inertia tensor in body axes: roll (X), yaw (Y), pitch (Z). kg·m². */
  readonly inertia: readonly [number, number, number];

  /* ------------------------------------------------------------------------ propeller */
  /** Newtons at full throttle, standing still. Four engines' worth. */
  readonly staticThrust: number;
  /**
   * Airspeed at which the propellers stop producing thrust, m/s.
   *
   * A propeller is not a rocket: its thrust falls as the aircraft catches up with the
   * slipstream. Modelling that is what gives the aircraft a top speed without a fake
   * velocity clamp.
   */
  readonly propWashSpeed: number;
  /** Seconds for the engines to answer the throttle lever. */
  readonly spoolTime: number;

  /* ----------------------------------------------------------------------------- wing */
  readonly wingArea: number;
  /** dCl/dAlpha per radian. */
  readonly liftSlope: number;
  /** Cl at zero angle of attack — the wing is cambered. */
  readonly liftAtZero: number;
  /** Angle of attack the wing stalls at, radians. */
  readonly stallAngle: number;
  /** Parasitic drag coefficient. */
  readonly dragAtZero: number;
  /** Induced drag factor: Cd += inducedDrag * Cl². */
  readonly inducedDrag: number;
  /** Sideways area, for the fuselage's resistance to slipping. m². */
  readonly sideArea: number;

  /* -------------------------------------------------------------------------- control */
  /** Peak control moment at reference speed, N·m per unit of stick. */
  readonly pitchAuthority: number;
  readonly rollAuthority: number;
  readonly yawAuthority: number;
  /** Airspeed the authorities are quoted at, m/s. Below it the controls go soft. */
  readonly controlReferenceSpeed: number;
  /** Aerodynamic rate damping, N·m per rad/s at reference speed. */
  readonly pitchDamping: number;
  readonly rollDamping: number;
  readonly yawDamping: number;
  /** How hard the fin pulls the nose back into the airflow, N·m per radian of slip. */
  readonly weathercock: number;

  /* ----------------------------------------------------------------------------- hull */
  /**
   * Points on the airframe that can touch water, in body coordinates (X right, Y up,
   * Z forward). The hull ones carry the aircraft; the wingtip floats only stop it capsizing.
   */
  readonly contacts: readonly HullContact[];
  /** Newtons per metre of submersion, per unit of a contact's `buoyancy`. */
  readonly buoyancyStiffness: number;
  /** Vertical damping of the hull in water, N per m/s per unit of `buoyancy`. */
  readonly heaveDamping: number;
  /**
   * Displacement drag: N per (m/s)², at full submersion of the hull contacts.
   *
   * The hump. This is the number the throttle has to beat.
   */
  readonly hullDrag: number;
  /**
   * Planing lift: N per (m/s)² of forward speed, at full submersion.
   *
   * What climbs the hull onto its step and collapses the wetted depth, taking `hullDrag`
   * down with it.
   */
  readonly planingLift: number;
  /** Metres of submersion at which a hull contact counts as fully wetted. */
  readonly hullDepth: number;
  /** How hard the water resists the hull being dragged sideways, relative to `hullDrag`. */
  readonly hullLateralDrag: number;
  /** Water-rudder and keel yaw damping, N·m per rad/s while wetted. */
  readonly hullYawDamping: number;
}

export interface HullContact {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Share of the aircraft's displacement this point carries. The hull's should sum to ~1. */
  readonly buoyancy: number;
  /** Whether this point planes and drags. Wingtip floats do not — they only hold it level. */
  readonly hull: boolean;
}

/**
 * The Adriatic Pirates' bomber.
 *
 * Nine tonnes, 26 m span, four radials. Stalls near 33 m/s, unsticks around 42, cruises near
 * 78 and will not be pushed much past 95 — see `propWashSpeed`.
 */
export const BOMBER: SeaplaneConfig = {
  mass: 9000,
  inertia: [58000, 96000, 44000],

  staticThrust: 42000,
  propWashSpeed: 108,
  spoolTime: 2.4,

  wingArea: 92,
  liftSlope: 5.2,
  liftAtZero: 0.26,
  stallAngle: 0.28, // ~16 degrees
  dragAtZero: 0.042,
  inducedDrag: 0.055,
  sideArea: 34,

  pitchAuthority: 165000,
  rollAuthority: 122000,
  yawAuthority: 74000,
  controlReferenceSpeed: 60,
  pitchDamping: 210000,
  rollDamping: 96000,
  yawDamping: 180000,
  weathercock: 240000,

  // Hull fore and aft of the step, then the two wingtip floats. The forward pair carries
  // more, which is why the nose rides high at rest and drops onto the step as it planes.
  contacts: [
    { x: 0, y: -1.5, z: 4.6, buoyancy: 0.34, hull: true },
    { x: 0, y: -1.6, z: 0.4, buoyancy: 0.42, hull: true },
    { x: 0, y: -1.4, z: -3.6, buoyancy: 0.24, hull: true },
    { x: -8.6, y: -1.9, z: 0.8, buoyancy: 0.16, hull: false },
    { x: 8.6, y: -1.9, z: 0.8, buoyancy: 0.16, hull: false },
  ],
  // Sets the draught outright: at rest the hull sinks until stiffness x submersion balances
  // the weight, so this number IS how deep the boat floats. mg / 150 kN/m puts the waterline
  // about 0.6 m up a 2.4 m hull, which is a flying boat riding on its planing bottom rather
  // than a fuselage half under the sea.
  buoyancyStiffness: 150000,
  heaveDamping: 46000,
  hullDrag: 74,
  planingLift: 78,
  hullDepth: 0.9,
  hullLateralDrag: 5.5,
  hullYawDamping: 260000,
};
