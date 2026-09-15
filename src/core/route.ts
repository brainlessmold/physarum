/**
 * Turning a set of pools into an answer.
 *
 * This is the part the endpoint serves and the part worth checking, so it lives
 * here rather than inside a handler: it takes pools and two tokens and returns
 * the route, with no network of its own.
 *
 * The mould's answer and Dijkstra's are both computed, and both are returned.
 * The model is proven to converge on the shortest path, so if the two disagree
 * the fault is here — and saying so in the response is cheaper than being
 * caught at it.
 */

import { buildPoolGraph, poolCost, type Pool } from './pools.ts';
import { Physarum } from './solver.ts';
import { shortestPath } from './dijkstra.ts';

export interface Hop {
  from: string;
  to: string;
  venue: 'v2' | 'v3';
  feeTier: number | null;
  /** True when the cost came from the venue's quoter rather than a formula. */
  quoted: boolean;
  costPct: number;
}

export interface RoutePlan {
  route: string[];
  costPct: number | null;
  hops: Hop[];
  mould: { steps: number; tubesLeft: number; costPct: number };
  dijkstra: { costPct: number | null };
  /** False means this code is wrong, not that the market is strange. */
  agree: boolean;
}

export interface RouteError {
  error: string;
  tokens: string[];
}

const pct = (x: number) => +(x * 100).toFixed(4);
/** Pools are undirected, so a pair is keyed by its two labels in a fixed order. */
const pairKey = (a: string, b: string) => [a, b].sort().join(' -> ');

export function planRoute(
  pools: Pool[],
  from: string,
  to: string,
  tradeSizeUsd: number,
  options: { steps?: number } = {},
): RoutePlan | RouteError {
  const { graph, tokens, indexOf } = buildPoolGraph(pools, { tradeSizeUsd });
  const a = indexOf(from);
  const b = indexOf(to);
  if (a < 0 || b < 0 || a === b) return { error: 'unknown or identical tokens', tokens };

  const mould = new Physarum(graph, [a, b], { I0: 1, g: 1.8, dt: 0.12 });
  mould.run(options.steps ?? 1200);
  const moulded = mould.networkLength(0.25);

  const best = shortestPath(graph, a, b);
  const finite = isFinite(best.distance);

  const byPair = new Map<string, Pool>();
  for (const p of pools) byPair.set(pairKey(p.tokenA, p.tokenB), p);

  const hops: Hop[] = best.edges.map((ei) => {
    const e = graph.edges[ei];
    const x = graph.nodes[e.a].label ?? '';
    const y = graph.nodes[e.b].label ?? '';
    const pool = byPair.get(pairKey(x, y));
    return {
      from: x,
      to: y,
      venue: pool?.venue ?? 'v2',
      feeTier: pool?.feeTier ?? null,
      quoted: pool?.cost !== undefined,
      costPct: pool ? pct(poolCost(pool, { tradeSizeUsd })) : 0,
    };
  });

  return {
    route: best.nodes.map((i) => graph.nodes[i].label ?? ''),
    costPct: finite ? pct(best.distance) : null,
    hops,
    mould: { steps: mould.steps, tubesLeft: mould.surviving(0.25).length, costPct: pct(moulded) },
    dijkstra: { costPct: finite ? pct(best.distance) : null },
    agree: finite && Math.abs(moulded - best.distance) < 1e-3,
  };
}
