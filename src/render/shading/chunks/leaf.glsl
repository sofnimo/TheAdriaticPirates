// =====================================================================
// LEAVES — the 2D blades that clad a canopy crown.
//
// ONE COPY, INCLUDED BY BOTH PASSES. The canopy draws twice: once for the camera and once
// into each shadow cascade through its `customDepthMaterial`. Both have to place a leaf at
// exactly the same point in the world and cut exactly the same silhouette out of it, or a leaf
// casts a shadow shaped like the quad it was cut from and the crowns grow rectangular holes of
// shade. Placement and outline therefore live here rather than in either shader, and neither
// pass can drift from the other without editing this file.
//
// WORLD-FIXED, NOT CAMERA-FACING. `05 §7` rejects billboards because they turn to face the
// aircraft, which destroys any fixed sun-side placement — as the plane circles, every leaf
// would present the same face and the lit flank would follow the camera around. These leaves
// are pinned: a leaf's plane is decided once, on the CPU, in the crown's own frame, and after
// the per-crown yaw it is a constant direction in the world. So the pattern of which leaves
// catch the sun is a property of the sun and the ground, and it holds still while you fly
// around it. It changes when the SUN moves, which is the point.
//
// THE COST OF THAT, STATED. `05 §215` suppresses per-leaf normals because they "give a rapidly
// changing field of Lambert dots that shifts with camera motion and mip level". Half of that
// objection does not apply here — nothing shifts with camera motion once the normals are
// world-fixed — but the mip half is real: at range a leaf falls under a pixel and the field
// will sparkle. `uLeafFade*` is the answer, collapsing leaves to nothing over a distance band
// and leaving the smooth hull underneath to carry the crown as the painted mass the doc wants.
// Near, you get leaves; far, you get the mass; the changeover is a size ramp, not a pop.
// =====================================================================

uniform float uLeafSize;        // metres, the short axis of a leaf
uniform float uLeafAspect;      // long:short — a leaf is a lens, not a disc
uniform float uLeafFadeStart;   // metres from the eye where leaves begin to shrink away
uniform float uLeafFadeEnd;     // metres where only the hull is left

/**
 * Rotate a direction about +Y. One yaw per crown, so neighbouring crowns do not wear the same
 * arrangement of leaves — without it the scatter is baked once into the shared geometry and
 * every tree on the island is the same tree.
 */
vec3 leafYaw(vec3 v, float s, float c) {
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

/**
 * Where one corner of one leaf ends up, in world space.
 *
 * @param anchor  the leaf's root on the unit dome (shared by its four corners)
 * @param u,v     the leaf's in-plane axes, unit, in crown space
 * @param corner  which corner, each component -1 or +1
 * @param sizeMul per-leaf size variation
 * @param centre  the crown's world centre
 * @param radius  the crown's three radii
 * @param s,c     sin and cos of the crown's yaw
 * @param grow    0 collapses the leaf to its anchor point; 1 is full size
 */
vec3 leafCorner(
  vec3 anchor, vec3 u, vec3 v, vec2 corner, float sizeMul,
  vec3 centre, vec3 radius, float s, float c, float grow
) {
  // The ROOT rides the ellipsoid, so leaves follow the crown's shape and its per-axis radii.
  vec3 root = centre + leafYaw(anchor, s, c) * radius;
  // The BLADE is in metres and does not take the crown's scale. A leaf on a wide crown is the
  // same leaf as one on a narrow crown — stretching it with the hull would make big trees look
  // like small trees photographed closer, which is the tell that gives procedural foliage away.
  float half = 0.5 * uLeafSize * sizeMul * grow;
  vec3 du = leafYaw(u, s, c) * (corner.x * half);
  vec3 dv = leafYaw(v, s, c) * (corner.y * half * uLeafAspect);
  return root + du + dv;
}

/** How much of a leaf survives at this range. 1 near, 0 past the fade. */
float leafGrow(vec3 centre, vec3 eye) {
  return 1.0 - smoothstep(uLeafFadeStart, max(uLeafFadeEnd, uLeafFadeStart + 1.0), distance(centre, eye));
}

/**
 * The silhouette: is this point inside the blade?
 *
 * A LENS WITH A POINT, cut in the quad's own space with `uv` running -1..1 and the tip toward
 * +y. The width closes to nothing at both ends and swells below the middle, which is the shape
 * that reads as a leaf rather than as a petal or a grain of rice. `rand` bends the outline a
 * little per leaf, because a few dozen identical blades on one crown read as a pattern.
 *
 * A hard test, not a soft coverage value: 00 §3 forbids the gradient, and an alpha-tested edge
 * keeps the leaf in the opaque pass where it can depth-test against its neighbours.
 */
bool leafInside(vec2 uv, float rand) {
  float t = clamp(uv.y * 0.5 + 0.5, 0.0, 1.0);
  // sin() over a warped t: zero at base and tip, fattest below the middle.
  float w = sin(pow(t, 0.7) * 3.14159265);
  w = pow(max(w, 0.0), 0.75);
  // Per-leaf bend, so one edge runs fuller than the other.
  w *= 1.0 + (rand - 0.5) * 0.35 * sin(t * 3.0 + rand * 6.2831853);
  return abs(uv.x) <= w;
}
