/**
 * Live mode: reading Uniswap V2 pools straight off Robinhood Chain.
 *
 * No SDK, no indexer, no API key, no backend. Everything here is plain
 * eth_call against the public RPC, encoded and decoded by hand, so the page
 * that shows a route is the same code that fetched the reserves behind it.
 *
 * Scope, stated before anyone asks: V2 only. Uniswap V3 and V4 are also
 * deployed on this chain and carry more volume, but their liquidity is
 * concentrated in ticks, and the slippage estimate in pools.ts (S / L) is only
 * valid for a constant-product pool. Routing V3 honestly means calling their
 * quoter, which is a different job. Rather than quietly mix the two, this
 * module reads V2 and says so.
 *
 * Addresses:
 *   RPC, chain id 4663     docs.robinhood.com/chain/connecting
 *   WETH, USDG             docs.robinhood.com/chain/contracts
 *   UniswapV2Factory       github.com/Uniswap/contracts deployments/4663.md
 */

import {
  ethCallBatch,
  rpc,
  readString,
  readReserves,
  word,
  addrWord,
  readAddress,
  RPC_URL,
  RPC_FALLBACK,
  MAX_BATCH,
  type Call,
  type Fetcher,
  type Io,
} from './rpc.ts';

// Re-exported so the rest of the project, and its tests, keep importing these
// from where they always did.
export { ethCallBatch, rpc, readString, readReserves, RPC_URL, RPC_FALLBACK, MAX_BATCH };
export type { Call, Fetcher, Io };

import { findV3Pools, quoteV3, cheapestPerPair, type V3Cost } from './v3.ts';
import { poolCost } from './pools.ts';


export const CHAIN_ID = 4663;

export const V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const USDG_DECIMALS = 6;


/** Uniswap V2 charges a flat 0.3% on every pool. */
export const V2_FEE_BPS = 30;

/** keccak256('PairCreated(address,address,address,uint256)') */
export const PAIR_CREATED =
  '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

/**
 * How far back to ask for PairCreated events.
 *
 * The public RPC accepts an unbounded range — asking from block zero works and
 * returns every pair a hub has ever had. It also returns thousands of them,
 * which is a large response for a page to swallow, so the window is bounded.
 * Three million blocks currently covers a few hundred WETH pairs and a few
 * dozen on the smaller hubs: enough to see the shape, small enough to load.
 */
export const LOG_WINDOW_BLOCKS = 3_000_000;

const SEL_V2 = {
  allPairsLength: '0x574f2ba3',
  allPairs: '0x1e3dd18b',
  getPair: '0xe6a43905',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
} as const;


/**
 * The hubs.
 *
 * Measured, not assumed. A sample of 200 pairs spread across the whole factory
 * came out 38% paired against WETH and 61% against something else — and almost
 * all of that "something else" was one token, VIRTUAL, which runs its own
 * launchpad. Tokens launched there pair with VIRTUAL and never with WETH.
 *
 * So the pool graph on this chain is not a star. It has two centres joined by a
 * deep VIRTUAL/WETH pool, plus USDG hanging off WETH as the dollar. That is why
 * routing here is a real question: getting from a VIRTUAL-side token to a
 * WETH-side one is a four-node path, and which hub you cross at matters.
 */
export interface Hub {
  symbol: string;
  /** Lower-case, as every address in this module is. */
  address: string;
  decimals: number;
}

export const HUBS: Hub[] = [
  { symbol: 'WETH', address: WETH, decimals: 18 },
  { symbol: 'VIRTUAL', address: '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31', decimals: 18 },
  { symbol: 'USDG', address: USDG, decimals: USDG_DECIMALS },
];

export const VIRTUAL = HUBS[1].address;

/** The trade sizes the page offers, quoted up front so the control is instant. */
export const TRADE_SIZES_USD = [1_000, 10_000, 50_000, 250_000];

export interface LivePool {
  pair: string;
  /** Which hub this pool is anchored on. */
  hub: string;
  /** The other token, or a second hub when the pool joins two of them. */
  symbol: string;
  token: string;
  /** Reserve on the hub side, in whole units. */
  hubReserve: number;
  /** Both sides valued at the hub side, in dollars. */
  liquidityUsd: number;
}

