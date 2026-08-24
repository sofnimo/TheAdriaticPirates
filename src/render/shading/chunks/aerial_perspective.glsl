#include ./sky_gradient.glsl;
#include ./hsl.glsl;

// =====================================================================
// AERIAL PERSPECTIVE — `04 — Light and Shadow.md` §5.2.
//
// A colour lerp toward the sky, NOT grey fog. 00 §3 rule 5: distant land desaturates
// *and shifts to the sky's cyan* within ~3 km. `scene.fog` / FogExp2 converge everything
// on one flat colour and kill hue, which is why this is a bespoke chunk instead.
//
// Applied ONCE, here, in the shared chunk — never per-system (doc index, cross-doc deps).
// =====================================================================

uniform vec3  uHazeColorNear;    // #b1cbd3
uniform float uHazeDensity;      // 0.0001-0.00035, view-distance dependent (04 §5.3)
uniform float uHazeHeightFalloff; // ~0.0012 (1/m)
uniform float uHazeStrength;     // global scale, for debugging. 1.0 in flight.
/**
 * Haze fraction over which a satHold surface hands its saturation back. Measured off the
 * final band of peninsula-coastline-aerial-clouds and plane-over-archipelago-wide, where the
 * collapse takes ~14 px out of a ~420 px sea field — very late, very fast.
 */
uniform vec2 uSatHoldKnee;
/**
 * Ceiling on the haze fraction for OPAQUE LAND.
 *
 * 00 §3 rule 5 says distant land "shifts to the sky's cyan within ~3 km", and the lerp will
 * happily take it all the way there. The frames say it never arrives. Measured against the
 * sky immediately above each landmass:
 *
 *   plane-over-archipelago-wide  far ridge l=0.47 under sky l=0.53   (0.06 below)
 *                                mid island l=0.44 under sky l=0.69  (0.25 below)
 *   peninsula-coastline-aerial   far island l=0.41 under sky l=0.66  (0.25 below)
 *                                far island l=0.25 under sky l=0.66  (0.41 below)
 *
 * Distant land desaturates almost completely — s=0.06-0.15 — while holding a value well
 * under the sky's, which is what keeps the silhouette readable at range. Letting it converge
 * fully is what turned a 2.5 km island into a pale smear. The sea does not use this: it DOES
 * merge into the horizon band, so it passes 1.0.
 */
uniform float uHazeCeiling;

/**
 * SATURATION HOLD — why the sea is not hazed like the land.
 *
 * 00 §3 rule 5 is written about LAND, and measuring the frames shows that is not an accident.
 * Distant land collapses in saturation exactly as the rule says: across
 * plane-over-archipelago-wide the islands read s=0.09, s=0.06, s=0.11 from near to far, and
 * peninsula-coastline-aerial-clouds goes s=0.80 on the foreground hills to s=0.20 on the
 * mid-distance spine.
 *
 * The SEA does not do this. In the same two frames the water holds s=0.91-0.99 from the
 * foreground all the way to the horizon band, while its lightness climbs (0.12 -> 0.22 in the
 * archipelago, 0.19 -> 0.34 on the peninsula) and its hue rotates a few degrees toward the
 * horizon's cyan. Distance lightens the sea; it does not wash it out.
 *
 * That distinction cannot be had by tuning density, because the failure is not one of amount.
 * Sea colour is very dark, and a small lerp in LINEAR space toward a bright sky is an
 * enormous move in perceptual terms: 7% haze on #04414f lands on #32505d, dropping saturation
 * from 0.88 to 0.30 while the haze fraction still reads as "barely any". So `satHold` puts the
 * saturation back after the lerp, leaving the lightness and hue shift intact.
 *
 * THE HOLD IS NOT ABSOLUTE. It is late-onset with a sharp knee, and the knee is measurable.
 * Walking peninsula-coastline-aerial-clouds one pixel row at a time into the horizon at
 * x=120: s stays 0.96-0.99 from y=175 down to y=161, then collapses over FOURTEEN pixels —
 * 0.91, 0.82, 0.75, 0.51, 0.43, 0.41, 0.35 — bottoming out near the haze colour's own s=0.28
 * while lightness climbs 0.25 to 0.65. plane-over-archipelago-wide does the same thing, and
 * its foreground-to-horizon walk (s 0.97 -> 0.87 -> 0.46) is what rules out a flat hold.
 *
 * So the hold is released as a function of the haze fraction itself: essentially nothing
 * across the near and middle field, then a rapid handover in the final band. Land never
 * enters this path at all — it passes satHold = 0 and keeps rule 5's curve unchanged.
 *
 * @param color     the already-shaded surface colour, linear
 * @param worldPos  fragment world position
 * @param eyePos    camera world position
 * @param satHold   0 = land behaviour (desaturates, per rule 5); 1 = sea behaviour
 */
