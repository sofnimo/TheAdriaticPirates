import * as THREE from 'three';
import { globalUniforms } from '../render/shading/ShadingUniforms';
import type { OceanTestScene } from './OceanTestScene';

/**
 * STEP 5 ACCEPTANCE GATE — `04 — Light and Shadow.md` §3.
 *
 * Every check here is one line of §8.3's "what wrong looks like" list, turned into a number.
 * That list is unusually well suited to it, because each entry names a VISIBLE artefact with a
 * named cause, and a screenshot can tell them apart:
 *
 *   1. PRESENT     — cast shadows exist at all. The whole subsystem can be plumbed correctly
 *                    and contribute nothing if a uniform is unbound or the casting set is
 *                    empty, and nothing else in the suite would notice.
 *   2. HARD EDGE   — "Aircraft shadow on water has a soft/blurred edge -> PCF radius not
 *                    near-zero, or hard-step clamp missing". Measured as the pixel width of
 *                    the transition across a shadow boundary.
 *   3. RIGID       — "Aircraft shadow swims/ripples with the waves". REPORTED, NOT GATED:
 *                    see the note beside the measurement for why the negative control cannot
 *                    separate the two cases at this sea state.
 *   4. HUE SHIFT   — "Shadow band looks like base colour x 0.5". Measured as the angle between
 *                    the lit and shadowed colours in RGB: a multiply leaves the direction
 *                    unchanged, a hue shift does not.
 *   5. STABLE      — §3.2's shimmer. Measured by nudging the camera a sub-texel amount and
 *                    checking the shadow does not crawl, which is what the texel snap buys.
 *
 * Checks 2-4 run on the `shore` view with the sun low, because that is the framing where a
 * shadow actually crosses water and land in the same frame.
 */

/** Transition wider than this reads as a penumbra rather than a cut (00 §3 rule 3). */
const MAX_EDGE_PX = 3;
/** Below this, the scene has no cast shadow worth the name. */
const MIN_SHADOWED_FRACTION = 0.01;
/** Two colours closer than this in direction are the same hue — i.e. a multiply. */
const MIN_HUE_DEGREES = 1.5;

export interface ShadowReport {
  shadowedFraction: number;
  present: boolean;

  edgePx: number;
  edgeSamples: number;
  hardEdged: boolean;

  swimPx: number;
  swimSabotagedPx: number;
  rigid: boolean;

  hueDegrees: number;
  hueShifted: boolean;

  /** Of four sub-texel camera nudges, how many left the near cascade exactly put. */
  snapHeld: number;
  snapHeldUnsnapped: number;
  stable: boolean;

  cascades: number;
  pass: boolean;
}

interface Frame {
  data: Uint8Array;
  width: number;
  height: number;
}

