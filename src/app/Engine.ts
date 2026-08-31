import * as THREE from 'three';
import { createRenderer } from './RendererConfig';
import type { PostChain } from '../render/post/PostChain';

/**
 * Minimal frame loop + resize plumbing. Deliberately thin: it owns the renderer and the
 * clock, and nothing about the world.
 *
 * Renders in two passes — world, then dev overlay — and captures `renderer.info` between
 * them, so debug geometry can never be mistaken for world geometry in the budget HUD.
 * With one shared counter, the first real terrain chunk would land next to a debug helper
 * and the 40-draw-call ceiling would report a breach that isn't one.
 *
 * When a `PostChain` is attached the world goes through the composer instead, and the
 * counters split three ways rather than two: the chain's stats tap snapshots
 * `renderer.info` after the scene has drawn and before any fullscreen quad has, so the
 * post chain's own draws are reported alongside the 00 §5 world budget and never inside it.
 *
 * ONE BEHAVIOUR CHANGE COMES WITH THE COMPOSER, and it is worth knowing about: the graded
 * frame arrives at the canvas as a fullscreen blit, so the canvas depth buffer no longer
 * holds the world's depth and the dev overlay drawn after it cannot depth-test against
 * terrain. Helpers therefore draw on top rather than being occluded. That is the right
 * default for gizmos and it is why the overlay is not routed through post — grain and
 * vignette belong on the painting, not on the measuring tools — but a future overlay that
 * wants occlusion will need its own depth pre-pass.
 */

export interface FrameContext {
  dt: number;
  elapsed: number;
}

export type FrameCallback = (ctx: FrameContext) => void;

export interface PassStats {
  calls: number;
  triangles: number;
  geometries: number;
  programs: number;
}

const emptyStats = (): PassStats => ({ calls: 0, triangles: 0, geometries: 0, programs: 0 });

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  preserveDrawingBuffer?: boolean;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly clock = new THREE.Clock();

  /** Per-pass render stats from the last frame. */
  readonly stats: { world: PassStats; dev: PassStats; post: PassStats } = {
    world: emptyStats(),
    dev: emptyStats(),
    post: emptyStats(),
  };

  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private devScene: THREE.Scene | null = null;
  private devEnabled = true;
  private devOnTop = false;
  private post: PostChain | null = null;
  /** Draw/triangle counts of the scene pass alone, filled by the chain's stats tap. */
  private tappedCalls = 0;
  private tappedTriangles = 0;

  private readonly frameCallbacks: FrameCallback[] = [];
  private readonly resizeCallbacks: Array<(w: number, h: number) => void> = [];
  private running = false;
  private elapsed = 0;

  constructor(options: EngineOptions) {
    this.renderer = createRenderer(
      options.preserveDrawingBuffer === undefined
        ? { canvas: options.canvas }
        : { canvas: options.canvas, preserveDrawingBuffer: options.preserveDrawingBuffer },
    );
    // Manual reset: we read the counters between the two passes.
    this.renderer.info.autoReset = false;

    window.addEventListener('resize', this.handleResize);
    this.handleResize();
  }

  setScene(scene: THREE.Scene, camera: THREE.Camera): void {
    this.scene = scene;
    this.camera = camera;
    this.post?.setScene(scene, camera);
  }

  /**
   * Attach the 04 §7.1 post chain. Pass null to render the world straight to the canvas,
   * which is what the palette and ramp gates want — they measure material output, and a
   * grain pass on top would put a few counts of noise on every byte-exact comparison.
   */
  setPostChain(post: PostChain | null): void {
    this.post = post;
    if (post && this.scene && this.camera) post.setScene(this.scene, this.camera);
    if (post) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      post.setSize(size.x, size.y);
    }
  }

  get postChain(): PostChain | null {
    return this.post;
  }

  /** Called by the chain's stats tap, between the scene draw and the first post quad. */
  tapSceneStats(calls: number, triangles: number): void {
    this.tappedCalls = calls;
    this.tappedTriangles = triangles;
  }

  /** Debug helpers, HUD geometry, gizmos — counted separately, never as world content. */
  setDevOverlay(scene: THREE.Scene | null): void {
    this.devScene = scene;
  }

  setDevOverlayEnabled(enabled: boolean): void {
    this.devEnabled = enabled;
  }

  /**
   * Clear the depth buffer before the overlay pass, so helpers draw over the world.
   *
   * Opt-in, because the two render paths disagree about what the canvas depth buffer holds
   * by the time the overlay runs and only one of them is a problem. Straight to canvas, it
   * holds the world's depth and helpers occlude correctly. Through the composer, it holds
   * the depth the final fullscreen quad wrote, which is nearer than anything in the scene —
   * so an overlay behind that quad is rejected wholesale and simply never appears, while
   * still counting draws in the stats. A gizmo you cannot see but can measure is the worst
   * of both, and this is the switch that fixes it.
   */
  setDevOverlayOnTop(onTop: boolean): void {
    this.devOnTop = onTop;
  }

  onFrame(cb: FrameCallback): void {
    this.frameCallbacks.push(cb);
  }

  onResize(cb: (w: number, h: number) => void): void {
    this.resizeCallbacks.push(cb);
    const size = this.renderer.getSize(new THREE.Vector2());
    cb(size.x, size.y);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.tick);
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  /** Render one frame immediately, outside the loop. Used by the readback gates. */
  renderOnce(): void {
    this.renderFrame(0);
  }

  private renderFrame(dt: number): void {
    if (!this.scene || !this.camera) return;

    this.renderer.info.reset();
    if (this.post && this.post.enabled) {
      this.tappedCalls = 0;
      this.tappedTriangles = 0;
      this.post.render(dt);
      // The tap holds the scene's own numbers; whatever the total gained after it is post.
      const info = this.renderer.info;
      this.stats.world.calls = this.tappedCalls;
      this.stats.world.triangles = this.tappedTriangles;
      this.stats.world.geometries = info.memory.geometries;
      this.stats.world.programs = info.programs?.length ?? 0;
      this.stats.post.calls = Math.max(info.render.calls - this.tappedCalls, 0);
      this.stats.post.triangles = Math.max(info.render.triangles - this.tappedTriangles, 0);
      this.stats.post.geometries = 0;
      this.stats.post.programs = 0;
    } else {
      this.renderer.render(this.scene, this.camera);
      this.capture(this.stats.world);
      Object.assign(this.stats.post, emptyStats());
    }

    if (this.devScene && this.devEnabled) {
      this.renderer.info.reset();
      const previousAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      if (this.devOnTop) this.renderer.clearDepth();
      this.renderer.render(this.devScene, this.camera);
      this.renderer.autoClear = previousAutoClear;
      this.capture(this.stats.dev);
    } else {
      Object.assign(this.stats.dev, emptyStats());
    }
  }

  private capture(into: PassStats): void {
    const info = this.renderer.info;
    into.calls = info.render.calls;
    into.triangles = info.render.triangles;
    into.geometries = info.memory.geometries;
    into.programs = info.programs?.length ?? 0;
  }

  private readonly tick = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    const ctx: FrameContext = { dt, elapsed: this.elapsed };
    for (const cb of this.frameCallbacks) cb(ctx);
    this.renderFrame(dt);
  };

  private readonly handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    // Drawing-buffer pixels, not CSS pixels: the composer's own pixel ratio is pinned to 1
    // so the device ratio is applied exactly once, here.
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post?.setSize(buffer.x, buffer.y);
    for (const cb of this.resizeCallbacks) cb(w, h);
  };
}
