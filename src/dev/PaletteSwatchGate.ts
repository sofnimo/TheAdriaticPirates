import * as THREE from 'three';
import { ALL_SWATCHES, hexBytes, hexString } from '../art/palette';
import { checkRendererContract } from '../app/RendererConfig';

/**
 * STEP 0 ACCEPTANCE GATE — "screenshot a palette swatch grid, eyedrop it, exact match."
 *
 * Every authored hex in art/palette.ts is rendered twice, side by side, in the same cell:
 *
 *   left half   — an unlit MeshBasicMaterial quad, pushed through the real WebGLRenderer
 *                 with the §5 contract (NoToneMapping + SRGBColorSpace + ColorManagement)
 *   right half  — a plain CSS background of the identical hex, i.e. ground truth
 *
 * If the renderer is mis-configured, the two halves differ and every swatch shows a
 * visible vertical seam. Nothing downstream is worth building until this is clean,
 * because a tone-mapping curve silently rewrites the entire art direction.
 *
 * The eyeball test is backed by a machine check: readPixels samples the GL half of each
 * cell and compares it byte-for-byte against the authored sRGB value.
 */

const SAMPLE_TOLERANCE = 1; // +/-1 of 255 is float-rounding noise; above that is a real shift.

export interface SwatchResult {
  family: string;
  key: string;
  hex: number;
  expected: [number, number, number];
  actual: [number, number, number];
  delta: number;
  pass: boolean;
}

export interface GateReport {
  results: SwatchResult[];
  total: number;
  exact: number;
  withinTolerance: number;
  failed: number;
  worstDelta: number;
  /** §5 renderer-contract violations found at verify time; empty when clean. */
  contractViolations: string[];
  pass: boolean;
}