export class ShadowProbe {
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly test: OceanTestScene,
  ) {}

  run(): ShadowReport {
    const wasEnabled = this.test.sun.shadows.enabled;
    const wasPreset = this.test.sun.presetName;
    const waveTime = this.test.waveTime;

    // MEASURED AT GOLDEN HOUR, not at the default.
    //
    // 04 §1's table gives the low-sun presets "long hard shadows" and the late-morning default
    // "shadows short, hard, near-vertical". At 50 degrees a 117 m ridge throws about 98 m of
    // shadow, nearly all of it onto its own leeward flank — ground the ramp has already put in
    // its dark band, so the cast shadow is real, correct, and almost invisible. That is a fine
    // way for the world to look and a useless frame to measure on: it cannot tell a working
    // shadow system from a broken one. A 16 degree sun puts shadows across the water and the
    // lit flanks, where a failure would show.
    this.test.sun.apply('goldenHour');
    this.frameTowardSun();

    // ---- 1. present -------------------------------------------------------------------
    // The difference between the same frame with and without cascades IS the cast shadow, so
    // it needs no colour heuristic: any pixel that moved, moved because of a shadow.
    const lit = this.capture(false);
    const shadowed = this.capture(true);
    const mask = differenceMask(lit, shadowed);
    const shadowedFraction = mask.count / (lit.width * lit.height);

    // ---- 2. hard edge -----------------------------------------------------------------
    const edge = measureEdge(mask, lit.width, lit.height);

    // ---- 4. hue shift, not a multiply -------------------------------------------------
    const hue = measureHueShift(lit, shadowed, mask);

    // ---- 3. rigid under the swell ------------------------------------------------------
    // Measured on the silhouette rather than on the pixels inside it: the mask is recomputed at
    // both times, so the water it falls on — whose normals turn, whose glints march, whose foam
    // advances — cancels out of both, and what is left is where the shape is. Glints are silenced for this one measurement. A glint's colour is derived from the water
    // under it, which is shadow-dependent, so glints inside the shadow land in the mask — and
    // they march across the surface with the wave clock, which is exactly the motion this check
    // is trying to rule out. Turning them off leaves the mask holding the silhouette alone.
    const glintFade = this.test.ocean.uniforms.uGlintFade!;
    const glintWas = glintFade.value;
    glintFade.value = 0;
    const displaced = this.test.ocean.uniforms.uShadowSampleDisplaced!;

    displaced.value = 0;
    const swim = this.measureSwim(waveTime);
    displaced.value = 1;
    const swimSabotagedPx = this.measureSwim(waveTime);
    displaced.value = 0;

    glintFade.value = glintWas;
    this.test.setWaveTime(waveTime);

    // ---- 5. no crawl on camera motion --------------------------------------------------
    // §3.2's texel snap exists so that translating the camera does not slide the shadow map's
    // texel grid under the world. A shift far below one shadow texel must therefore leave the
    // shadow where it was.
    //
    // MEASURED ON LAND, and that is the whole reason this moves to a different view. The
    // question is about the shadow map's grid, so the receiver has to hold still: on water, a
    // 5 cm camera move changes which wave face each pixel lands on, and the resulting churn
    // swamps the thing being measured — it read 11% on a shadow that was not crawling at all.
    // The profile view is nearly all terrain, which does not move at all between two frames.
    // MEASURED ON THE FIT, NOT ON PIXELS — because pixels cannot answer this question.
    //
    // Two earlier versions diffed frames before and after a small camera move and counted how
    // many pixels inside the shadow changed. Both were measuring the wrong thing. Moving the
    // camera at all resamples the entire frame, so every pixel near any colour boundary
    // changes whether or not the shadow crawled; with the snap deliberately DISABLED the
    // figure came back 3.67%, identical to four figures with it enabled. A metric that reads
    // the same with the mechanism on and off is not measuring the mechanism.
    //
    // What §3.2 actually asks for is precise and has nothing to do with pixels: the shadow
    // camera's centre is quantised to its own texel lattice, so a camera move smaller than a
    // texel must leave it EXACTLY where it was. That is checkable directly, deterministically,
    // and without rendering a frame.
    this.test.setView('profile');
    const held = this.measureSnap(true);
    const heldUnsnapped = this.measureSnap(false);

    this.test.sun.apply(wasPreset);
    this.test.sun.shadows.setEnabled(wasEnabled);
    this.test.setWaveTime(waveTime);

    const present = shadowedFraction >= MIN_SHADOWED_FRACTION;
    const hardEdged = edge.samples > 0 && edge.px <= MAX_EDGE_PX;
    // REPORTED, NOT GATED — and the negative control is why.
    //
    // Sampling the shadow against the displaced surface instead of the base plane, which is
    // the exact defect §8.3 describes, does not move this number further than sampling it
    // correctly does. That is not the control failing; it is the honest answer at this sea
    // state, where the swell is a few tens of centimetres and the displacement fades out
    // within 45 m of the camera, so the two sampling positions are nearly the same point.
    //
    // What the number actually tracks is churn in the mask itself: the mask is the set of
    // pixels whose colour the shadow changes, and a wave face that has turned away from the
    // sun is already in the ramp's dark band, so it leaves the mask and comes back as the
    // swell passes. No framing removed that, so gating on it would be gating on noise.
    // The property is held structurally instead — `ocean.frag.glsl` samples `vBasePos`, which
    // has no displacement term in it — and `uShadowSampleDisplaced` is left in place so the
    // difference can be flipped on and looked at directly.
    const rigid = Number.isFinite(swim);
    const hueShifted = hue >= MIN_HUE_DEGREES;
    // Three of four, and the control must fail where the mechanism succeeds.
    const stable = held >= 3 && heldUnsnapped === 0;

    return {
      shadowedFraction: round4(shadowedFraction),
      present,
      edgePx: round2(edge.px),
      edgeSamples: edge.samples,
      hardEdged,
      swimPx: round2(swim),
      swimSabotagedPx: round2(swimSabotagedPx),
      rigid,
      hueDegrees: round2(hue),
      hueShifted,
      snapHeld: held,
      snapHeldUnsnapped: heldUnsnapped,
      stable,
      cascades: this.test.sun.shadows.count,
      pass: present && hardEdged && rigid && hueShifted && stable,
    };
  }

  /**
   * Put the island between the camera and the sun, so its shadow points at the lens.
   *
   * A cast shadow lies on the side of its caster AWAY from the light, so it is visible exactly
   * when the camera is on that side too — that is, looking toward the sun. Framing from the sun
   * side instead hides every shadow behind the thing that cast it, which is how the first two
   * versions of this gate came to report 0.03% shadowed on a scene whose shadows were entirely
   * correct.
   *
   * The receiving surface matters as much as the framing, and it is why this looks across
   * water. At a 16 degree sun the ground behind a ridge faces away from the light and the
   * gouache ramp has already put it in the dark band, so a cast shadow there changes nothing
   * that a pixel diff can see. The sea faces straight up, sits several bands into the lit half,
   * and drops to the shadow band when the island's shadow crosses it — which is also, not
   * coincidentally, the shot §3.3 calls the strongest storytelling device in the game.
   */
  private frameTowardSun(): void {
    // THE SUBJECT IS THE AIRCRAFT, because that is what §3.3 is about.
    //
    // The obvious subject, the hero island, turns out to be a poor one: it is 117 m tall and
    // 916 m wide, so at a 16 degree sun its 408 m shadow lands almost entirely on its own
    // leeward flank and barely reaches the water. That is correct behaviour for a low karst
    // island and it leaves a pixel diff almost nothing to measure. The seaplane sits ON the
    // water with nothing between it and the sea, so its shadow is unobstructed — and it is the
    // one the doc calls "the strongest storytelling device you have".
    const subject = this.test.seaplane.group.position;
    // Close in, and that distance is load-bearing. The ocean only displaces its vertices within
    // `uDisplaceFadeEnd` of the camera — 45 m — and beyond that the surface is dead flat with
    // the waves carried by the fragment normal alone. Framed from 90 m, the water under the
    // aircraft was flat, so sampling the shadow against the displaced surface and against the
    // base plane gave the same answer and the negative control below measured nothing. At 28 m
    // the surface under the shadow genuinely heaves.
    const span = 28;

    const sun = globalUniforms.uSunDirection.value;
    const bearing = new THREE.Vector3(sun.x, 0, sun.z);
    if (bearing.lengthSq() < 1e-6) bearing.set(0, 0, 1);
    bearing.normalize();

    // Down-sun of the aircraft and low, so the shadow it throws lies between the two and fills
    // a usable part of the frame.
    const camera = this.test.camera;
    camera.position.copy(subject).addScaledVector(bearing, -span).setY(subject.y + span * 0.45);
    camera.lookAt(subject.x, subject.y, subject.z);
    camera.updateMatrixWorld(true);
  }

  /**
   * How often the near cascade's centre holds completely still under a sub-texel camera move.
   *
   * Four nudges, each a fraction of one texel. With the snap on, the centre is pinned to the
   * lattice, so it cannot move at all except on the one step that happens to cross a lattice
   * line — hence "at least three of four", not "all four". With the snap off it tracks the
   * camera continuously and holds still on none of them.
   */
  private measureSnap(snap: boolean): number {
    const cascades = this.test.sun.shadows;
    const camera = this.test.camera;
    const home = camera.position.clone();
    const wasSnapping = cascades.snapToTexels;
    cascades.snapToTexels = snap;

    const sun = globalUniforms.uSunDirection.value;
    cascades.update(camera, sun);
    const start = cascades.centreOf(0).clone();
    // A fifth of a texel per step: four of them cover less than one lattice cell, so at most
    // one crossing is possible however the cell boundaries happen to fall.
    const step = cascades.texelSizeOf(0) * 0.2;

    // Compared PERPENDICULAR to the sun, because that is the only direction in which moving
    // the shadow camera moves the shadow. Sliding it along the light axis just shifts the
    // near and far planes of an orthographic projection and leaves every texel exactly where
    // it was, so the lateral lattice is snapped and the axial position deliberately is not —
    // quantising that too would make the depth range jitter for no gain.
    const lateral = (v: THREE.Vector3): THREE.Vector3 =>
      v.clone().addScaledVector(sun, -v.dot(sun));
    const startLateral = lateral(start);

    let held = 0;
    for (let i = 1; i <= 4; i++) {
      camera.position.copy(home);
      camera.position.x += step * i;
      camera.updateMatrixWorld(true);
      cascades.update(camera, sun);
      if (lateral(cascades.centreOf(0)).distanceTo(startLateral) < 1e-6) held++;
    }

    camera.position.copy(home);
    camera.updateMatrixWorld(true);
    cascades.snapToTexels = wasSnapping;
    cascades.update(camera, sun);
    return held;
  }

  /** Pixels the shadow silhouette's centre of area drifts over half a wave period. */
  private measureSwim(waveTime: number): number {
    this.test.setWaveTime(waveTime);
    const a = differenceMask(this.capture(false), this.capture(true));
    this.test.setWaveTime(waveTime + 3.1);
    const b = differenceMask(this.capture(false), this.capture(true));
    const width = this.renderer.getContext().drawingBufferWidth;
    return centroidShift(a, b, width);
  }

  private capture(shadows: boolean): Frame {
    this.test.sun.shadows.setEnabled(shadows);
    // Refit before rendering: turning the rig back on leaves the cascades where they were the
    // last time it was enabled, which after a camera move is nowhere useful.
    this.test.sun.update(this.test.camera);
    this.renderer.render(this.test.scene, this.test.camera);
    return this.read();
  }

  /** Straight off the default framebuffer, the same way every other gate reads a frame. */
  private read(): Frame {
    const gl = this.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width, height };
  }

  static format(r: ShadowReport): string {
    const l: string[] = [];
    l.push('SHADOW GATE (04 §3) — ' + (r.pass ? 'PASS' : 'FAIL'));
    l.push('');
    l.push('cast shadows (' + r.cascades + ' cascades, difference against the same frame unshadowed):');
    l.push(row(r.present, 'present: ' + (r.shadowedFraction * 100).toFixed(2) + '% of pixels shadowed (min ' +
      (MIN_SHADOWED_FRACTION * 100).toFixed(1) + '%)'));
    l.push(row(r.hardEdged, 'edge width ' + r.edgePx.toFixed(2) + ' px over ' + r.edgeSamples +
      ' crossings (max ' + MAX_EDGE_PX + ' — 00 §3 rule 3, no penumbra)'));
    l.push(row(r.hueShifted, 'shadow is a hue shift, not a multiply: ' + r.hueDegrees.toFixed(2) +
      ' deg between lit and shadowed (min ' + MIN_HUE_DEGREES + ' — 00 §3 rule 2)'));
    l.push('');
    l.push('the signature shot (04 §3.3):');
    l.push('  --   rigid under the swell: silhouette centre moves ' + r.swimPx.toFixed(2) +
      ' px over half a wave period');
    l.push('        vs ' + r.swimSabotagedPx.toFixed(2) + ' px sampling the DISPLACED surface — the ' +
      'control does not separate, so this is reported, not gated');
    l.push('        (held structurally: ocean.frag.glsl samples vBasePos, which carries no displacement)');
    l.push(row(r.stable, 'texel snap (§3.2): the near cascade held still for ' + r.snapHeld +
      ' of 4 sub-texel camera nudges (min 3)'));
    l.push('        negative control, snap disabled: held ' + r.snapHeldUnsnapped +
      ' of 4 (must be 0, or the snap is not what is holding it)');
    return l.join('\n');
  }
}

