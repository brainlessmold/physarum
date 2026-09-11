/**
 * Live mode: the pool graph.
 *
 * Nodes are tokens. An edge is a pool between two tokens.
 * Edge length L is what it ACTUALLY costs to route through that pool.
 *
 * The mold minimises total path length, so on this graph it minimises the
 * total cost of a swap. No magic: this is Dijkstra, computed by a biological
 * model instead of a priority queue.
 */

import { buildWeightedGraph, type Graph } from './graph.ts';

export interface Pool {
  tokenA: string;
  tokenB: string;
  /** Pool fee in basis points: 30 = 0.3%. */
  feeBps: number;
  /** Pool liquidity in USD. */
  liquidityUsd: number;
}

export interface CostModel {
  /** Trade size in USD the route is computed for. */
  tradeSizeUsd: number;
}

/**
 * Cost of routing through a pool = fee + slippage estimate.
 *
 * For a constant-product pool the slippage on a trade of size S against
 * liquidity Lq is approximately S / Lq. This is a rough estimate, not an exact
 * tick-level computation: it is meant for ranking routes, not for quoting.
 * Before any real swap the route must be re-checked against the pool's own
 * quoter.
 */
export function poolCost(pool: Pool, model: CostModel): number {
  const fee = pool.feeBps / 10_000;
  const slippage = pool.liquidityUsd > 0 ? model.tradeSizeUsd / pool.liquidityUsd : 1;
  return Math.max(fee + slippage, 1e-6);
}

export interface PoolGraph {
  graph: Graph;
  /** tokens[i] — the token symbol at node i. */
  tokens: string[];
  indexOf: (symbol: string) => number;
}

/**
 * Lays the tokens out on a circle, purely so the picture reads.
 * The geometry here is decorative: it does not affect edge lengths, which come
 * from the swap cost.
 */
export function buildPoolGraph(pools: Pool[], model: CostModel): PoolGraph {
  const tokens: string[] = [];
  const idx = new Map<string, number>();
  const put = (s: string) => {
    if (!idx.has(s)) {
      idx.set(s, tokens.length);
      tokens.push(s);
    }
    return idx.get(s)!;
  };
  for (const p of pools) {
    put(p.tokenA);
    put(p.tokenB);
  }

  const n = tokens.length;
  const nodes = tokens.map((label, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    return {
      x: 0.5 + 0.42 * Math.cos(angle),
      y: 0.5 + 0.42 * Math.sin(angle),
      label,
    };
  });

  const weighted = pools.map((p) => ({
    a: idx.get(p.tokenA)!,
    b: idx.get(p.tokenB)!,
    L: poolCost(p, model),
  }));

  return {
    graph: buildWeightedGraph(nodes, weighted),
    tokens,
    indexOf: (s: string) => idx.get(s) ?? -1,
  };
}

/**
 * EXAMPLE DATA, not real pools.
 * This is where the screener plugs in: it already collects RH Chain pools, they
 * just need to be handed over in this shape.
 */
export const EXAMPLE_POOLS: Pool[] = [
  { tokenA: 'WETH', tokenB: 'USDC', feeBps: 5, liquidityUsd: 4_200_000 },
  { tokenA: 'WETH', tokenB: 'HOOD', feeBps: 30, liquidityUsd: 950_000 },
  { tokenA: 'USDC', tokenB: 'HOOD', feeBps: 30, liquidityUsd: 310_000 },
  { tokenA: 'HOOD', tokenB: 'PONS', feeBps: 100, liquidityUsd: 120_000 },
  { tokenA: 'WETH', tokenB: 'PONS', feeBps: 30, liquidityUsd: 480_000 },
  { tokenA: 'PONS', tokenB: 'MOLD', feeBps: 100, liquidityUsd: 60_000 },
  { tokenA: 'WETH', tokenB: 'MOLD', feeBps: 100, liquidityUsd: 95_000 },
  { tokenA: 'USDC', tokenB: 'WALL', feeBps: 30, liquidityUsd: 220_000 },
  { tokenA: 'WALL', tokenB: 'MOLD', feeBps: 100, liquidityUsd: 45_000 },
  { tokenA: 'HOOD', tokenB: 'WALL', feeBps: 30, liquidityUsd: 180_000 },
  { tokenA: 'WETH', tokenB: 'TENDIES', feeBps: 100, liquidityUsd: 75_000 },
  { tokenA: 'TENDIES', tokenB: 'MOLD', feeBps: 100, liquidityUsd: 30_000 },
];
