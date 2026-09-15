/**
 * Checks for the Uniswap V4 side.
 *
 * The risk here is not the arithmetic, it is the encoding. A V4 quote takes a
 * struct containing a struct and a bytes member, and getting a single word
 * wrong produces a call that still returns something. So the encoder is checked
 * against bytes written out by hand from the ABI rules, and the decoding of the
 * Initialize event is checked against a log shaped the way the PoolManager
 * emits them — including a negative tick spacing, which is where a naive reader
 * silently turns -200 into 16,777,016.
 */

import {
  encodeQuote,
  findV4Pools,
  quoteV4,
  bestQuote,
  fetchTokenMarket,
  INITIALIZE,
  NATIVE,
  POOL_MANAGER,
  STATE_VIEW,
  V4_QUOTER,
} from '../src/core/v4.ts';

let failed = false;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const addrW = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const TOKEN = '0x421f2cedab5e16fbfa39fd537b67863c6a7c72af';
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';

/* ---------------- encoding ---------------- */

console.log('\nEncoding a V4 quote');

const key = { currency0: NATIVE, currency1: TOKEN, fee: 810_000, tickSpacing: 19_988, hooks: '0x' + '0'.repeat(40) };
const got = encodeQuote(key, true, 10n ** 16n);

// Written out from the ABI rules rather than from the encoder: the argument is
// a struct with a bytes member, so it is dynamic — one offset word, then the
// five key fields, the direction, the amount, the offset to hookData measured
// from the start of the struct, and its length.
const expected =
  '0xaa9d21cb' +
  w(32) +
  addrW(NATIVE) +
  addrW(TOKEN) +
  w(810_000) +
  w(19_988) +
  addrW('0x' + '0'.repeat(40)) +
  w(1) +
  w(10n ** 16n) +
  w(256) +
  w(0);

check('the call data matches the ABI by hand', got === expected, `${got.length} hex chars, 10 words after the selector`);
check('the selector is the one V4Quoter exposes', got.startsWith('0xaa9d21cb'), '0xaa9d21cb');
check(
  'direction flips with the currency order',
  encodeQuote(key, false, 1n).slice(10 + 64 * 6, 10 + 64 * 7) === w(0),
  'zeroForOne written as 0 when the token is the input',
);

const negative = encodeQuote({ ...key, tickSpacing: -200 }, true, 1n);
check(
  'a negative tick spacing is encoded as two’s complement',
  negative.slice(10 + 64 * 4, 10 + 64 * 5) === 'f'.repeat(62) + '38',
  '-200 becomes ...ff38, not a huge positive number',
);

/* ---------------- the fake chain ---------------- */

const initLog = (id: string, c0: string, c1: string, fee: number, spacing: number, hooks: string, block: number) => {
  const spacingWord = spacing < 0 ? ((1n << 256n) + BigInt(spacing)).toString(16).padStart(64, '0') : w(spacing);
  return {
    topics: [INITIALIZE, id, '0x' + addrW(c0), '0x' + addrW(c1)],
    data: '0x' + w(fee) + spacingWord + addrW(hooks) + w(0) + w(0),
    blockNumber: '0x' + block.toString(16),
  };
};

const POOLS = [
  initLog('0x' + 'a'.repeat(64), NATIVE, TOKEN, 810_000, 19_988, '0x' + '0'.repeat(40), 100),
  initLog('0x' + 'b'.repeat(64), NATIVE, TOKEN, 830_269, -200, '0x' + '0'.repeat(40), 90),
  initLog('0x' + 'c'.repeat(64), TOKEN, '0x' + '5'.repeat(40), 902_000, 18_000, '0x' + '0'.repeat(40), 110),
  initLog('0x' + 'd'.repeat(64), '0x' + '2'.repeat(40), TOKEN, 0, 200, HOOK, 120),
];

/** How much each pool gives back, by id prefix. */
const GIVES: Record<string, bigint> = {
  a: 173_861n * 10n ** 18n,
  b: 238_684n * 10n ** 18n, // the deepest, and the one the price should come from
  c: 0n, // refuses
  d: 386_571n * 10n ** 18n, // hooked, but not against ETH
};

let quoterCalls = 0;

