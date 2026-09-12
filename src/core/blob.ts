/**
 * A three-dimensional body for the mold to grow through.
 *
 * Nothing here is a scan or a model of a real organism — no volumetric data of
 * Physarum exists. It is a cloud of points in a ball, joined to their nearest
 * neighbours, and the tubes that survive on it are produced by the same solver
 * that runs every other panel. The shape you end up looking at is the
 * organism's own output, in three dimensions rather than two.
 */

import { buildGraph, type Graph, type GraphNode } from './graph.ts';

export interface BlobOptions {
  /** How many points to scatter through the ball. */
  count?: number;
  /** Neighbours each point is joined to. */
  neighbours?: number;
  /** Minimum separation, so the cloud is even rather than clumped. */
  minGap?: number;
  /** How many of the points carry food. */
  foodCount?: number;
  rng?: () => number;
}

export interface Blob {
  graph: Graph;
  food: number[];
}

export function buildBlob(opts: BlobOptions = {}): Blob {
  const rng = opts.rng ?? Math.random;
  const count = opts.count ?? 96;
  const k = opts.neighbours ?? 5;
  const minGap = opts.minGap ?? 0.16;
  const foodCount = opts.foodCount ?? 14;

  // Poisson-ish scatter through a ball of radius 0.5 around the origin.
  const pts: GraphNode[] = [];
  let tries = 0;
  while (pts.length < count && tries < count * 700) {
    tries++;
    const u = rng() * 2 - 1;
    const theta = rng() * Math.PI * 2;
    // Cube root keeps the density even instead of piling up at the centre.
    const r = 0.5 * Math.cbrt(rng());
    const s = Math.sqrt(1 - u * u);
    const p = { x: r * s * Math.cos(theta), y: r * s * Math.sin(theta), z: r * u };
    if (pts.every((q) => Math.hypot(p.x - q.x, p.y - q.y, (p.z ?? 0) - (q.z ?? 0)) > minGap)) {
      pts.push(p);
    }
  }

  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    const near = pts
      .map((q, j) => ({
        j,
        d: Math.hypot(q.x - pts[i].x, q.y - pts[i].y, (q.z ?? 0) - (pts[i].z ?? 0)),
      }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, k);
    for (const o of near) {
      const key = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(i < o.j ? [i, o.j] : [o.j, i]);
    }
  }

  // Food on the outermost points: the mold then has to span the whole body.
  const byRadius = pts
    .map((p, i) => ({ i, r: Math.hypot(p.x, p.y, p.z ?? 0) }))
    .sort((a, b) => b.r - a.r);
  const food: number[] = [];
  for (const o of byRadius) {
    if (food.length >= foodCount) break;
    const p = pts[o.i];
    // Spread them out, so food does not bunch on one side.
    const far = food.every((f) => {
      const q = pts[f];
      return Math.hypot(p.x - q.x, p.y - q.y, (p.z ?? 0) - (q.z ?? 0)) > 0.42;
    });
    if (far) food.push(o.i);
  }
  while (food.length < 2 && pts.length >= 2) food.push(food.length);

  return { graph: buildGraph(pts, pairs, { rng }), food };
}
