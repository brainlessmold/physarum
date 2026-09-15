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
 * And the pool snapshot is held for a few seconds between calls. Reading every
 * pool takes a dozen round trips to the chain, and doing that per request would
 * make the endpoint unusable. The age of the snapshot is in every answer, so
 * nobody has to take its freshness on trust.
 */
// Deliberately NOT an edge function. Edge rejects any module specifier ending
// in .ts anywhere in the graph, and this project writes them everywhere because
// the test suite runs straight from source through node's type stripping, which
// requires them. The node runtime bundles with esbuild, which resolves both
// spellings. Web Request and Response work here just the same.
import * as chain from '../src/core/chain.ts';
import * as route from '../src/core/route.ts';
import type { LiveSnapshot } from '../src/core/chain.ts';

const MAX_AGE_MS = 8_000;
let cached: { at: number; snapshot: LiveSnapshot } | null = null;

async function snapshot(): Promise<{ snapshot: LiveSnapshot; ageMs: number }> {
  const now = Date.now();
  if (cached && now - cached.at < MAX_AGE_MS) {
    return { snapshot: cached.snapshot, ageMs: now - cached.at };
  }
  // Server side there is no CORS to work around, so the chain is read directly.
  const fresh = await chain.fetchLivePools({ rpcUrl: chain.RPC_URL });
  cached = { at: now, snapshot: fresh };
  return { snapshot: fresh, ageMs: 0 };
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

async function respond(
  req: Request | { url?: string; headers?: Record<string, string | string[] | undefined> },
): Promise<Answer> {
  const url = requestUrl(req as { url?: string; headers?: Record<string, unknown> });
  const size = Number(url.searchParams.get('size') ?? 10_000);
  if (!isFinite(size) || size <= 0) {
    return json({ error: 'size must be a positive number of dollars' }, 400);
  }

  let snap: LiveSnapshot;
  let ageMs: number;
  try {
    ({ snapshot: snap, ageMs } = await snapshot());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return json({ error: 'the chain did not answer', detail }, 502);
  }

  const pools = chain.toPools(snap, size);
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

  const plan = route.planRoute(pools, from, to, size);
  if ('error' in plan) return json({ ...plan, from, to }, 400);

  return json({
    from,
    to,
    tradeSizeUsd: size,
    block: snap.blockNumber,
    snapshotAgeMs: ageMs,
    ...plan,
    disclaimer:
      'A quote is true for its block and nothing more. Re-check against the pool before swapping.',
  });
}