const fakeFetcher = async (_url: string, init: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init.body));

  if (!Array.isArray(body)) {
    const { method, params } = body as { method: string; params: any[] };
    if (method !== 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
    const [, , t2, t3] = params[0].topics as (string | null)[];
    const want = '0x' + addrW(TOKEN);
    const hit = POOLS.filter((l) => (t2 ? l.topics[2] === want : true) && (t3 ? l.topics[3] === want : true))
      .filter((l) => (t2 ? l.topics[2] === t2 : l.topics[3] === t3));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: hit }));
  }

  const out = body.map(({ id, params }: any) => {
    const { to, data } = params[0];
    const at = to.toLowerCase();
    let result: string | undefined;
    if (at === V4_QUOTER) {
      quoterCalls++;
      // find the pool by its fee, which is word 3 of the call
      const fee = Number(BigInt('0x' + data.slice(10 + 64 * 3, 10 + 64 * 4)));
      const log = POOLS.find((l) => Number(BigInt('0x' + l.data.slice(2, 66))) === fee);
      const keyOf = log ? (log.topics[1] as string)[2] : '';
      result = '0x' + w(GIVES[keyOf] ?? 0n) + w(0);
    }
    if (at === STATE_VIEW) result = '0x' + w(12345n);
    return { jsonrpc: '2.0', id, result };
  });
  return new Response(JSON.stringify(out), { status: 200 });
};

const io = { fetcher: fakeFetcher, pauseMs: 0 };

/* ---------------- discovery ---------------- */

console.log('\nFinding pools that are not contracts');

const found = await findV4Pools(TOKEN, 0, io);
check('every pool holding the token is found', found.length === 4, `${found.length} pools, on both sides of the key`);
check('no pool is counted twice', new Set(found.map((p) => p.id)).size === found.length, 'ids are unique');
check('records come back oldest first', found[0].block <= found[found.length - 1].block, `${found[0].block} … ${found[found.length - 1].block}`);
check(
  'a negative tick spacing survives the round trip',
  found.some((p) => p.tickSpacing === -200),
  'read back as -200',
);
check(
  'a pool with a hook is marked as one',
  found.filter((p) => p.hooked).length === 1 && found.find((p) => p.hooked)?.hooks === HOOK,
  `1 of ${found.length} runs ${HOOK.slice(0, 10)}…`,
);
check(
  'a pool without a hook is not',
  found.filter((p) => !p.hooked).length === 3,
  'the zero address is absence, not a hook',
);

/* ---------------- quoting ---------------- */

console.log('\nAsking each pool what it would give');

const againstEth = found.filter((p) => p.currency0 === NATIVE || p.currency1 === NATIVE);
const quotes = await quoteV4(againstEth, NATIVE, 10n ** 16n, io);
check('only pools holding ETH were asked', againstEth.length === 2, `${againstEth.length} of ${found.length}`);
check('a pool that gives nothing is dropped', quotes.length === 2, `${quotes.length} answered`);
check('liquidity is read alongside the quote', quotes.every((q) => q.liquidity === 12345n), 'from StateView, by pool id');

const best = bestQuote(quotes)!;
check('the best pool is the one giving most', best.amountOut === GIVES['b'], `${(Number(best.amountOut) / 1e18).toLocaleString('en-US')} out`);

/* ---------------- the price ---------------- */

console.log('\nPricing the token from its own pools');

quoterCalls = 0;
const market = await fetchTokenMarket(TOKEN, { ethUsd: 2_538, probeUsd: 25 }, io);
const expectedPrice = 25 / (Number(GIVES['b']) / 1e18);
check('a price came out', market.priceUsd !== null, `$${market.priceUsd?.toFixed(8)}`);
check('it is the price from the best pool', Math.abs((market.priceUsd ?? 0) - expectedPrice) < 1e-12, `$${expectedPrice.toFixed(8)} per token`);
check('every pool is counted, not only the ones priced', market.pools === 4, `${market.pools} pools, ${market.hooked} hooked`);
check('the probe is small on purpose', market.probeUsd === 25, '$25, to stay near the marginal price');
check('a token with no ETH pool prices as nothing rather than guessing', (await fetchTokenMarket('0x' + '9'.repeat(40), { ethUsd: 2_538 }, io)).priceUsd === null, 'returns null');
check('no price is invented when the chain gives no ETH price', (await fetchTokenMarket(TOKEN, { ethUsd: 0 }, io)).priceUsd === null, 'returns null');

console.log('');
if (failed) {
  console.error('FAILED\n');
  process.exit(1);
}
console.log('All checks passed.\n');
