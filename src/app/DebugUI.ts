import GUI from 'lil-gui';
import Stats from 'stats.js';
import { GLOBAL } from '../art/budgets';
import type { PassStats } from './Engine';

/**
 * Debug panel + frame-time HUD + budget counters.
 *
 * The budget HUD keeps WORLD and DEV-OVERLAY counters strictly separate. The 00 §5
 * ceiling (1.2M tris / 40 draw calls) applies to world content only; debug helpers are
 * reported alongside it but never counted into it, so a helper can't trip a false breach
 * once real geometry arrives.
 */

export class DebugUI {
  readonly gui: GUI;
  private readonly stats: Stats;
  private readonly budgetEl: HTMLDivElement;

  constructor(container: HTMLElement, title = 'Adriatic — debug') {
    this.gui = new GUI({ title, width: 320 });

    this.stats = new Stats();
    this.stats.showPanel(0);
    this.stats.dom.className = 'stats-hud';
    this.stats.dom.style.cssText = 'position:fixed;top:8px;left:8px;z-index:40;cursor:pointer;';
    container.appendChild(this.stats.dom);

    this.budgetEl = document.createElement('div');
    this.budgetEl.className = 'budget-hud';
    container.appendChild(this.budgetEl);
  }

  beginFrame(): void {
    this.stats.begin();
  }

  endFrame(): void {
    this.stats.end();
  }

  updateBudgetHud(world: PassStats, dev: PassStats, post?: PassStats): void {
    this.budgetEl.replaceChildren();

    this.budgetEl.append(sectionLabel('world · 00 §5 ceiling'));
    this.budgetEl.append(
      budgetRow(
        'tris',
        world.triangles.toLocaleString(),
        GLOBAL.maxTriangles.toLocaleString(),
        (world.triangles / GLOBAL.maxTriangles) * 100,
      ),
      budgetRow('draws', String(world.calls), String(GLOBAL.maxDrawCalls), (world.calls / GLOBAL.maxDrawCalls) * 100),
    );

    // Reported beside the world budget, never inside it — the 00 §5 ceiling is about world
    // content, and four fullscreen quads are not terrain. Visible rather than hidden,
    // because the post chain is not free.
    if (post && post.calls > 0) {
      this.budgetEl.append(sectionLabel('post chain · 04 §7.1'));
      this.budgetEl.append(budgetRow('draws', String(post.calls), null, 0));
    }

    this.budgetEl.append(sectionLabel('dev overlay · uncapped'));
    this.budgetEl.append(
      budgetRow('tris', dev.triangles.toLocaleString(), null, 0),
      budgetRow('draws', String(dev.calls), null, 0),
    );

    this.budgetEl.append(sectionLabel('resident'));
    this.budgetEl.append(
      budgetRow('geoms', String(Math.max(world.geometries, dev.geometries)), null, 0),
      budgetRow('progs', String(Math.max(world.programs, dev.programs)), null, 0),
    );
  }

  dispose(): void {
    this.gui.destroy();
    this.stats.dom.remove();
    this.budgetEl.remove();
  }
}

function sectionLabel(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'budget-section';
  el.textContent = text;
  return el;
}

function budgetRow(label: string, value: string, ceiling: string | null, pct: number): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'budget-row';
  if (ceiling !== null) {
    if (pct > 100) row.classList.add('is-over');
    else if (pct > 80) row.classList.add('is-near');
  }

  const l = document.createElement('span');
  l.className = 'budget-label';
  l.textContent = label;

  const v = document.createElement('span');
  v.className = 'budget-value';
  v.textContent = ceiling === null ? value : value + ' / ' + ceiling;

  row.append(l, v);
  return row;
}
