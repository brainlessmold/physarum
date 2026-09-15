/**
 * The routing endpoint.
 *
 * This file is not the one that gets deployed. Vercel compiles each file in
 * api/ on its own and does not carry anything it imports from src/ along with
 * it, so a function written there dies on first call with
 *   Cannot find module '/var/task/src/core/chain.ts'
 * Instead this is bundled into api/route.js at build time — one file, no
 * imports left to resolve. See scripts/build-api.mjs.
 *
 * Everything else on this site shows the organism solving. This lets something
 * else ask it. Give it two tokens and a trade size and it reads the chain, runs
 * the model until the network stops changing, and answers with the route that
 * survived.
 *
 *     /api/route?from=WETH&to=USDG&size=10000
 *
 * Two things are deliberate.
 *
 * The answer carries Dijkstra's result next to the mould's, and a flag saying
 * whether they agree. The model is proven to converge on the shortest path, so
 * a disagreement means this endpoint is wrong — and it says so itself rather
 * than waiting to be caught.
 *
 * The chain's endpoint gives each caller a budget, and a full read used to
 * spend more than one. Six of the requests were log queries three million
 * blocks wide — two per hub — and they are now one query for the whole factory,
 * split by hub here. What is left is cached in two halves: which pools exist
 * changes over days, what is in them changes every block, so the expensive half
 * is held for an hour and the cheap half for a minute.
 *
 * There is also a spare route. The pass-through in api/rpc.ts calls from a
 * different address and therefore has its own budget; whichever has been leaned
 * on recently is the one that refuses, which was measured in both directions an
 * hour apart. Direct is tried first and that is the fallback.
 *
 * And the pool snapshot is held between calls rather than read per request.
 * Reading every pool is a few dozen round trips to the chain, and the public
 * RPC throttles this address hard enough that doing it per request simply does
 * not work. The age of the snapshot is in every answer, so nobody has to take
 * its freshness on trust.
 */
// Deliberately NOT an edge function. Edge rejects any module specifier ending
// in .ts anywhere in the graph, and this project writes them everywhere because
// the test suite runs straight from source through node's type stripping, which
// requires them. The node runtime bundles with esbuild, which resolves both
// spellings. Web Request and Response work here just the same.
// Named rather than namespace imports: the bundler in scripts/build-api.mjs
// flattens these modules into one file, and a flattened module has no object
// to hang a namespace off.
import { fetchLivePools, toPools, RPC_URL, type LiveSnapshot } from '../src/core/chain.ts';
import { planRoute } from '../src/core/route.ts';

/**
 * How long a snapshot is served before the chain is read again.
 *
 * Seconds was the wrong number. Reading every pool is a few dozen round trips,
 * and the public RPC throttles this address far harder than it throttles a
 * visitor's browser — the first deploy answered `rpc 429` and nothing else. So
 * the snapshot is held for minutes, its exact age is in every answer, and
 * anyone who needs the current block can read it off the response and go check.
 */
const MAX_AGE_MS = 60_000;
/** Which pools exist. Days, not blocks — so this is held far longer. */
const PAIRS_MAX_AGE_MS = 3_600_000;
let cached: { at: number; snapshot: LiveSnapshot } | null = null;
let pairs: { at: number; logs: LiveSnapshot['pairLogs'] } | null = null;
/** Two requests arriving together must not both go and read the chain — that
 *  burst is precisely what gets throttled. They share one read instead. */
let inFlight: Promise<LiveSnapshot> | null = null;

async function snapshot(
  origin: string,
): Promise<{ snapshot: LiveSnapshot; ageMs: number; stale: boolean }> {
  const now = Date.now();
  if (cached && now - cached.at < MAX_AGE_MS) {
    return { snapshot: cached.snapshot, ageMs: now - cached.at, stale: false };
  }
  // Reuse the pool list while it is still young; only its contents are re-read.
  const reuse = pairs && now - pairs.at < PAIRS_MAX_AGE_MS ? pairs.logs : undefined;
  if (!inFlight) {
    inFlight = fetchLivePools({
      rpcUrl: RPC_URL,
      fallbackUrl: `${origin}/api/rpc`,
      pauseMs: 250,
      pairLogs: reuse,
    }).finally(() => {
      inFlight = null;
    });
  }
  try {
    const fresh = await inFlight;
    cached = { at: Date.now(), snapshot: fresh };
    if (!reuse) pairs = { at: Date.now(), logs: fresh.pairLogs };
    return { snapshot: fresh, ageMs: 0, stale: false };
  } catch (err) {
    // A refusal now is not a reason to have nothing to say. The last good
    // snapshot is returned with its real age and marked stale.
    if (cached) return { snapshot: cached.snapshot, ageMs: Date.now() - cached.at, stale: true };
    throw err;
  }
}

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

interface Answer {
  status: number;
  body: unknown;
}
const json = (body: unknown, status = 200): Answer => ({ status, body });

/** The node runtime's response object, as much of it as is used here. */
interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk: string): void;
}