export interface LiveSnapshot {
  pools: LivePool[];
  /** Concentrated-liquidity quotes for the same pairs, keyed "hub>token". */
  v3: Record<string, V3Cost>;
  /** Every hub priced in dollars, read from the pools themselves. */
  hubUsd: Record<string, number>;
  /** Chain head at the time of the read. */
  blockNumber: number;
  /** How many pools were priced across all hubs. */
  scanned: number;
  /**
   * The PairCreated logs this read was built from, so a caller can hold them
   * and skip the expensive half of the next read. See ScanOptions.pairLogs.
   */
  pairLogs: RawLog[];
}

export interface ScanOptions {
  /** How many of a hub's newest pools to price. */
  perHubScan?: number;
  /** Ignore a pool worth less than this in dollars. */
  minUsd?: number;
  /** Keep at most this many pools per hub, deepest first. */
  perHub?: number;
  /** How far back to ask for PairCreated events. */
  windowBlocks?: number;
  rpcUrl?: string;
  fetcher?: Fetcher;
  /** Passed through to the transport: how long to wait between batches. */
  pauseMs?: number;
  /** Passed through to the transport: attempts per request. */
  retries?: number;
  /** Passed through to the transport: a second address to try. */
  fallbackUrl?: string;
  /**
   * PairCreated logs read earlier, to be used instead of reading them again.
   * Which pools exist changes over days; what is in them changes every block.
   * Holding these separately is what lets the cheap half refresh often.
   */
  pairLogs?: RawLog[];
}

/**
 * Prices every hub in dollars, using USDG as the unit.
 *
 * USDG is a dollar by definition. WETH comes from the WETH/USDG pool. Every
 * other hub comes from its pool against WETH. No oracle, no price API — the
 * numbers come out of the same reserves the routing uses, so they cannot
 * disagree with it.
 */
export async function fetchHubPrices(io: Io = {}): Promise<Record<string, number>> {
  const out: Record<string, number> = { USDG: 1 };

  const others = HUBS.filter((h) => h.symbol !== 'USDG' && h.symbol !== 'WETH');
  const wanted = [
    { symbol: 'WETH', against: USDG, againstDecimals: USDG_DECIMALS, self: WETH, selfDecimals: 18 },
    ...others.map((h) => ({
      symbol: h.symbol,
      against: WETH,
      againstDecimals: 18,
      self: h.address,
      selfDecimals: h.decimals,
    })),
  ];

  const pairWords = await ethCallBatch(
    wanted.map((x) => ({
      to: V2_FACTORY,
      data: SEL_V2.getPair + addrWord(x.self) + addrWord(x.against),
    })),
    io,
  );
  const live = wanted
    .map((x, i) => ({ x, pair: pairWords[i] ? readAddress(pairWords[i]!) : null }))
    .filter((e): e is { x: (typeof wanted)[number]; pair: string } => !!e.pair && !/^0x0+$/.test(e.pair));

  const calls: Call[] = [];
  for (const e of live) {
    calls.push({ to: e.pair, data: SEL_V2.getReserves });
    calls.push({ to: e.pair, data: SEL_V2.token0 });
  }
  const answers = await ethCallBatch(calls, io);

  for (let i = 0; i < live.length; i++) {
    const { x } = live[i];
    const res = readReserves(answers[i * 2] ?? '');
    const t0 = answers[i * 2 + 1];
    if (!res || !t0) continue;
    const selfIsToken0 = readAddress(t0) === x.self.toLowerCase();
    const selfRes = Number(selfIsToken0 ? res[0] : res[1]) / 10 ** x.selfDecimals;
    const otherRes = Number(selfIsToken0 ? res[1] : res[0]) / 10 ** x.againstDecimals;
    if (!selfRes) continue;
    const otherUsd = x.against === USDG ? 1 : out['WETH'];
    if (otherUsd) out[x.symbol] = (otherRes / selfRes) * otherUsd;
  }
  return out;
}

/** WETH in dollars. Its own entry point because the page shows it. */
export async function fetchEthPrice(io: Io = {}): Promise<number | null> {
  return (await fetchHubPrices(io))['WETH'] ?? null;
}

const pairKey = (a: string, b: string) => [a, b].sort().join('-');
const hexBlock = (n: number) => '0x' + Math.max(0, n).toString(16);

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
}

export interface PairRecord {
  pair: string;
  /** The token on the other side of the hub. */
  other: string;
  block: number;
}

