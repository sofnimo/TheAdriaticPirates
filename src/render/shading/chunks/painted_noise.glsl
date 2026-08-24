#include ./hash_noise.glsl;

// =====================================================================
// PAINTED MOTTLING — the grain that makes a green mass read as painted foliage.
//
// WHAT THIS IS FOR
//
// `peninsula-coastline-aerial-clouds` is the frame this is written against. Its hillsides are
// not smooth green shells: at every distance in that frame the woodland has visible GRAIN —
// dark blue-green clumps scattered over a lighter mid green, irregular, varying in size,
// denser in the valleys than on the ridges. The grain gets finer toward the horizon and
// coarser toward the bottom of frame, but it never becomes a flat fill and it never becomes
// a smooth gradient.
//
// A canopy hull with one colour per band cannot do that. Neither can a texture map, at the
// scales involved. What does it is a noise field that perturbs the BAND THRESHOLD rather
// than the colour: the bands stay perfectly flat — 00 §3 rule 1 is untouched — but the LINE
// between two bands wanders, which is exactly what a brush leaves behind and exactly what
// the frame shows.
//
// This is why it does not violate 00 §3 rule 7's "no visible noise". What lands on screen is
// irregular patches of authored flat colour. There is no noise in the output; there is noise
// in the shape of the boundary, which is the difference between a gouache wash and a
// gradient with grain printed on it.
//
// DISTANCE-ADAPTIVE DETAIL
//
// The octaves fade in as the camera closes, so the mottling resolves the way the reference
// frame's does — coarse patches from altitude, finer structure inside them as you descend,
// nothing appearing all at once. Two things fall out of that for free:
//
//   - It is the correct anti-aliasing. A fixed 2 m noise field seen from 1200 m aliases into
//     a shimmering mess the moment the camera moves; dropping the octaves whose period is
//     below a pixel is the standard fix and costs nothing here because it is the same knob.
//   - It is cheaper where cheapness matters. The far field, which is most of the fragments
//     in an aerial frame, evaluates one octave.
//
// The octaves ADD rather than renormalising. Renormalising would make the coarse pattern
// itself change as detail arrives, so flying toward a hillside would reshape the patches you
// were flying toward instead of resolving them.
// =====================================================================

/**
 * How much fine detail this fragment gets, 0-1.
 *
 * @param dist      camera to fragment, metres
 * @param fullAt    at and below this distance every octave is present
 * @param noneAt    at and beyond this distance only the base octave is
 */
float paintedDetail(float dist, float fullAt, float noneAt) {
  return 1.0 - smoothstep(fullAt, noneAt, dist);
}

/**
 * Signed mottling in roughly -0.5..0.5.
 *
 * Sampled on world XZ sheared by world Y. Sampling flat XZ draws contour lines on a slope —
 * the same failure `terrain_color.glsl`'s strata had, where banding on world Y over gentle
 * ground turned the island into a topographic map. The shear breaks that without needing a
 * true 3D noise.
 *
 * @param baseScale metres per period of the coarsest octave
 */
float paintedMottle(vec3 worldPos, float baseScale, float detail) {
  vec2 p = worldPos.xz + vec2(worldPos.y * 0.41, worldPos.y * -0.29);

  // Coarse patches. Always present, at every distance — this is the layer the reference
  // frame still shows at the horizon.
  float n = valueNoise(p / baseScale) - 0.5;

  // Detail octaves, weighted in one after another so nothing arrives as a step.
  float w1 = clamp(detail * 2.6, 0.0, 1.0);
  float w2 = clamp(detail * 2.6 - 0.8, 0.0, 1.0);
  float w3 = clamp(detail * 2.6 - 1.6, 0.0, 1.0);

  n += (valueNoise(p / (baseScale * 0.42) + 13.7) - 0.5) * 0.55 * w1;
  n += (valueNoise(p / (baseScale * 0.17) + 41.3) - 0.5) * 0.30 * w2;
  n += (valueNoise(p / (baseScale * 0.07) + 77.1) - 0.5) * 0.16 * w3;

  return n;
}

/**
 * The clump layer: a second, sparser field that goes strongly one way rather than wobbling
 * about zero, so it reads as discrete dark masses ON the mid green rather than as texture IN
 * it. This is the frame's scattered dark blobs, and it is what stops a hillside looking like
 * one colour with grain.
 *
 * Returns 0-1, mostly 0.
 */
float paintedClumps(vec3 worldPos, float scale, float coverage, float detail) {
  vec2 p = worldPos.xz + vec2(worldPos.y * 0.33, worldPos.y * -0.21);
  float n = fbm2(p / scale);
  // A hard-shouldered window, not a smooth ramp: the blobs in the frame have edges.
  float clump = smoothstep(1.0 - coverage - 0.06, 1.0 - coverage + 0.06, n);
  // Fine clumps join in close up, so a mass that read as four blobs from the air resolves
  // into a dozen crowns from low down.
  float fine = fbm2(p / (scale * 0.34) + 23.1);
  clump = max(clump, smoothstep(1.0 - coverage * 0.7 - 0.05, 1.0 - coverage * 0.7 + 0.05, fine) * detail);
  return clamp(clump, 0.0, 1.0);
}
