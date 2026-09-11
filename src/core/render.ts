/**
 * Canvas rendering of the network.
 * Line width is the tube conductivity, and so is the colour.
 */

import type { Graph } from './graph.ts';

export interface Palette {
  bg: string;
  dead: string;
  vein: string;
  node: string;
  food: string;
  label: string;
}

export const LIGHT: Palette = {
  bg: '#FBFCF7',
  dead: '#DFE3D3',
  vein: '#C8930A',
  node: '#B9C0A6',
  food: '#8A6404',
  label: '#6E7561',
};

export const DARK: Palette = {
  bg: '#16190F',
  dead: '#2E3422',
  vein: '#E3B02A',
  node: '#4A5238',
  food: '#F2C64A',
  label: '#8B9279',
};

export function isDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export interface RenderOptions {
  palette: Palette;
  food?: number[];
  /** Underlay: for instance the real route map beneath the mold's network. */
  underlay?: Array<[number, number]>;
  showLabels?: boolean;
  padding?: number;
  maxWidth?: number;
  /**
   * Absolute threshold for a living tube. When absent a relative one is used:
   * a quarter of the thickest. See the note on Physarum.surviving.
   */
  aliveCut?: number;
}

export function render(
  ctx: CanvasRenderingContext2D,
  graph: Graph,
  width: number,
  height: number,
  dpr: number,
  opts: RenderOptions,
): void {
  const pal = opts.palette;
  const pad = opts.padding ?? 26;
  const maxLineWidth = opts.maxWidth ?? 8;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, width, height);

  const iw = width - pad * 2;
  const ih = height - pad * 2;
  const px = (i: number) => pad + graph.nodes[i].x * iw;
  const py = (i: number) => pad + graph.nodes[i].y * ih;

  // The underlay is drawn first, as thin dashed lines.
  if (opts.underlay?.length) {
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = pal.dead;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;
    for (const [a, b] of opts.underlay) {
      ctx.beginPath();
      ctx.moveTo(px(a), py(a));
      ctx.lineTo(px(b), py(b));
      ctx.stroke();
    }
    ctx.restore();
  }

  let maxD = 0;
  for (const e of graph.edges) if (e.D > maxD) maxD = e.D;
  if (maxD <= 0) maxD = 1;

  const absCut = opts.aliveCut;
  ctx.lineCap = 'round';
  for (const e of graph.edges) {
    const t = e.D / maxD;
    if (t < 0.04) continue;
    const weak = absCut === undefined ? t < 0.25 : e.D <= absCut;
    ctx.strokeStyle = weak ? pal.dead : pal.vein;
    ctx.globalAlpha = weak ? 0.55 : 0.45 + 0.55 * t;
    ctx.lineWidth = 0.7 + maxLineWidth * t;
    ctx.beginPath();
    ctx.moveTo(px(e.a), py(e.a));
    ctx.lineTo(px(e.b), py(e.b));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let i = 0; i < graph.nodes.length; i++) {
    ctx.beginPath();
    ctx.arc(px(i), py(i), 1.9, 0, Math.PI * 2);
    ctx.fillStyle = pal.node;
    ctx.fill();
  }

  if (opts.food) {
    for (const i of opts.food) {
      ctx.beginPath();
      ctx.arc(px(i), py(i), 5, 0, Math.PI * 2);
      ctx.fillStyle = pal.food;
      ctx.fill();
    }
  }

  if (opts.showLabels) {
    ctx.fillStyle = pal.label;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i < graph.nodes.length; i++) {
      const label = graph.nodes[i].label;
      if (!label) continue;
      ctx.fillText(label, px(i), py(i) - 9);
    }
  }
}
