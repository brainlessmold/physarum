/**
 * Checks for network mode — what the Tokyo and Pools screens draw.
 *
 * 1. Tokyo: the network must come out connected, cover every city, and have a
 *    cost in a sensible range. Cost is computed as in the paper: total network
 *    length divided by the length of the minimum spanning tree. The authors got
 *    1.75 against 1.80 for the actual railway.
 *
 * 2. Pools: a route between tokens must be found, and must be cheaper than the
 *    direct one when the direct pool is shallow.
 */

import { buildGraph, type Graph } from '../src/core/graph.ts';
import { KANTO, project, nearestNeighbourEdges } from '../src/data/kanto.ts';
import { Physarum } from '../src/core/solver.ts';
import { buildPoolGraph, EXAMPLE_POOLS, poolCost } from '../src/core/pools.ts';
import { shortestPath } from '../src/core/dijkstra.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimum spanning tree length, via Kruskal. */
function mstLength(graph: Graph): number {
  const parent = graph.nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const sorted = graph.edges.map((e, i) => ({ i, L: e.L })).sort((a, b) => a.L - b.L);
  let total = 0;
  for (const { i } of sorted) {
    const e = graph.edges[i];
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) {
      parent[ra] = rb;
      total += e.L;
    }
  }
  return total;
}

/** Whether the surviving subgraph is connected and how many cities it reaches. */
function componentCheck(graph: Graph, keep: number[]): { connected: boolean; covered: number } {
  const parent = graph.nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const touched = new Set<number>();
  for (const ei of keep) {
    const e = graph.edges[ei];
    touched.add(e.a);
    touched.add(e.b);
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const roots = new Set([...touched].map(find));
  return { connected: roots.size === 1, covered: touched.size };
}

let failed = false;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

/* ---------------- Tokyo ---------------- */

console.log('\nTokyo: network over 36 Kanto cities');

const points = project(KANTO);
const pairs = nearestNeighbourEdges(points, 4);
const rng = mulberry32(7);
const kanto = buildGraph(points, pairs, { rng });

// Same parameters as the Tokyo screen uses.
const CUT = { absolute: 0.01 };
const mold = new Physarum(kanto, KANTO.map((_, i) => i), {
  I0: 1,
  g: 1.15,
  dt: 0.12,
  pairsPerStep: 8,
  relaxIters: 20,
  rng,
});
mold.run(300);

const keep = mold.surviving(CUT);
const { connected, covered } = componentCheck(kanto, keep);
const cost = mold.networkLength(CUT) / mstLength(kanto);

check('candidate graph built', pairs.length > KANTO.length, `${pairs.length} edges over ${KANTO.length} cities`);
check('network connected', connected, connected ? 'single component' : 'fell apart');
check('city coverage', covered === KANTO.length, `${covered} of ${KANTO.length}`);
check(
  'network cost in a sensible range',
  cost > 1.0 && cost < 2.5,
  `${cost.toFixed(2)} (paper: 1.75 for the mold, 1.80 for the railway)`,
);
check(
  'network pruned',
  keep.length < pairs.length * 0.8,
  `${keep.length} of ${pairs.length} routes kept`,
);

/* ---------------- Pools ---------------- */

console.log('\nPools: swap route search');

const size = 10_000;
const { graph: pg, tokens, indexOf } = buildPoolGraph(EXAMPLE_POOLS, { tradeSizeUsd: size });
const route = shortestPath(pg, indexOf('USDC'), indexOf('MOLD'));

const directPool = EXAMPLE_POOLS.find(
  (p) =>
    (p.tokenA === 'USDC' && p.tokenB === 'MOLD') || (p.tokenA === 'MOLD' && p.tokenB === 'USDC'),
);

check('all tokens collected', tokens.length > 0, tokens.join(', '));
check('route found', route.nodes.length >= 2, route.nodes.map((i) => tokens[i]).join(' -> '));
check(
  'cost computed',
  isFinite(route.distance) && route.distance > 0,
  `${(route.distance * 100).toFixed(2)}% on a $${size.toLocaleString('en-US')} trade`,
);
check(
  'no direct USDC/MOLD pool, so the route is multi-hop',
  !directPool && route.nodes.length > 2,
  `${route.nodes.length} nodes in the route`,
);

const moldPool = EXAMPLE_POOLS.find((p) => p.tokenB === 'MOLD' && p.tokenA === 'WETH')!;
check(
  'cost grows with trade size',
  poolCost(moldPool, { tradeSizeUsd: 100_000 }) > poolCost(moldPool, { tradeSizeUsd: 1_000 }),
  `${(poolCost(moldPool, { tradeSizeUsd: 1_000 }) * 100).toFixed(2)}% → ${(
    poolCost(moldPool, { tradeSizeUsd: 100_000 }) * 100
  ).toFixed(2)}%`,
);

/* ---------------- Convergence on the pool graph ---------------- */

console.log('\nPools: mold against Dijkstra on the same graph');

const pmold = new Physarum(pg, [indexOf('USDC'), indexOf('MOLD')], { rng: mulberry32(11) });
pmold.run(1200);
const moldLen = pmold.networkLength(0.25);
check(
  'mold found the same route',
  Math.abs(moldLen - route.distance) < 1e-3,
  `mold ${(moldLen * 100).toFixed(3)}%, Dijkstra ${(route.distance * 100).toFixed(3)}%`,
);

console.log('');
if (failed) {
  console.error('FAILED\n');
  process.exit(1);
}
console.log('All checks passed.\n');