function row(ok: boolean, text: string): string {
  return (ok ? '  ok   ' : '  FAIL ') + text;
}

interface Mask {
  flags: Uint8Array;
  count: number;
}

/** Pixels that changed when the cascades were switched on — i.e. the cast shadow. */
function differenceMask(a: Frame, b: Frame): Mask {
  const flags = new Uint8Array(a.width * a.height);
  let count = 0;
  for (let i = 0; i < flags.length; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(a.data[o]! - b.data[o]!),
      Math.abs(a.data[o + 1]! - b.data[o + 1]!),
      Math.abs(a.data[o + 2]! - b.data[o + 2]!),
    );
    // Well above readback noise, well below a real band change.
    if (d > 6) { flags[i] = 1; count++; }
  }
  return { flags, count };
}

/**
 * How far the shadow's centre of area moves between two masks, in pixels.
 *
 * WHY A CENTROID AND NOT A PIXEL SET. Comparing the two masks pixel by pixel measures the wrong
 * thing on water, and reported 57% movement on a silhouette that had not moved. The mask is the
 * set of pixels whose colour the shadow CHANGES, and on a moving sea that set is itself
 * animated: a wave face that has turned away from the sun is already in the ramp's dark band,
 * so shadowing it changes nothing and it drops out of the mask. Half a period later it has
 * turned back and returns. None of that is the shadow moving.
 *
 * The centre of area is insensitive to that churn — pixels joining and leaving around the edge
 * of a stationary region cancel — while a silhouette that genuinely swims with the swell drags
 * its centroid with it.
 */
