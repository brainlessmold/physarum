/**
 * Checks for the on-chain reader.
 *
 * These run offline. The fixtures are hex captured from Robinhood Chain
 * mainnet on 2026-09-12 and 2026-09-13 — the WETH/USDG pool, the VIRTUAL/WETH
 * pool and the NeMo/WETH pool are real reserves. The VIRTUAL-side token and
 * the dust pool are constructed, to exercise the second hub and the liquidity
 * floor. What is checked is the encoding, the decoding, the log reading, the
 * retry behaviour and the shape of the graph that comes out — not the chain.
 */

import {
  ethCallBatch,
  fetchHubPairs,
  fetchHubPrices,
  fetchLivePools,
  readReserves,
  readString,
  toPools,
  HUBS,
  MAX_BATCH,
  PAIR_CREATED,
  V2_FACTORY,
  VIRTUAL,
  WETH,
  USDG,
} from '../src/core/chain.ts';
import { buildPoolGraph, defaultEnds, layoutPoolNodes } from '../src/core/pools.ts';
import { shortestPath } from '../src/core/dijkstra.ts';

let failed = false;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

const w = (n: bigint | number) => n.toString(16).padStart(64, '0');
const addrW = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const topic = (a: string) => '0x' + addrW(a);
const str = (s: string) => {
  const hex = [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return '0x' + w(32) + w(s.length) + hex.padEnd(64, '0');
};
const reserves = (a: bigint, b: bigint) => '0x' + w(a) + w(b) + w(0);

/* --- captured from mainnet --- */
const HEAD = 61_564_549;
const WETH_USDG = '0x8803c117ccae7b5146297876c2a25df135141c4d';
const WETH_RES = 233308529615095578674n;
const USDG_RES = 588065937811n;
const VIRTUAL_WETH = '0xd95e8e2cd04c207625c6f23c974d365a5f3a91d3';
const VW_WETH = 517059344211354065596n;
const VW_VIRTUAL = 2083088294885009167097659n;
const NEMO = '0x2b71d1c62c1238e772231f66c99d0d8d293a79b3';
const NEMO_PAIR = '0xe8dafec1ceb0df85dc324d9eb8ba8ac45a2822fe';
const NEMO_WETH = 100308391918071445017n;

/* --- constructed --- */
const GTR = '0xd4a523245092a654ee2b2d726c329a4874bfafab';
const GTR_PAIR = '0x21b1e0c5ae7b5e9d8857da6aff8173d8d8b56326';
const GTR_VIRTUAL = 13_000n * 10n ** 18n;
const DUST = '0x1111111111111111111111111111111111111111';
const DUST_PAIR = '0x2222222222222222222222222222222222222222';

const POOL: Record<string, { t0: string; t1: string; r: string }> = {
  [WETH_USDG]: { t0: WETH, t1: USDG, r: reserves(WETH_RES, USDG_RES) },
  [VIRTUAL_WETH]: { t0: WETH, t1: VIRTUAL, r: reserves(VW_WETH, VW_VIRTUAL) },
  [NEMO_PAIR]: { t0: WETH, t1: NEMO, r: reserves(NEMO_WETH, 10n ** 24n) },
  [GTR_PAIR]: { t0: GTR, t1: VIRTUAL, r: reserves(10n ** 24n, GTR_VIRTUAL) },
  [DUST_PAIR]: { t0: WETH, t1: DUST, r: reserves(10n ** 14n, 10n ** 18n) },
};
const SYMBOL: Record<string, string> = { [NEMO]: 'NeMo', [GTR]: 'GTR', [DUST]: 'NeMo' };

/** PairCreated logs, as the factory emits them. */
const LOGS = [
  { pair: NEMO_PAIR, t0: WETH, t1: NEMO, block: HEAD - 900 },
  { pair: DUST_PAIR, t0: WETH, t1: DUST, block: HEAD - 800 },
  { pair: GTR_PAIR, t0: GTR, t1: VIRTUAL, block: HEAD - 700 },
];
const asLog = (l: (typeof LOGS)[number]) => ({
  topics: [PAIR_CREATED, topic(l.t0), topic(l.t1)],
  data: '0x' + addrW(l.pair) + w(1),
  blockNumber: '0x' + l.block.toString(16),
});

let requests = 0;
let largestBatch = 0;
let failNext = 0;

const fakeFetcher = async (_url: string, init: RequestInit): Promise<Response> => {
  requests++;
  if (failNext > 0) {
    failNext--;
    throw new TypeError('Failed to fetch');
  }
  const body = JSON.parse(String(init.body));

  if (!Array.isArray(body)) {
    const { method, params } = body as { method: string; params: any[] };
    if (method === 'eth_blockNumber') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + HEAD.toString(16) }));
    }
    if (method === 'eth_getLogs') {
      const [t, a, b] = params[0].topics as (string | null)[];
      const hit = LOGS.filter(
        (l) => t === PAIR_CREATED && (!a || topic(l.t0) === a) && (!b || topic(l.t1) === b),
      );
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: hit.map(asLog) }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
  }

  largestBatch = Math.max(largestBatch, body.length);
  const out = body.map(({ id, params }: any) => {
    const { to, data } = params[0];
    const sel = data.slice(0, 10);
    const arg = data.slice(10);
    const at = to.toLowerCase();
    let result: string | undefined;

    if (at === V2_FACTORY && sel === '0xe6a43905') {
      const x = '0x' + arg.slice(24, 64);
      const y = '0x' + arg.slice(88, 128);
      const has = (p: string, q: string) => (x === p && y === q) || (x === q && y === p);
      let pair = '0x0';
      if (has(WETH, USDG)) pair = WETH_USDG;
      if (has(WETH, VIRTUAL)) pair = VIRTUAL_WETH;
      result = '0x' + addrW(pair);
    }
    if (at === V2_FACTORY && sel === '0x1e3dd18b') result = '0x' + addrW(DUST_PAIR);
    const pool = POOL[at];
    if (pool) {
      if (sel === '0x0dfe1681') result = '0x' + addrW(pool.t0);
      if (sel === '0xd21220a7') result = '0x' + addrW(pool.t1);
      if (sel === '0x0902f1ac') result = pool.r;
    }
    if (sel === '0x95d89b41' && SYMBOL[at]) result = str(SYMBOL[at]);
    return { jsonrpc: '2.0', id, result };
  });
  return new Response(JSON.stringify(out), { status: 200 });
};