interface Cell {
  /** Normalised, CSS convention: origin top-left, y grows downward. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export class PaletteSwatchGate {
  readonly scene = new THREE.Scene();
  /** left=0 right=1 top=0 bottom=1 — normalised screen space, y down, matching CSS. */
  readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);

  private readonly overlay: HTMLDivElement;
  private readonly summaryEl: HTMLDivElement;
  private readonly cells: Cell[] = [];
  private readonly cellEls: HTMLDivElement[] = [];
  private readonly verdictEls: HTMLSpanElement[] = [];
  private columns = 6;
  private lastReport: GateReport | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    container: HTMLElement,
  ) {
    this.scene.background = new THREE.Color(0x1b1e20);

    this.overlay = document.createElement('div');
    this.overlay.className = 'gate-overlay';
    container.appendChild(this.overlay);

    this.summaryEl = document.createElement('div');
    this.summaryEl.className = 'gate-summary';
    container.appendChild(this.summaryEl);

    this.build();
  }

  setColumns(columns: number): void {
    this.columns = Math.max(2, Math.min(10, Math.round(columns)));
    this.build();
  }

  setOverlayVisible(visible: boolean): void {
    this.overlay.style.display = visible ? '' : 'none';
  }

  /** Rebuild geometry + DOM for the current column count. */
  private build(): void {
    this.scene.clear();
    this.overlay.replaceChildren();
    this.cells.length = 0;
    this.cellEls.length = 0;
    this.verdictEls.length = 0;

    const count = ALL_SWATCHES.length;
    const cols = this.columns;
    const rows = Math.ceil(count / cols);

    const marginLeft = 0.012;
    const marginRight = 0.215; // keeps the grid clear of the lil-gui panel during review
    const marginTop = 0.09; // room for the summary bar
    const marginBottom = 0.02;
    const gap = 0.008;

    const cellW = (1 - marginLeft - marginRight - gap * (cols - 1)) / cols;
    const cellH = (1 - marginTop - marginBottom - gap * (rows - 1)) / rows;

    const quad = new THREE.PlaneGeometry(1, 1);

    ALL_SWATCHES.forEach((entry, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cell: Cell = {
        x: marginLeft + col * (cellW + gap),
        y: marginTop + row * (cellH + gap),
        w: cellW,
        h: cellH,
      };
      this.cells.push(cell);

      // --- GL half (the whole cell; the CSS half is drawn on top of the right side) ---
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(entry.swatch.hex),
        side: THREE.DoubleSide, // the y-down camera flips winding
        // NOT toneMapped:false. Tempting, but wrong: it would immunise the swatches
        // against tone mapping, which is precisely the drift this gate exists to catch.
        // World materials are tone-mapped, so the swatches must take the same path.
        fog: false,
      });
      const mesh = new THREE.Mesh(quad, material);
      mesh.position.set(cell.x + cell.w / 2, cell.y + cell.h / 2, 0);
      mesh.scale.set(cell.w, cell.h, 1);
      this.scene.add(mesh);

      // --- CSS half + labels ---
      const el = document.createElement('div');
      el.className = 'gate-cell';
      el.style.left = (cell.x * 100).toFixed(4) + '%';
      el.style.top = (cell.y * 100).toFixed(4) + '%';
      el.style.width = (cell.w * 100).toFixed(4) + '%';
      el.style.height = (cell.h * 100).toFixed(4) + '%';

      const cssHalf = document.createElement('div');
      cssHalf.className = 'gate-cell-css';
      cssHalf.style.background = hexString(entry.swatch.hex);
      el.appendChild(cssHalf);

      const label = document.createElement('div');
      label.className = 'gate-cell-label';
      label.style.color = readableInk(entry.swatch.hex);

      const name = document.createElement('span');
      name.className = 'gate-cell-name';
      name.textContent = entry.family + '.' + entry.key;
      name.title = entry.swatch.role + (entry.swatch.note ? ' — ' + entry.swatch.note : '');

      const hexEl = document.createElement('span');
      hexEl.className = 'gate-cell-hex';
      hexEl.textContent = hexString(entry.swatch.hex);

      const verdict = document.createElement('span');
      verdict.className = 'gate-cell-verdict';
      verdict.textContent = '...';

      label.append(name, hexEl, verdict);
      el.appendChild(label);
      this.overlay.appendChild(el);

      this.cellEls.push(el);
      this.verdictEls.push(verdict);
    });
  }

  /**
   * Render one frame, then read back the GL half of every swatch and compare against
   * the authored sRGB bytes. Requires the renderer to have preserveDrawingBuffer.
   */
  verify(): GateReport {
    const contractViolations = checkRendererContract(this.renderer);
    this.renderer.render(this.scene, this.camera);

    const gl = this.renderer.getContext();
    const bufferW = gl.drawingBufferWidth;
    const bufferH = gl.drawingBufferHeight;
    const pixel = new Uint8Array(4);

    const results: SwatchResult[] = ALL_SWATCHES.map((entry, i) => {
      const cell = this.cells[i]!;
      // Sample the left quarter, upper area: inside the GL-only half, clear of the label.
      const nx = cell.x + cell.w * 0.25;
      const nyFromTop = cell.y + cell.h * 0.3;

      const px = clamp(Math.floor(nx * bufferW), 0, bufferW - 1);
      const py = clamp(Math.floor((1 - nyFromTop) * bufferH), 0, bufferH - 1); // GL origin bottom-left
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

      const expected = hexBytes(entry.swatch.hex);
      const actual: [number, number, number] = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
      const delta = Math.max(
        Math.abs(expected[0] - actual[0]),
        Math.abs(expected[1] - actual[1]),
        Math.abs(expected[2] - actual[2]),
      );

      return {
        family: entry.family,
        key: entry.key,
        hex: entry.swatch.hex,
        expected,
        actual,
        delta,
        pass: delta <= SAMPLE_TOLERANCE,
      };
    });

    const exact = results.filter((r) => r.delta === 0).length;
    const withinTolerance = results.filter((r) => r.pass).length;
    const failed = results.length - withinTolerance;
    const worstDelta = results.reduce((m, r) => Math.max(m, r.delta), 0);

    const report: GateReport = {
      results,
      total: results.length,
      exact,
      withinTolerance,
      failed,
      worstDelta,
      contractViolations,
      pass: failed === 0 && contractViolations.length === 0,
    };

    this.lastReport = report;
    this.paintVerdicts(report);
    return report;
  }

  get report(): GateReport | null {
    return this.lastReport;
  }

  /** Plain-text report, for pasting into a review comment. */
  formatReport(): string {
    const r = this.lastReport;
    if (!r) return 'Gate has not been run.';
    const header = [
      'PALETTE GATE — ' + (r.pass ? 'PASS' : 'FAIL'),
      r.exact + '/' + r.total + ' exact, ' + r.withinTolerance + '/' + r.total +
        ' within +/-' + SAMPLE_TOLERANCE + ', worst delta ' + r.worstDelta,
      '',
    ];
    if (r.contractViolations.length > 0) {
      header.splice(2, 0, 'CONTRACT VIOLATIONS:', ...r.contractViolations.map((v) => '  - ' + v), '');
    }
    const rows = r.results.map((s) => {
      const label = (s.family + '.' + s.key).padEnd(26);
      return (s.pass ? 'ok   ' : 'FAIL ') + hexString(s.hex) + ' ' + label +
        ' expected ' + fmtRGB(s.expected) + '  got ' + fmtRGB(s.actual) + '  d=' + s.delta;
    });
    return header.concat(rows).join('\n');
  }

  private paintVerdicts(report: GateReport): void {
    report.results.forEach((r, i) => {
      const verdict = this.verdictEls[i];
      const cell = this.cellEls[i];
      if (!verdict || !cell) return;
      verdict.textContent = r.pass ? (r.delta === 0 ? 'exact' : 'd' + r.delta) : 'FAIL d' + r.delta;
      verdict.classList.toggle('is-fail', !r.pass);
      cell.classList.toggle('is-fail', !r.pass);
    });

    this.summaryEl.classList.toggle('is-fail', !report.pass);
    this.summaryEl.replaceChildren();

    const title = document.createElement('strong');
    title.textContent = 'Palette gate — ' + (report.pass ? 'PASS' : 'FAIL');

    const counts = document.createElement('span');
    counts.textContent =
      report.exact + '/' + report.total + ' exact · ' +
      report.withinTolerance + '/' + report.total + ' within +/-' + SAMPLE_TOLERANCE + ' · ' +
      'worst delta ' + report.worstDelta;

    const hint = document.createElement('span');
    hint.className = 'gate-summary-hint';
    hint.textContent = 'left half = WebGL · right half = CSS ground truth · any seam is a bug';

    this.summaryEl.append(title, counts, hint);

    if (report.contractViolations.length > 0) {
      const violations = document.createElement('span');
      violations.className = 'gate-summary-violation';
      violations.textContent = 'CONTRACT: ' + report.contractViolations.join(' | ');
      this.summaryEl.append(violations);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function fmtRGB(rgb: [number, number, number]): string {
  return '(' + String(rgb[0]).padStart(3) + ',' + String(rgb[1]).padStart(3) + ',' + String(rgb[2]).padStart(3) + ')';
}

/** Pick black or white label ink for legibility on a given swatch. */
function readableInk(hex: number): string {
  const [r, g, b] = hexBytes(hex);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.55 ? '#14181a' : '#f2f4f3';
}
