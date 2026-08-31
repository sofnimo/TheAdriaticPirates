import * as THREE from 'three';

/**
 * A SMALL ROUNDED LEAF, GENERATED — the alpha the shrub's foliage is cut from.
 *
 * WHY THIS EXISTS AT ALL. `makePineLeafMaterial` repaints only `.rgb`; the vendored comment is
 * explicit that `diffuseColor.a` still comes from the texture, and that alphaTest and three's
 * shadow pass both read it — "drop the texture and the canopy casts rectangles". So the leaf
 * SHAPE in that shader is not a shader property, it is the map's alpha channel. The GLB's is a
 * pine-needle spray. A broadleaf shrub therefore needs a different alpha and nothing else: the
 * colour gradient, the shared wind gust and the matching depth material all carry over
 * untouched.
 *
 * GENERATED RATHER THAN AUTHORED, for the same reason `src/models/` is gitignored: a painted
 * leaf atlas would be a binary that has to be re-copied on every clone, and this is 200 lines
 * of arithmetic that always exists. It is also seeded, so the four variants are reproducible.
 *
 * FOUR VARIANTS IN ONE ATLAS, not four textures. One texture means one material, which means
 * one draw call per shrub rather than four, and the leaf quads pick a cell by UV.
 */

/** Cell size in pixels. Four cells in a 2x2 atlas. */
const CELL = 128;
const ATLAS = CELL * 2;

/** How many cells across and down. Change both or the UV maths below stops agreeing. */
export const LEAF_VARIANTS = 4;

/**
 * Half-width of the blade at `t`, where t runs 0 at the stalk to 1 at the tip.
 *
 * OBOVATE — widest ABOVE the middle, rounded at the tip, tapering to the stalk. That is the
 * shape of most Mediterranean evergreen shrub leaves (myrtle, mastic, box) and it is what
 * makes a leaf read as a leaf rather than as a petal or a grain of rice at a glance. A plain
 * ellipse is symmetric top to bottom and looks like neither.
 *
 * `lean` skews the widest point up or down the blade, `round` how blunt the tip is; the two
 * together are what separates the variants.
 *
 * NOTE THE DIRECTION OF `lean`. The belly sits where `t^lean == 0.5`, i.e. at `0.5^(1/lean)`,
 * so it climbs the blade as `lean` RISES: lean 1 is a symmetric ellipse, lean 1.45 puts the
 * widest point at t = 0.62. Anything below 1 is ovate — widest low, tapering to a point — which
 * is the wrong plant. The variants below are all above 1 for that reason.
 */
function halfWidth(t: number, lean: number, round: number): number {
  if (t <= 0 || t >= 1) return 0;
  // sin() gives zero at both ends; the power warps where the belly sits.
  const belly = Math.sin(Math.PI * Math.pow(t, lean));
  // Blunting the tip: pull the last stretch back toward full width.
  const tip = 1 - Math.pow(Math.max(0, t - round) / Math.max(1e-4, 1 - round), 2.2);
  // 0.30, not 0.5: the blade has to finish INSIDE its atlas cell. The widest point plus the
  // sideways `curve` offset must stay under 0.5 or the cell edge slices a flat side into the
  // leaf, and a blade touching the border bleeds into its neighbour once the mip chain runs.
  // It also sets the aspect — half-width 0.30 over a full-height cell is a blade about twice
  // as long as it is wide, which is where myrtle and box actually sit.
  return Math.pow(belly, 0.72) * (t > round ? Math.max(tip, 0.0) : 1) * 0.3;
}

/**
 * The alpha atlas, as an RGBA DataTexture.
 *
 * RGB IS LEFT WHITE ON PURPOSE. The material overwrites `.rgb` with its own gradient before
 * lighting, so any colour painted here would be thrown away — writing white keeps it obvious
 * that this texture carries exactly one channel of information.
 *
 * The edge is a SOFT RAMP over about a pixel and a half rather than a hard 0/255 cut. The
 * material alpha-tests at 0.6, and a binary alpha would leave that test nothing to interpolate,
 * so every leaf edge would crawl with the sampling grid at distance. A ramp lets the mip chain
 * do its job.
 */
export function makeLeafAtlas(): THREE.DataTexture {
  const data = new Uint8Array(ATLAS * ATLAS * 4);

  // Per-variant shape parameters. Deliberate rather than random: four leaves that differ
  // visibly in outline beat four that differ by noise nobody can see.
  const shapes = [
    { lean: 1.45, round: 0.62, curve: 0.06 },
    { lean: 1.75, round: 0.70, curve: -0.09 },
    { lean: 1.28, round: 0.55, curve: 0.12 },
    { lean: 1.95, round: 0.74, curve: -0.04 },
  ];

  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const shape = shapes[cy * 2 + cx]!;
      for (let py = 0; py < CELL; py++) {
        for (let px = 0; px < CELL; px++) {
          // Cell-local coordinates: u across the blade (-0.5..0.5), t along it (0 at stalk).
          const u = (px + 0.5) / CELL - 0.5;
          const t = (py + 0.5) / CELL;

          // A gentle sideways curve, so the blade is not a mirror-symmetric lozenge. Real
          // leaves lean; a perfectly symmetric one reads as machined.
          const axis = shape.curve * Math.sin(Math.PI * t);
          const w = halfWidth(t, shape.lean, shape.round);

          // Distance outside the outline, in cell units, ramped over ~1.5 px.
          const d = Math.abs(u - axis) - w;
          const edge = 1.5 / CELL;
          const alpha = 1 - Math.min(1, Math.max(0, d / edge + 0.5));

          const x = cx * CELL + px;
          const y = cy * CELL + py;
          const i = (y * ATLAS + x) * 4;
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
        }
      }
    }
  }

  const texture = new THREE.DataTexture(data, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'shrub-leaf-atlas';
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  // The alpha is a mask, not a colour: mipping it in sRGB would darken the ramp and pull every
  // leaf edge inward as it recedes.
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** UV rectangle for one variant, as [u0, v0, u1, v1]. */
export function leafCellUV(variant: number): [number, number, number, number] {
  const v = ((variant % LEAF_VARIANTS) + LEAF_VARIANTS) % LEAF_VARIANTS;
  const cx = v % 2;
  const cy = Math.floor(v / 2);
  return [cx * 0.5, cy * 0.5, cx * 0.5 + 0.5, cy * 0.5 + 0.5];
}
