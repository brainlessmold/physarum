/**
 * Draws the graph in three dimensions on a plain 2D canvas.
 *
 * No WebGL and no library: rotate the points, divide by depth, sort the tubes
 * back to front and stroke them. Distant tubes are drawn thinner and dimmer,
 * which is all the depth cue a network of tubes needs.
 */

import type { Graph } from './graph.ts';
import { PALETTE, type Palette } from './render.ts';

export interface Camera {
  /** Rotation about the vertical axis, radians. */
  yaw: number;
  /** Rotation about the horizontal axis, radians. */
  pitch: number;
  /** Distance of the eye from the origin, in scene units. */
  distance: number;
}

export interface Render3DOptions {
  palette?: Palette;
  camera: Camera;
  food?: number[];
  aliveCut?: number;
  maxWidth?: number;
  /** Draw the tubes that died as a faint scaffold. */
  showLattice?: boolean;
}

interface Projected {
  x: number;
  y: number;
  /** Depth after rotation: larger is further away. */
  z: number;
  /** Perspective scale at this depth. */
  s: number;
}

export function render3d(
  ctx: CanvasRenderingContext2D,
  graph: Graph,
  width: number,
  height: number,
  dpr: number,
  opts: Render3DOptions,
): void {
  const pal = opts.palette ?? PALETTE;
  const { yaw, pitch, distance } = opts.camera;
  const maxLineWidth = opts.maxWidth ?? 9;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.min(width, height) * 0.78;

  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  const proj: Projected[] = graph.nodes.map((n) => {
    const x0 = n.x;
    const y0 = n.y;
    const z0 = n.z ?? 0;
    // Yaw about y, then pitch about x.
    const x1 = x0 * cosY + z0 * sinY;
    const z1 = -x0 * sinY + z0 * cosY;
    const y2 = y0 * cosP - z1 * sinP;
    const z2 = y0 * sinP + z1 * cosP;
    const s = distance / (distance + z2);
    return { x: cx + x1 * scale * s, y: cy + y2 * scale * s, z: z2, s };
  });

  let maxD = 0;
  for (const e of graph.edges) if (e.D > maxD) maxD = e.D;
  if (maxD <= 0) maxD = 1;

  const absCut = opts.aliveCut;
  const isWeak = (D: number, t: number) => (absCut === undefined ? t < 0.25 : D <= absCut);

  // Back to front, so near tubes cover far ones.
  const order = graph.edges
    .map((e, i) => ({ e, i, z: (proj[e.a].z + proj[e.b].z) / 2 }))
    .sort((a, b) => b.z - a.z);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const { e, z } of order) {
    const t = e.D / maxD;
    const weak = isWeak(e.D, t);
    if (weak && !opts.showLattice) continue;

    const pa = proj[e.a];
    const pb = proj[e.b];
    const s = (pa.s + pb.s) / 2;
    // Depth runs roughly -0.5..0.5; map it to a fade.
    const depth = Math.min(Math.max((0.5 - z) / 1.0, 0), 1);

    if (weak) {
      ctx.strokeStyle = pal.dead;
      ctx.globalAlpha = 0.18 + 0.3 * depth;
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = t > 0.78 ? pal.hot : pal.vein;
      ctx.globalAlpha = (0.3 + 0.7 * depth) * (0.5 + 0.5 * t);
      ctx.lineWidth = Math.max(0.8, (1 + maxLineWidth * Math.pow(t, 0.85)) * s);
    }
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;

  if (opts.food) {
    const foodOrder = opts.food
      .map((i) => ({ i, z: proj[i].z }))
      .sort((a, b) => b.z - a.z);
    for (const { i, z } of foodOrder) {
      const p = proj[i];
      const depth = Math.min(Math.max((0.5 - z) / 1.0, 0), 1);
      ctx.globalAlpha = 0.35 + 0.65 * depth;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.6, 4.2 * p.s), 0, Math.PI * 2);
      ctx.fillStyle = pal.food;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