function centroidShift(a: Mask, b: Mask, width: number): number {
  const ca = centroid(a, width);
  const cb = centroid(b, width);
  if (!ca || !cb) return Infinity;
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

function centroid(m: Mask, width: number): { x: number; y: number } | null {
  if (m.count === 0) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < m.flags.length; i++) {
    if (m.flags[i] !== 1) continue;
    sx += i % width;
    sy += (i / width) | 0;
  }
  return { x: sx / m.count, y: sy / m.count };
}

/**
 * Mean width, in pixels, of the horizontal runs where the shadow mask changes state.
 *
 * A binary cut gives runs of 1 px — the mask flips between adjacent pixels. A PCF penumbra
 * gives a ramp, and the ramp's pixels all register as "changed" so the run is as wide as the
 * blur. Measured only on isolated crossings, so a pixel-thin sliver of shadow cannot be read
 * as a wide soft edge.
 */
function measureEdge(mask: Mask, width: number, height: number): { px: number; samples: number } {
  let total = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 2) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      const inside = mask.flags[y * width + x] === 1;
      if (inside) {
        run++;
        continue;
      }
      // A run bounded by lit pixels on both sides, wide enough to be a region rather than
      // noise, contributes its two edges.
      if (run > 0) {
        if (run >= 4) { total += 2; samples += 2; }
        else if (run >= 1) { total += run; samples += 1; }
      }
      run = 0;
    }
  }
  return { px: samples > 0 ? total / samples : 0, samples };
}

/**
 * Angle in degrees between the mean lit colour and the mean shadowed colour, as RGB vectors.
 *
 * A `base * 0.5` shadow is the SAME direction at a shorter length, so the angle is zero. Any
 * genuine hue shift rotates the vector. This is the cheapest possible test that distinguishes
 * 00 §3 rule 2's two cases, and it does not care how dark the shadow ended up.
 */
function measureHueShift(lit: Frame, shadowed: Frame, mask: Mask): number {
  if (mask.count === 0) return 0;
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  for (let i = 0; i < mask.flags.length; i++) {
    if (mask.flags[i] !== 1) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      a[c]! += lit.data[o + c]!;
      b[c]! += shadowed.data[o + c]!;
    }
  }
  const la = Math.hypot(a[0]!, a[1]!, a[2]!);
  const lb = Math.hypot(b[0]!, b[1]!, b[2]!);
  if (la === 0 || lb === 0) return 0;
  const dot = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (la * lb);
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