/**
 * Every pool a hub has, from the factory's own PairCreated events.
 *
 * This replaces walking allPairs(i) one index at a time. The event carries the
 * two tokens and the pool address together, so two requests give a hub's whole
 * list — tokens included — where the index walk needed three calls per pool and
 * could not tell which pools mattered until it had fetched them all.
 *
 * The hub can be either side of a pair (Uniswap orders the two tokens by
 * address), so both positions are asked for.
 */
/**
 * Every pool the factory has opened since a block, in one request.
 *
 * fetchHubPairs below asks per hub and per side, which is two requests each and
 * six in total. That was the largest thing this reader spent: a three-million
 * block log query costs several seconds and a visible slice of whatever budget
 * the public endpoint gives an address, and six of them in a row is what got
 * the routing endpoint answered with 429 and nothing else.
 *
 * The factory emits one event per pool with both tokens in its topics, so a
 * single unfiltered query returns the same information and the splitting by hub
 * happens here, for free. One request instead of six.
 */
export async function fetchAllPairs(fromBlock: number, io: Io = {}): Promise<RawLog[]> {
  return (
    (await rpc<RawLog[]>(
      'eth_getLogs',
      [
        {
          address: V2_FACTORY,
          topics: [PAIR_CREATED],
          fromBlock: hexBlock(fromBlock),
          toBlock: 'latest',
        },
      ],
      io,
    )) ?? []
  );
}

/** A hub's pools, picked out of the factory-wide log above. */
export function hubPairsFrom(logs: RawLog[], hub: Hub): PairRecord[] {
  const want = '0x' + hub.address.replace(/^0x/, '').padStart(64, '0');
  const out: PairRecord[] = [];
  for (const l of logs) {
    const hubIsToken0 = l.topics[1] === want;
    const hubIsToken1 = l.topics[2] === want;
    if (!hubIsToken0 && !hubIsToken1) continue;
    out.push({
      // data is (address pair, uint allPairsLength); the pair is the first word
      pair: readAddress(l.data.slice(0, 66)),
      other: readAddress(hubIsToken0 ? l.topics[2] : l.topics[1]),
      block: Number(BigInt(l.blockNumber)),
    });
  }
  return out.sort((a, b) => a.block - b.block);
}

export async function fetchHubPairs(
  hub: Hub,
  fromBlock: number,
  io: Io = {},
): Promise<PairRecord[]> {
  const topic = (a: string) => '0x' + a.replace(/^0x/, '').padStart(64, '0');
  const query = (topics: (string | null)[]) =>
    rpc<RawLog[]>(
      'eth_getLogs',
      [{ address: V2_FACTORY, topics, fromBlock: hexBlock(fromBlock), toBlock: 'latest' }],
      io,
    );

  const [asToken0, asToken1] = [
    await query([PAIR_CREATED, topic(hub.address)]),
    await query([PAIR_CREATED, null, topic(hub.address)]),
  ];

  const read = (logs: RawLog[], hubIsToken0: boolean): PairRecord[] =>
    (logs ?? []).map((l) => ({
      // data is (address pair, uint allPairsLength); the pair is the first word
      pair: readAddress(l.data.slice(0, 66)),
      other: readAddress(hubIsToken0 ? l.topics[2] : l.topics[1]),
      block: Number(BigInt(l.blockNumber)),
    }));

  return [...read(asToken0, true), ...read(asToken1, false)].sort((a, b) => a.block - b.block);
}

/**
 * Reads what is actually tradable on each hub.
 *
 * Per hub: take its newest pools, price the reserves, drop the empty ones, keep
 * the deepest few. Then join the hubs to each other, because without those
 * bridges the graph is a set of islands and there is nothing to route.
 */