vec3 applyAerialPerspectiveTinted(vec3 color, vec3 worldPos, vec3 eyePos, float satHold) {
  vec3 toFragment = worldPos - eyePos;
  float viewDist = length(toFragment);
  vec3 viewDir = toFragment / max(viewDist, 1e-4);

  // Exponential falloff is fine for the *curve*; the failure mode 04 §5.1 warns about
  // isn't the math, it's lerping toward grey.
  float distFactor = 1.0 - exp(-viewDist * uHazeDensity);

  // Height term: near-horizontal rays over the water accumulate more atmosphere than
  // steep rays onto near ground, so a coastline at sea level hazes faster than a cloud
  // at the same distance but higher up.
  float heightFactor = exp(-max(worldPos.y, 0.0) * uHazeHeightFalloff);
  float haze = clamp(distFactor * mix(0.4, 1.0, heightFactor), 0.0, uHazeCeiling) * uHazeStrength;

  // THE FAR COLOUR IS SAMPLED LIVE FROM THE SKY MODEL, in the actual view direction —
  // it is the sky this fragment is seen against, not a second hardcoded copy of the
  // horizon hex. Retune the sky and the haze retunes with it, by construction.
  vec3 hazeFar = skyGradient(viewDir);
  vec3 hazeColor = mix(uHazeColorNear, hazeFar, distFactor);

  // Late-onset knee: the hold is full until the haze fraction reaches the last band, then
  // hands over quickly. Without this the sea keeps full saturation right through the horizon,
  // which the archipelago frame contradicts.
  float held = satHold * (1.0 - smoothstep(uSatHoldKnee.x, uSatHoldKnee.y, haze));

  // Desaturate a little BEFORE lerping, so the shift reads as atmosphere rather than
  // as a colour-mixing artifact (04 §5.2 step 3). Scaled by (1 - held): a surface still
  // holding its saturation must not be pre-desaturated either, and one past the knee should
  // desaturate on the same schedule it hands over on.
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 desaturated = mix(color, vec3(luma), haze * 0.35 * (1.0 - held));

  vec3 hazed = mix(desaturated, hazeColor, haze);
  if (held <= 0.001) return hazed;

  // Put the saturation back, keeping the lightness and hue the lerp produced. Done in the
  // same approximate-sRGB space the reference measurements were taken in.
  vec3 originalHsl = rgb2hsl(linearToApproxSrgb(color));
  vec3 hazedHsl = rgb2hsl(linearToApproxSrgb(hazed));
  hazedHsl.y = mix(hazedHsl.y, max(hazedHsl.y, originalHsl.y), held);
  return approxSrgbToLinear(hsl2rgb(hazedHsl));
}

/** Land behaviour, unchanged: desaturates toward the sky's cyan (00 §3 rule 5). */
vec3 applyAerialPerspective(vec3 color, vec3 worldPos, vec3 eyePos) {
  return applyAerialPerspectiveTinted(color, worldPos, eyePos, 0.0);
}