const io = { fetcher: fakeFetcher, pauseMs: 0 };

/* ---------------- decoding ---------------- */

console.log('\nDecoding real return data');

const r = readReserves(reserves(WETH_RES, USDG_RES));
check('getReserves decoded', !!r && r[0] === WETH_RES && r[1] === USDG_RES, `${r?.[0]} / ${r?.[1]}`);
check('symbol decoded', readString(str('NeMo')) === 'NeMo', readString(str('NeMo')) ?? 'null');
check('short return rejected', readString('0xdeadbeef') === null, 'returns null, not garbage');
check('truncated reserves rejected', readReserves('0x' + w(1n)) === null, 'returns null');

/* ---------------- transport ---------------- */

console.log('\nTransport against a throttled public RPC');

requests = 0;
largestBatch = 0;
const many = Array.from({ length: 95 }, (_, i) => ({ to: V2_FACTORY, data: '0x1e3dd18b' + w(i) }));
const answers = await ethCallBatch(many, io);
check('every call answered', answers.every((a) => !!a), `${answers.length} of ${many.length}`);
check(
  'no batch over the measured limit',
  largestBatch <= MAX_BATCH,
  `largest ${largestBatch}, limit ${MAX_BATCH} (50 is accepted by the RPC, 100 is refused)`,
);
check('split into whole batches', requests === Math.ceil(95 / MAX_BATCH), `${requests} requests`);

failNext = 2;
requests = 0;
const afterThrottle = await ethCallBatch([{ to: WETH_USDG, data: '0x0902f1ac' }], io);
check(
  'a throttled request is retried, not fatal',
  afterThrottle[0] !== null && requests === 3,
  `gave up twice, succeeded on attempt ${requests}`,
);

/* ---------------- logs ---------------- */

console.log('\nPools found through PairCreated events');

const wethPairs = await fetchHubPairs(HUBS[0], 0, io);
check(
  'the hub is found on either side of the pair',
  wethPairs.length === 2 && wethPairs.every((p) => p.other !== WETH),
  `${wethPairs.length} pools, other sides ${wethPairs.map((p) => p.other.slice(0, 8)).join(', ')}`,
);
const virtualPairs = await fetchHubPairs(HUBS[1], 0, io);
check(
  'a pair where the hub is token1 is read the right way round',
  virtualPairs.length === 1 && virtualPairs[0].other === GTR,
  `VIRTUAL/GTR read as other = ${virtualPairs[0]?.other.slice(0, 8)}`,
);
check(
  'records come back oldest first',
  wethPairs[0].block <= wethPairs[wethPairs.length - 1].block,
  'so slicing the end takes the newest',
);

/* ---------------- prices ---------------- */

console.log('\nHubs priced from their own pools, not an oracle');

