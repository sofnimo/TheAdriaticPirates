#include ../../render/shading/chunks/gouache_ramp.glsl;
#include ../../render/shading/chunks/csm_shadow.glsl;
#include ../../render/shading/chunks/gerstner.glsl;
#include ../../render/shading/chunks/sea_color.glsl;
#include ../../render/shading/chunks/glints.glsl;
#include ../../render/shading/chunks/aerial_perspective.glsl;
#include ../../render/shading/chunks/shore.glsl;

// =====================================================================
// OPEN-SEA FRAGMENT — `02 — Water.md`.
//
// Order matters: depth -> continuous colour -> shared gouache ramp -> glints -> foam -> haze.
// Colour is decided by depth; the ramp only ever LIGHTS that colour. Getting this
// backwards (lighting first, then tinting by depth) is what turns a gouache sea into a
// generic PBR one.
//
// The depth->colour step is a continuous LUT fetch, not a band quantiser: the reference
// frames show no plateaus wherever depth varies (see sea_color.glsl). The banding that does
// survive is in the LIGHT RESPONSE, which is the gouache ramp's job and is unchanged.
// =====================================================================

uniform vec3 cLagoonEdge;
uniform vec3 cSeaShadow;
uniform float uSeaSatHold;
uniform float uShadowSampleDisplaced;

varying vec3 vWorldPos;
varying vec3 vBasePos;

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  // Analytic wave normal — present even where the geometry is dead flat.
  vec3 normal = gerstnerNormal(vWorldPos.xz);

  // ---- depth-driven colour (the shelf event) ---------------------------------
  // Noise wanders the depth CONTOURS at shape scale; the ramp itself stays continuous.
  float depth01 = wanderedDepth(sampleSeaDepth01(vWorldPos.xz), vWorldPos.xz);
  vec3 base = seaColor(depth01);

  // ---- shared gouache ramp, with a depth-following shadow tint ----------------
  vec3 sunDir = normalize(uSunDirection);
  float ndotl = dot(normal, sunDir);
  vec3 tint = seaShadowTint(depth01, cLagoonEdge, cSeaShadow);

  // THE SIGNATURE SHOT — 04 §3.3, "the strongest storytelling device you have".
  //
  // Two details make it read as a painted silhouette rather than as a shadow-mapped blob, and
  // both are here rather than in the lookup. It is sampled at `vBasePos`, the UNDISPLACED
  // surface, so the outline stays rigid instead of rippling with the swell. And the normal
  // handed to the lookup is straight up, not the wave normal: offsetting along a normal that
  // is itself oscillating would reintroduce exactly the swimming that sampling the base plane
  // removed. The hard cut that turns this into a single-tone cut-out lives in the ramp, where
  // every other surface gets it too.
  //
  // `uShadowSampleDisplaced` is the negative control, in the same spirit as `?foam=smooth`:
  // set to 1 it does the wrong thing on purpose — samples the shadow against the displaced
  // surface — so the shadow gate can measure that the correct path is measurably steadier
  // rather than having to pick an absolute threshold for "steady enough" on a moving sea.
  vec3 shadowPos = mix(vBasePos, vWorldPos, uShadowSampleDisplaced);
  float shadow = sunShadow(shadowPos, vec3(0.0, 1.0, 0.0));
  vec3 color = applyGouacheRampTinted(base, tint, ndotl, shadow, normal, viewDir, 0.0);

  // ---- painted glints ---------------------------------------------------------
  // `facing` gates glints onto sun-facing wave faces. The half-vector is used only as a
  // MASK; the visible mark is a hard step, never the lobe itself (02 §3.1, §4.3).
  vec3 halfVec = normalize(sunDir + viewDir);
  float facing = pow(clamp(dot(normal, halfVec), 0.0, 1.0), 6.0);
  // Glint colour is derived from the shaded water beneath it (hue held, saturation halved,
  // lightness lifted +0.185) rather than from fixed hexes, so it tracks the depth ramp.
  vec4 glint = glintField(vWorldPos.xz, facing, color, depth01, length(cameraPosition - vWorldPos));
  color = mix(color, glint.rgb, glint.a);

  // ---- shoreline foam ---------------------------------------------------------
  // Laid over the water AFTER the ramp and the glints, and BEFORE the haze:
  // foam is a surface on the water, so it takes the atmosphere the water takes, but it is not
  // itself lit by the depth ramp — it is white pigment, not sea. 02b §7.1 attaches the shoreline
  // system at exactly this point in the water shader.
  vec4 foam = shoreFoam(vWorldPos.xz, 1.0);
  color = mix(color, foam.rgb, foam.a);

  // ---- NO SKY REFLECTION ------------------------------------------------------
  //
  // There was a Schlick-ish Fresnel here mirroring the live sky into the water, at 0.35. It
  // has been removed rather than turned down: it was the gloss on the sea.
  //
  // The reason it read as gloss is that a Fresnel term is a CONTINUOUS function of viewing
  // angle, and it climbs hardest exactly where the water occupies most of the frame — the
  // grazing middle distance. So it laid a smooth sheen right across the sea's flat colour
  // bands, which is the gradient 00 §3 rule 1 exists to forbid, and it read as varnish over
  // the paint rather than as water.
  //
  // What it was for is still covered. Sun response is the painted glints above, which are
  // discrete marks rather than a gradient (02 §3), and the sky's own colour still reaches the
  // water through the haze below, which is a colour lerp and stays banded.
  //
  // ---- haze, applied once, by the shared chunk --------------------------------
  // satHold=1: the sea lightens with distance but does NOT wash out, which is what the
  // reference frames measure (water holds s=0.91-0.99 to the horizon while distant land
  // collapses to s=0.06-0.20). See aerial_perspective.glsl.
  color = applyAerialPerspectiveTinted(color, vWorldPos, cameraPosition, uSeaSatHold);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
