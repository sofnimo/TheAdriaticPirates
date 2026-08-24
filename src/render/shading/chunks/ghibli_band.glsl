// =====================================================================
// THE GHIBLI FOLIAGE BAND — ported from craftzdog/ghibli-style-shader.
//
//   https://github.com/craftzdog/ghibli-style-shader  (src/GhibliShader.js)
//
// The original, in full, is four authored colours and three brightness thresholds:
//
//     float brightness = dot(worldNormal, lightVector);
//     if      (brightness > thresholds[0]) final = colorMap[0];
//     else if (brightness > thresholds[1]) final = colorMap[1];
//     else if (brightness > thresholds[2]) final = colorMap[2];
//     else                                 final = colorMap[3];
//
// That is the whole technique, and it is kept verbatim here — hard `if` chain, no
// smoothstep anywhere, colours read out of a map rather than computed.
//
// WHY IT IS A SEPARATE CHUNK AND NOT A UNIFORM SET ON THE GOUACHE RAMP
//
// 04 §2.2 says do not fork the ramp, and this does not fork it: `gouache_ramp.glsl` is
// untouched and every other surface still runs it. This is a different shading MODEL living
// beside it, and the difference is worth stating because it is the reason the foliage reads
// as painted foliage rather than as green rock:
//
//   - The gouache ramp interpolates. It has ONE authored lit colour and ONE authored shadow
//     tint, and every band between them is `mix(shadowColor, litColor, band)`. The bands are
//     flat, but they sit on a straight line in colour space between two hexes.
//   - This does not interpolate at all. All FOUR tones are authored, so the darks are free
//     to rotate hue independently of the lights. In the source repo the map runs
//     #427062 -> #33594E -> #234549 -> #1E363F: the greens do not merely darken, they swing
//     toward teal and then toward the sky's blue. That hue path is not on the line between
//     the first and last colour, so a two-endpoint lerp cannot produce it.
//
// 00 §3 rule 2 asks for exactly that behaviour ("shadows are a hue shift, never a multiply"),
// and 00 §2's land greens already form the same ladder — #8eac71 -> #6a955f -> #45764e ->
// #1f4e38 -> #101d19 goes green to blue-green as it darkens. So the colour maps this ships
// with are authored palette hexes in palette order, not the repo's teals.
// =====================================================================

/**
 * @param brightness  dot(worldNormal, sunDir), unclamped as in the original
 * @param colorMap    four authored tones, lit to darkest
 * @param thresholds  three cuts, descending
 */
vec3 ghibliBand(float brightness, vec3 colorMap[4], vec3 thresholds) {
  if (brightness > thresholds.x) return colorMap[0];
  if (brightness > thresholds.y) return colorMap[1];
  if (brightness > thresholds.z) return colorMap[2];
  return colorMap[3];
}