/**
 * Two calling conventions.
 *
 * Vercel hands a function either a Web Request and expects a Response back, or
 * a node request and response pair. Which one depends on the runtime and on the
 * project, and guessing wrong fails the call instantly with nothing useful in
 * the log. So this answers to both: the work happens once, and only the last
 * step differs.
 */
export default async function handler(
  req: Request | { url?: string; headers?: Record<string, string | string[] | undefined> },
  res?: NodeResponse,
): Promise<Response | void> {
  let answer: Answer;
  try {
    answer = await respond(req);
  } catch (err) {
    // Whatever went wrong, say what it was. A bare 500 tells the caller nothing
    // and tells us less.
    const message = err instanceof Error ? err.message : String(err);
    answer = { status: 500, body: { error: 'the endpoint failed', detail: message } };
  }
  if (res && typeof res.end === 'function') {
    res.statusCode = answer.status;
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    res.end(JSON.stringify(answer.body, null, 2));
    return;
  }
  return new Response(JSON.stringify(answer.body, null, 2), {
    status: answer.status,
    headers: HEADERS,
  });
}

function requestUrl(req: { url?: string; headers?: Record<string, unknown> }): URL {
  const raw = typeof req.url === 'string' ? req.url : '/';
  if (/^https?:\/\//.test(raw)) return new URL(raw);
  const host = (req.headers as Record<string, string> | undefined)?.host ?? 'localhost';
  return new URL(raw, `https://${host}`);
}

/**
 * What the chain will and will not answer from inside this function.
 *
 * The first deploy answered `rpc 429` and nothing else, while the very same
 * requests — one call, a batch of forty, a three-million-block log query — all
 * returned 200 when sent from the edge function next door and from a browser.
 * So the refusal is specific to this function's egress, and guessing which
 * request crosses the line is worse than asking. `?probe=1` sends the three
 * shapes one at a time and reports what came back.
 */
async function probe(origin: string): Promise<Answer> {
  const attempt = async (label: string, url: string, body: unknown) => {
    const began = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { label, status: res.status, ms: Date.now() - began, body: text.slice(0, 160) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { label, status: null, ms: Date.now() - began, body: `threw: ${detail}` };
    }
  };

  const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const single = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] };
  const batch = Array.from({ length: 40 }, (_, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_call',
    params: [{ to: WETH, data: '0x313ce567' }, 'latest'],
  }));

  const edge = `${origin}/api/rpc`;
  const head = await attempt('direct: eth_blockNumber', RPC_URL, single);
  const forty = await attempt('direct: batch of 40 eth_call', RPC_URL, batch);
  const viaEdge = await attempt('through /api/rpc: eth_blockNumber', edge, single);
  const viaEdgeBatch = await attempt('through /api/rpc: batch of 40 eth_call', edge, batch);

  let logs: unknown = { label: 'through /api/rpc: eth_getLogs over 3M blocks', skipped: 'no head to count back from' };
  try {
    const parsed = JSON.parse(viaEdge.body) as { result?: string };
    if (parsed.result) {
      const from = Number(BigInt(parsed.result)) - 3_000_000;
      logs = await attempt('through /api/rpc: eth_getLogs over 3M blocks', edge, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [
          {
            address: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
            topics: [
              '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
              '0x' + WETH.slice(2).padStart(64, '0'),
            ],
            fromBlock: '0x' + from.toString(16),
            toBlock: 'latest',
          },
        ],
      });
    }
  } catch {
    /* head.body was not json; the skipped note above stands */
  }

  return json({
    probe: 'sent from inside this function, one request at a time, no retries',
    results: [head, forty, viaEdge, viaEdgeBatch, logs],
  });
}

async function respond(
  req: Request | { url?: string; headers?: Record<string, string | string[] | undefined> },
): Promise<Answer> {
  const url = requestUrl(req as { url?: string; headers?: Record<string, unknown> });
  if (url.searchParams.get('probe')) return probe(url.origin);
  const size = Number(url.searchParams.get('size') ?? 10_000);
  if (!isFinite(size) || size <= 0) {
    return json({ error: 'size must be a positive number of dollars' }, 400);
  }

  let snap: LiveSnapshot;
  let ageMs: number;
  let stale: boolean;
  try {
    ({ snapshot: snap, ageMs, stale } = await snapshot(url.origin));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return json({ error: 'the chain did not answer', detail }, 502);
  }

  const pools = toPools(snap, size);
  if (pools.length < 2) return json({ error: 'no pools were readable just now' }, 502);

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to) {
    const tokens = [...new Set(pools.flatMap((p) => [p.tokenA, p.tokenB]))];
    return json({
      usage: '/api/route?from=WETH&to=USDG&size=10000',
      block: snap.blockNumber,
      tokens,
      note: 'Symbols as they appear on the chain. Two tokens may share one; they are kept apart by address.',
    });
  }

  const plan = planRoute(pools, from, to, size);
  if ('error' in plan) return json({ ...plan, from, to }, 400);

  return json({
    from,
    to,
    tradeSizeUsd: size,
    block: snap.blockNumber,
    snapshotAgeMs: ageMs,
    snapshotStale: stale,
    ...plan,
    disclaimer:
      'A quote is true for its block and nothing more. Re-check against the pool before swapping.',
  });
}
