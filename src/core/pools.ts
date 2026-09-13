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
 * Where the nodes go.
 *
 * The old version put every token on one circle, which on a real pool graph
 * turns into a spider web: with two hubs and a dozen leaves, every edge crosses
 * the middle and nothing is readable.
 *
 * The chain has a shape, so the picture should have it too. A hub is any token
 * that other tokens are anchored on. Hubs go on a spine across the middle;
 * every hub's own tokens fan out in an arc on the side facing away from the
 * other hubs. The result reads as what it is: clusters joined by bridges. The
 * geometry is decorative — it never touches edge lengths, which come from the
 * swap cost alone.
 */
export function layoutPoolNodes(
  tokens: string[],
  pools: Pool[],
): Array<{ x: number; y: number; label: string; anchor: 'n' | 's' | 'e' | 'w' }> {
  const hubNames: string[] = [];
  const seen = new Set<string>();
  for (const p of pools) {
    if (!seen.has(p.tokenA)) {
      seen.add(p.tokenA);
      hubNames.push(p.tokenA);
    }
  }
  // A token anchored on another hub is a bridge, not a hub of its own right
  // here; it still gets a spine slot, which is what makes the bridge visible.
  const hubs = hubNames.filter((h) => tokens.includes(h));
  if (hubs.length === 0) return ring(tokens);

  const leavesOf = new Map<string, string[]>(hubs.map((h) => [h, []]));
  const placed = new Set(hubs);
  for (const p of pools) {
    if (placed.has(p.tokenB)) continue;
    placed.add(p.tokenB);
    leavesOf.get(p.tokenA)?.push(p.tokenB);
  }
  const orphans = tokens.filter((t) => !placed.has(t));

  type Placed = { x: number; y: number; anchor: 'n' | 's' | 'e' | 'w' };
  const pos = new Map<string, Placed>();

  // The spine. One hub sits in the middle; several spread across it.
  const H = hubs.length;
  hubs.forEach((h, i) => {
    const x = H === 1 ? 0.5 : 0.5 + (i / (H - 1) - 0.5) * 0.40;
    pos.set(h, { x, y: 0.5, anchor: 'n' });
  });

  hubs.forEach((h, i) => {
    const leaves = leavesOf.get(h) ?? [];
    if (leaves.length === 0) return;
    const centre = pos.get(h)!;
    // Face away from the middle of the spine: the leftmost hub opens left, the
    // rightmost opens right, a lone or middle hub opens both up and down.
    const outward = H === 1 ? 0 : i === 0 ? Math.PI : i === H - 1 ? 0 : -Math.PI / 2;
    // The fan must stay under half a turn: wider than that and the outermost
    // leaves wrap back past the hub and land on the wrong side of it. Within
    // that limit it opens as wide as it can, because the height of the panel is
    // otherwise wasted and everything piles into one horizontal band.
    const spread = H === 1 ? Math.PI * 2 : i > 0 && i < H - 1 ? Math.PI * 0.72 : Math.PI * 0.86;
    const radius = 0.17 + Math.min(0.1, leaves.length * 0.015);

    leaves.forEach((leaf, k) => {
      const t = leaves.length === 1 ? 0.5 : k / (leaves.length - 1);
      const angle = outward + (t - 0.5) * spread;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // The label goes on the side the node already points to, away from its hub.
      const anchor: 'n' | 's' | 'e' | 'w' =
        cos < -0.5 ? 'w' : cos > 0.5 ? 'e' : sin > 0 ? 's' : 'n';
      pos.set(leaf, {
        x: centre.x + radius * cos * 1.08,
        y: centre.y + radius * sin * 1.45,
        anchor,
      });
    });
  });

  orphans.forEach((t, i) => {
    const angle = (i / Math.max(1, orphans.length)) * Math.PI * 2;
    pos.set(t, {
      x: 0.5 + 0.46 * Math.cos(angle),
      y: 0.5 + 0.46 * Math.sin(angle),
      anchor: Math.cos(angle) < 0 ? 'w' : 'e',
    });
  });

  // Keep everything inside the canvas with room for a label.
  const clamp = (v: number) => Math.max(0.06, Math.min(0.94, v));
  return tokens.map((label) => {
    const p = pos.get(label) ?? { x: 0.5, y: 0.5, anchor: 'n' as const };
    return { x: clamp(p.x), y: clamp(p.y), label, anchor: p.anchor };
  });
}

function ringAnchor(angle: number): 'n' | 's' | 'e' | 'w' {
  return Math.cos(angle) < -0.5 ? 'w' : Math.cos(angle) > 0.5 ? 'e' : Math.sin(angle) > 0 ? 's' : 'n';
}

function ring(
  tokens: string[],
): Array<{ x: number; y: number; label: string; anchor: 'n' | 's' | 'e' | 'w' }> {
  const n = tokens.length;
  return tokens.map((label, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    return {
      x: 0.5 + 0.42 * Math.cos(angle),
      y: 0.5 + 0.42 * Math.sin(angle),
      label,
      anchor: ringAnchor(angle),
    };
  });
}

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

  const nodes = layoutPoolNodes(tokens, pools);

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
 * Picks the two endpoints that make the routing question real: the deepest
 * token on one hub and the deepest on another, so a route has to cross between
 * them. On a single-hub graph it falls back to the two deepest pools.
 *
 * Pools are keyed by tokenA because that is the hub side — every pool the chain
 * reader produces is anchored on one.
 */
export function defaultEnds(pools: Pool[]): [string, string] {
  if (pools.length === 0) return ['', ''];
  const deepest = [...pools].sort((x, y) => y.liquidityUsd - x.liquidityUsd);

  // A hub is any token something else is anchored on. A pool joining two hubs
  // is the bridge, not a destination — routing WETH to VIRTUAL would just show
  // the bridge itself, so those are skipped when picking what to open on.
  const hubNames = new Set(pools.map((p) => p.tokenA));
  const leaves = deepest.filter((p) => !hubNames.has(p.tokenB));
  const pick = leaves.length >= 2 ? leaves : deepest;

  const byHub = new Map<string, Pool>();
  for (const p of pick) if (!byHub.has(p.tokenA)) byHub.set(p.tokenA, p);
  const across = [...byHub.values()];
  if (across.length >= 2) return [across[0].tokenB, across[1].tokenB];
  return [pick[0].tokenB, pick[1]?.tokenB ?? pick[0].tokenA];
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
  { tokenA: 'PONS', tokenB: 'PHYSARUM', feeBps: 100, liquidityUsd: 60_000 },
  { tokenA: 'WETH', tokenB: 'PHYSARUM', feeBps: 100, liquidityUsd: 95_000 },
  { tokenA: 'USDC', tokenB: 'WALL', feeBps: 30, liquidityUsd: 220_000 },
  { tokenA: 'WALL', tokenB: 'PHYSARUM', feeBps: 100, liquidityUsd: 45_000 },
  { tokenA: 'HOOD', tokenB: 'WALL', feeBps: 30, liquidityUsd: 180_000 },
  { tokenA: 'WETH', tokenB: 'TENDIES', feeBps: 100, liquidityUsd: 75_000 },
  { tokenA: 'TENDIES', tokenB: 'PHYSARUM', feeBps: 100, liquidityUsd: 30_000 },
];
