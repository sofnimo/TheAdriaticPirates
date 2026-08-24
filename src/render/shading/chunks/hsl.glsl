// =====================================================================
// HSL CONVERSION — the only copy.
//
// Two chunks need it and neither should carry its own: the glint rule is authored as
// "hold hue, halve saturation, lift lightness", and aerial perspective needs to hold a
// surface's saturation while letting its lightness and hue drift toward the sky. Both of
// those are HSL statements because that is how the measurements off the reference frames
// came out, so they are applied in HSL rather than approximated in RGB.
//
// NOTE ON COLOUR SPACE. The reference frames are sRGB and every measurement in art/seaRamp.ts
// is an sRGB HSL figure, but the shaders work in linear. Applying an sRGB-derived constant to
// a linear value silently changes what it does, so callers convert. The 2.2 gamma here is the
// cheap approximation, not the piecewise sRGB curve — it is within ~1/255 across the range
// that matters and this runs per-pixel over the whole sea.
// =====================================================================

vec3 linearToApproxSrgb(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
vec3 approxSrgbToLinear(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(2.2)); }

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = d / (1.0 - abs(2.0 * l - 1.0));
  float h;
  if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else                h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

vec3 hsl2rgb(vec3 hsl) {
  float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float h = hsl.x * 6.0;
  float x = c * (1.0 - abs(mod(h, 2.0) - 1.0));
  vec3 rgb;
  if      (h < 1.0) rgb = vec3(c, x, 0.0);
  else if (h < 2.0) rgb = vec3(x, c, 0.0);
  else if (h < 3.0) rgb = vec3(0.0, c, x);
  else if (h < 4.0) rgb = vec3(0.0, x, c);
  else if (h < 5.0) rgb = vec3(x, 0.0, c);
  else              rgb = vec3(c, 0.0, x);
  return rgb + (hsl.z - c * 0.5);
}