const prices = await fetchHubPrices(io);
const eth = Number(USDG_RES) / 1e6 / (Number(WETH_RES) / 1e18);
const virt = (Number(VW_WETH) / 1e18 / (Number(VW_VIRTUAL) / 1e18)) * eth;
check('USDG is the unit', prices['USDG'] === 1, '1 USDG = $1 by definition');
check('WETH priced', Math.abs(prices['WETH'] - eth) < 1e-6, `$${prices['WETH'].toFixed(2)}`);
check('VIRTUAL priced through WETH', Math.abs(prices['VIRTUAL'] - virt) < 1e-9, `$${prices['VIRTUAL'].toFixed(4)}`);
check(
  'decimals handled — 18 against 6',
  prices['WETH'] > 100 && prices['WETH'] < 100_000,
  'a plausible range, so nothing is off by 10^12',
);

/* ---------------- snapshot ---------------- */

console.log('\nThe snapshot');

const snap = await fetchLivePools({ perHubScan: 10, minUsd: 2_000, perHub: 4, ...io });
check('head block read', snap.blockNumber === HEAD, `${snap.blockNumber.toLocaleString('en-US')}`);
check('dust dropped', !snap.pools.some((p) => p.liquidityUsd < 2_000), `${snap.pools.length} pools, none under $2,000`);
check(
  'both hubs represented',
  new Set(snap.pools.map((p) => p.hub)).size >= 2,
  [...new Set(snap.pools.map((p) => p.hub))].join(', '),
);
check(
  'hubs joined to each other',
  snap.pools.some((p) => p.hub === 'WETH' && p.symbol === 'VIRTUAL'),
  'the VIRTUAL/WETH pool is in the graph',
);

/* ---------------- graph ---------------- */

console.log('\nThe graph that comes out');

const pools = toPools(snap);
const collided = toPools({
  ...snap,
  pools: [
    { pair: '0xa', hub: 'WETH', token: NEMO, symbol: 'NeMo', hubReserve: 1, liquidityUsd: 50_000 },
    { pair: '0xb', hub: 'WETH', token: DUST, symbol: 'NeMo', hubReserve: 1, liquidityUsd: 50_000 },
  ],
});
check('colliding tickers kept apart', collided[0].tokenB !== collided[1].tokenB, `${collided[0].tokenB} and ${collided[1].tokenB}`);
check('the same token keeps one label', collided[0].tokenA === collided[1].tokenA, `both anchor on ${collided[0].tokenA}`);

const { graph, indexOf } = buildPoolGraph(pools, { tradeSizeUsd: 10_000 });
const route = shortestPath(graph, indexOf('NeMo'), indexOf('GTR'));
check(
  'a route exists across the two hubs',
  route.nodes.length === 4 && isFinite(route.distance),
  route.nodes.length ? route.nodes.map((i) => graph.nodes[i].label).join(' → ') : 'none',
);

/* ---------------- layout ---------------- */

console.log('\nThe layout');

const tokens = graph.nodes.map((n) => n.label!);
const nodes = layoutPoolNodes(tokens, pools);
check(
  'every node is on the canvas',
  nodes.every((n) => n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1),
  'all inside [0..1]',
);
const hubNames = new Set(pools.map((p) => p.tokenA));
const hubRow = nodes.filter((n) => hubNames.has(n.label));
check(
  'hubs share the spine',
  hubRow.length > 0 && hubRow.every((n) => Math.abs(n.y - 0.5) < 1e-9),
  `${hubRow.map((n) => n.label).join(', ')} all at y = 0.5`,
);
const minGap = nodes
  .flatMap((a, i) => nodes.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y)))
  .reduce((m, d) => Math.min(m, d), Infinity);
check('no two nodes land on the same spot', minGap > 0.04, `closest pair ${minGap.toFixed(3)} apart`);
const leaves = nodes.filter((n) => !hubNames.has(n.label));
check(
  'a leaf labels away from its hub',
  leaves.length > 0 && leaves.every((n) => (n.x < 0.3 ? n.anchor !== 'e' : n.x > 0.7 ? n.anchor !== 'w' : true)),
  leaves.map((n) => `${n.label}:${n.anchor}`).join(' '),
);
check(
  'the fan uses the height, not just one band',
  Math.max(...nodes.map((n) => n.y)) - Math.min(...nodes.map((n) => n.y)) > 0.4,
  `${(Math.max(...nodes.map((n) => n.y)) - Math.min(...nodes.map((n) => n.y))).toFixed(2)} of the canvas height used`,
);

const [endA, endB] = defaultEnds(pools);
check('two endpoints chosen', !!endA && !!endB && endA !== endB, `${endA} and ${endB}`);
check('neither endpoint is a hub', !hubNames.has(endA) && !hubNames.has(endB), 'opening on a bridge would show nothing');
check('an empty graph does not throw', defaultEnds([])[0] === '', 'returns a pair of blanks');

console.log('');
if (failed) {
  console.error('FAILED\n');
  process.exit(1);
}
console.log('All checks passed.\n');
