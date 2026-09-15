/**
 * Checks for the routing endpoint's answer.
 *
 * The endpoint itself is a handler around one function, and this is that
 * function. It is given pools directly, so nothing here touches the chain.
 *
 * The check that matters is the one the answer carries in public: the mould's
 * cost and Dijkstra's have to agree. The model is proven to converge on the
 * shortest path, so a disagreement is a bug in this code and nowhere else.
 */

import { planRoute, type RoutePlan } from '../src/core/route.ts';
import type { Pool } from '../src/core/pools.ts';

let failed = false;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

/** Two hubs, a bridge between them, and leaves on each — the shape of the chain. */
const POOLS: Pool[] = [
  { tokenA: 'WETH', tokenB: 'USDG', feeBps: 30, liquidityUsd: 1_200_000, venue: 'v2' },
  { tokenA: 'WETH', tokenB: 'VIRTUAL', feeBps: 30, liquidityUsd: 2_600_000, venue: 'v2' },
  { tokenA: 'WETH', tokenB: 'ARENA', feeBps: 30, liquidityUsd: 90_000, venue: 'v2' },
  { tokenA: 'USDG', tokenB: 'WOOD', feeBps: 30, liquidityUsd: 80_000, venue: 'v2' },
  { tokenA: 'VIRTUAL', tokenB: 'GTR', feeBps: 30, liquidityUsd: 16_000, venue: 'v2' },
  // the same pair as the first, but quoted by V3 and cheaper
  { tokenA: 'WETH', tokenB: 'USDG', feeBps: 30, liquidityUsd: 1_200_000, cost: 0.0004, venue: 'v3', feeTier: 100 },
];

const plan = (from: string, to: string, size = 10_000) =>
  planRoute(POOLS, from, to, size) as RoutePlan;

/* ---------------- the answer ---------------- */

console.log('\nWhat the endpoint answers');

const p = plan('ARENA', 'WOOD');
check('a route is found across the hubs', p.route.length === 4, p.route.join(' → '));
check('it starts and ends where it was asked to', p.route[0] === 'ARENA' && p.route[3] === 'WOOD', `${p.route[0]} … ${p.route[3]}`);
check('a hop per edge', p.hops.length === p.route.length - 1, `${p.hops.length} hops for ${p.route.length} nodes`);
check(
  'the hops join up end to end',
  p.hops.every((h, i) => [h.from, h.to].includes(p.route[i]) && [h.from, h.to].includes(p.route[i + 1])),
  p.hops.map((h) => `${h.from}/${h.to}`).join(' '),
);
check('the total is the sum of the hops', Math.abs((p.costPct ?? 0) - p.hops.reduce((s, h) => s + h.costPct, 0)) < 0.01, `${p.costPct}% total`);

/* ---------------- the check it publishes ---------------- */

console.log('\nThe check the answer carries');

check('the mould and Dijkstra agree', p.agree, `mould ${p.mould.costPct}%, Dijkstra ${p.dijkstra.costPct}%`);
check('the mould actually ran', p.mould.steps > 0 && p.mould.tubesLeft > 0, `${p.mould.steps} steps, ${p.mould.tubesLeft} tubes left`);
for (const [a, b] of [['WETH', 'GTR'], ['WOOD', 'GTR'], ['ARENA', 'VIRTUAL'], ['USDG', 'ARENA']]) {
  const q = plan(a, b);
  check(`  ${a} → ${b} agrees too`, q.agree, q.route.join(' → '));
}

/* ---------------- venues ---------------- */

console.log('\nWhere each hop goes');

const viaUsdg = plan('WETH', 'WOOD');
const first = viaUsdg.hops[0];
check(
  'the cheaper venue for a pair wins',
  first.venue === 'v3' && first.quoted,
  `WETH→USDG taken on ${first.venue} at tier ${first.feeTier}, quoted rather than computed`,
);
check(
  'a quoted hop reports the quoted cost, not the formula',
  Math.abs(first.costPct - 0.04) < 1e-9,
  `${first.costPct}% from the quoter`,
);
check(
  'a constant-product hop is not marked as quoted',
  viaUsdg.hops.slice(1).every((h) => h.venue === 'v2' && !h.quoted),
  'the rest solved from reserves',
);

/* ---------------- trade size ---------------- */

console.log('\nSize changes the answer, as it should');

const small = plan('ARENA', 'WOOD', 1_000);
const large = plan('ARENA', 'WOOD', 250_000);
check('a bigger trade costs more', (large.costPct ?? 0) > (small.costPct ?? 0), `${small.costPct}% at $1k → ${large.costPct}% at $250k`);
check('and it still checks out', small.agree && large.agree, 'both agree with Dijkstra');

/* ---------------- refusals ---------------- */

console.log('\nWhat it refuses to answer');

const unknown = planRoute(POOLS, 'NOPE', 'WOOD', 10_000);
check('an unknown token is refused, not guessed', 'error' in unknown, 'error' in unknown ? unknown.error : 'answered anyway');
check('and the refusal says what it does know', 'error' in unknown && unknown.tokens.includes('WOOD'), 'the token list comes back with it');
const same = planRoute(POOLS, 'WOOD', 'WOOD', 10_000);
check('a route to itself is refused', 'error' in same, 'no zero-length route is invented');

console.log('');
if (failed) {
  console.error('FAILED\n');
  process.exit(1);
}
console.log('All checks passed.\n');