export async function fetchLivePools(options: ScanOptions = {}): Promise<LiveSnapshot> {
  const perHubScan = options.perHubScan ?? 30;
  const minUsd = options.minUsd ?? 2_000;
  const perHub = options.perHub ?? 4;
  const windowBlocks = options.windowBlocks ?? LOG_WINDOW_BLOCKS;
  // Pacing has to travel with the transport options, not be dropped here: the
  // server reads the chain more slowly than a browser does, and for a while it
  // was asking for that politely and being ignored.
  const io: Io = {
    rpcUrl: options.rpcUrl,
    fetcher: options.fetcher,
    pauseMs: options.pauseMs,
    retries: options.retries,
    fallbackUrl: options.fallbackUrl,
  };

  const hubUsd = await fetchHubPrices(io);
  const headHex = await rpc<string>('eth_blockNumber', [], io);
  const head = Number(BigInt(headHex));
  const from = head - windowBlocks;

  // One log query for the whole factory, split by hub below. See fetchAllPairs.
  const allLogs = options.pairLogs ?? (await fetchAllPairs(from, io));

  type Found = { pair: string; hub: string; token: string; hubReserve: number; usd: number };
  const found: Found[] = [];
  let scanned = 0;

  for (const hub of HUBS) {
    const price = hubUsd[hub.symbol];
    if (!price) continue;
    // One hub failing is not a reason to show nothing. A snapshot missing a
    // hub is still true; an empty page claiming live data is not.
    let records: PairRecord[];
    let reserves: (string | null)[];
    let token0s: (string | null)[];
    try {
      records = hubPairsFrom(allLogs, hub).slice(-perHubScan);
      if (records.length === 0) continue;
      reserves = await ethCallBatch(
        records.map((r) => ({ to: r.pair, data: SEL_V2.getReserves })),
        io,
      );
      token0s = await ethCallBatch(
        records.map((r) => ({ to: r.pair, data: SEL_V2.token0 })),
        io,
      );
    } catch {
      continue;
    }
    scanned += records.length;

    const priced: Found[] = [];
    for (let i = 0; i < records.length; i++) {
      const res = readReserves(reserves[i] ?? '');
      const t0 = token0s[i];
      if (!res || !t0) continue;
      const hubIsToken0 = readAddress(t0) === hub.address;
      const hubReserve = Number(hubIsToken0 ? res[0] : res[1]) / 10 ** hub.decimals;
      const usd = hubReserve * price * 2;
      if (usd < minUsd) continue;
      priced.push({ pair: records[i].pair, hub: hub.symbol, token: records[i].other, hubReserve, usd });
    }
    priced.sort((a, b) => b.usd - a.usd);
    found.push(...priced.slice(0, perHub));
  }

  // The bridges. Asked for by address rather than by event, because the pools
  // joining two hubs are old and may sit outside the event window.
  const links: Array<{ a: Hub; b: Hub }> = [];
  for (let i = 0; i < HUBS.length; i++) {
    for (let j = i + 1; j < HUBS.length; j++) links.push({ a: HUBS[i], b: HUBS[j] });
  }
  const linkWords = await ethCallBatch(
    links.map((l) => ({
      to: V2_FACTORY,
      data: SEL_V2.getPair + addrWord(l.a.address) + addrWord(l.b.address),
    })),
    io,
  );
  const linkPairs = links
    .map((l, i) => ({ l, pair: linkWords[i] ? readAddress(linkWords[i]!) : null }))
    .filter((x): x is { l: { a: Hub; b: Hub }; pair: string } => !!x.pair && !/^0x0+$/.test(x.pair));

  const linkCalls: Call[] = [];
  for (const x of linkPairs) {
    linkCalls.push({ to: x.pair, data: SEL_V2.getReserves });
    linkCalls.push({ to: x.pair, data: SEL_V2.token0 });
  }
  const linkAnswers = await ethCallBatch(linkCalls, io);

  const already = new Set(found.map((f) => pairKey(f.hub, f.token)));
  const joins: Found[] = [];
  for (let i = 0; i < linkPairs.length; i++) {
    const res = readReserves(linkAnswers[i * 2] ?? '');
    const t0 = linkAnswers[i * 2 + 1];
    if (!res || !t0) continue;
    const { a, b } = linkPairs[i].l;
    const aIsToken0 = readAddress(t0) === a.address;
    const aRes = Number(aIsToken0 ? res[0] : res[1]) / 10 ** a.decimals;
    const price = hubUsd[a.symbol];
    if (!price || !aRes) continue;
    const usd = aRes * price * 2;
    if (usd < minUsd) continue;
    if (already.has(pairKey(a.symbol, b.address))) continue;
    joins.push({ pair: linkPairs[i].pair, hub: a.symbol, token: b.address, hubReserve: aRes, usd });
  }

  // Bridges first, so the hubs exist as nodes before anything hangs off them.
  const all = [...joins, ...found];
  const hubSymbolOf = new Map(HUBS.map((h) => [h.address, h.symbol]));
  const unknown = all.filter((f) => !hubSymbolOf.has(f.token));
  const symbols = await ethCallBatch(
    unknown.map((f) => ({ to: f.token, data: SEL_V2.symbol })),
    io,
  );
  const symbolOf = new Map<string, string>();
  unknown.forEach((f, i) => {
    symbolOf.set(f.token, readString(symbols[i] ?? '') ?? f.token.slice(2, 8).toUpperCase());
  });

  const pools: LivePool[] = all.map((f) => ({
    pair: f.pair,
    hub: f.hub,
    token: f.token,
    symbol: hubSymbolOf.get(f.token) ?? symbolOf.get(f.token) ?? '?',
    hubReserve: f.hubReserve,
    liquidityUsd: f.usd,
  }));

  // The same pairs, asked of Uniswap V3. A pair may have a concentrated pool
  // that is far cheaper than the constant-product one, or none at all.
  const hubByName = new Map(HUBS.map((h) => [h.symbol, h]));
  const decimalsOf = new Map<string, number>();
  for (const h of HUBS) decimalsOf.set(h.address, h.decimals);

  const amountInOf = (tokenIn: string, sizeUsd: number): bigint => {
    const hub = HUBS.find((h) => h.address === tokenIn);
    const price = hub ? hubUsd[hub.symbol] : undefined;
    const decimals = hub?.decimals ?? 18;
    if (!price || !(price > 0)) return 0n;
    const units = (sizeUsd / price) * 10 ** decimals;
    return BigInt(Math.max(1, Math.round(units)));
  };

  const v3: Record<string, V3Cost> = {};
  try {
    const wanted = pools
      .map((p) => ({ tokenIn: hubByName.get(p.hub)?.address ?? '', tokenOut: p.token }))
      .filter((p) => p.tokenIn && p.tokenOut && p.tokenIn !== p.tokenOut);
    if (wanted.length > 0) {
      const v3pools = await findV3Pools(wanted, io);
      const quotes = await quoteV3(v3pools, amountInOf, TRADE_SIZES_USD, io);
      for (const [key, q] of cheapestPerPair(quotes, TRADE_SIZES_USD[1])) v3[key] = q;
      // keep every tier's ladder, not only the cheapest at one size
      for (const q of quotes) {
        const key = `${q.tokenIn}>${q.tokenOut}`;
        const cur = v3[key];
        if (!cur) v3[key] = q;
      }
    }
  } catch {
    // V3 is an improvement on the estimate, not a requirement for the page.
  }

  return { pools, hubUsd, v3, blockNumber: head, scanned, pairLogs: allLogs };
}

