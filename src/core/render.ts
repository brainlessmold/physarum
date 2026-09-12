/**
 * Canvas rendering of the network.
 * Line width is the tube conductivity, and so is the colour.
 *
 * The page is dark-only, so there is a single palette. The canvas used to read
 * the viewer's colour scheme, which made it render light inside a dark page
 * whenever the operating system was set to light.
 */

import type { Graph } from './graph.ts';

export interface Palette {
  bg: string;
  /** Lattice that is still there but carries no flow. */
  dead: string;
  /** A living tube. */
  vein: string;
  /** The thickest tubes, where nearly all the flow goes. */
  hot: string;
  node: string;
  food: string;
  label: string;
}

export const PALETTE: Palette = {
  bg: '#0a0b09',
  dead: '#363b30',
  vein: '#cfd1c4',
  hot: '#ffffff',
  node: '#555b4b',
  food: '#ffffff',
  label: '#8b9179',
};

export interface RenderOptions {
  palette?: Palette;
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
  /**
   * Draw every edge of the graph as a visible lattice, not just a hairline.
   * Used by the maze, where the point is to see what the mold rejected.
   */
  showLattice?: boolean;
  /**
   * Run dots along the living tubes, in the direction the flux is going and at
   * a speed set by its magnitude. Thickness alone shows which tubes won; this
   * shows why, which is the part people miss.
   */
  showFlow?: boolean;
  /** Seconds since the run started. Drives the dots. */
  time?: number;
}

export function render(
  ctx: CanvasRenderingContext2D,
  graph: Graph,
  width: number,
  height: number,
  dpr: number,
  opts: RenderOptions,
): void {
  const pal = opts.palette ?? PALETTE;
  const pad = opts.padding ?? 26;
  const maxLineWidth = opts.maxWidth ?? 8;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, width, height);

  const iw = width - pad * 2;
  const ih = height - pad * 2;
  const px = (i: number) => pad + graph.nodes[i].x * iw;
  const py = (i: number) => pad + graph.nodes[i].y * ih;

  // Dashed underlay: routes that were on offer.
  if (opts.underlay?.length) {
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = pal.dead;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.75;
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
  const isWeak = (D: number, t: number) => (absCut === undefined ? t < 0.25 : D <= absCut);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Pass one: the corridors the mold gave up on. Drawn solid and dim so the
  // structure it chose from stays legible instead of vanishing.
  if (opts.showLattice) {
    ctx.strokeStyle = pal.dead;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 1;
    for (const e of graph.edges) {
      const t = e.D / maxD;
      if (!isWeak(e.D, t)) continue;
      ctx.beginPath();
      ctx.moveTo(px(e.a), py(e.a));
      ctx.lineTo(px(e.b), py(e.b));
      ctx.stroke();
    }
  }

  // Pass two: living tubes, thin to thick, so the trunks land on top.
  const order = graph.edges
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.D - b.e.D);

  for (const { e } of order) {
    const t = e.D / maxD;
    const weak = isWeak(e.D, t);
    if (weak) {
      if (opts.showLattice || t < 0.04) continue;
      ctx.strokeStyle = pal.dead;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.4;
    } else {
      ctx.strokeStyle = t > 0.8 ? pal.hot : pal.vein;
      ctx.globalAlpha = 0.55 + 0.45 * t;
      ctx.lineWidth = 1.2 + maxLineWidth * Math.pow(t, 0.9);
    }
    ctx.beginPath();
    ctx.moveTo(px(e.a), py(e.a));
    ctx.lineTo(px(e.b), py(e.b));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let i = 0; i < graph.nodes.length; i++) {
    ctx.beginPath();
    ctx.arc(px(i), py(i), 2, 0, Math.PI * 2);
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

  // Dots travelling along the living tubes, in the direction of the flux.
  if (opts.showFlow) {
    const time = opts.time ?? 0;
    let maxQ = 1e-9;
    for (const e of graph.edges) {
      const q = Math.abs(e.Q);
      if (q > maxQ) maxQ = q;
    }

    for (const e of graph.edges) {
      const t = e.D / maxD;
      if (isWeak(e.D, t)) continue;
      const q = Math.abs(e.Q) / maxQ;
      if (q < 0.06) continue;

      const forward = e.Q >= 0;
      const ax = px(forward ? e.a : e.b);
      const ay = py(forward ? e.a : e.b);
      const bx = px(forward ? e.b : e.a);
      const by = py(forward ? e.b : e.a);

      const len = Math.hypot(bx - ax, by - ay);
      const dots = Math.max(1, Math.round(len / 26));
      const speed = 0.22 + 0.75 * q;
      const radius = 1.1 + 1.7 * t;

      ctx.fillStyle = pal.bg;
      for (let d = 0; d < dots; d++) {
        const u = ((time * speed + d / dots) % 1 + 1) % 1;
        ctx.globalAlpha = 0.75 * Math.sin(Math.PI * u);
        ctx.beginPath();
        ctx.arc(ax + (bx - ax) * u, ay + (by - ay) * u, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  if (opts.showLabels) {
    ctx.fillStyle = pal.label;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i < graph.nodes.length; i++) {
      const label = graph.nodes[i].label;
      if (!label) continue;
      const x = px(i);
      const y = py(i) - 10;
      // A plate behind the text, so labels do not sit on top of tubes.
      const w = ctx.measureText(label).width;
      ctx.fillStyle = pal.bg;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x - w / 2 - 3, y - 9, w + 6, 12);
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.label;
      ctx.fillText(label, x, y);
    }
  }
}