/**
 * Live pools in the shape the solver eats.
 *
 * Symbols are made unique before they become graph nodes: two freshly launched
 * tokens sharing a ticker is normal, and silently merging them into one node
 * would invent a route that does not exist.
 */
export function toPools(
  snapshot: LiveSnapshot,
  tradeSizeUsd: number = TRADE_SIZES_USD[1],
): import('./pools.ts').Pool[] {
  const used = new Map<string, string>();
  const label = (token: string, symbol: string) => {
    const existing = used.get(token);
    if (existing) return existing;
    const taken = new Set(used.values());
    let name = symbol;
    let n = 2;
    while (taken.has(name)) name = `${symbol} (${n++})`;
    used.set(token, name);
    return name;
  };
  const hubAddress = new Map(HUBS.map((h) => [h.symbol, h.address]));

  return snapshot.pools.map((p) => {
    const hubAddr = hubAddress.get(p.hub) ?? p.hub;
    const base: import('./pools.ts').Pool = {
      tokenA: label(hubAddr, p.hub),
      tokenB: label(p.token, p.symbol),
      feeBps: V2_FEE_BPS,
      liquidityUsd: p.liquidityUsd,
      venue: 'v2',
    };

    // If a concentrated pool quotes the same hop cheaper, route through it and
    // say so. The comparison is like for like: both numbers are the fraction of
    // the trade lost, at this trade size.
    const quote = snapshot.v3[`${hubAddr}>${p.token}`];
    const quoted = quote?.costBySize[tradeSizeUsd];
    if (quoted === undefined) return base;

    const v2Cost = poolCost(base, { tradeSizeUsd });
    if (quoted >= v2Cost) return base;

    return { ...base, cost: quoted, venue: 'v3', feeTier: quote.fee };
  });
}
