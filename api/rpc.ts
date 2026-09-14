/**
 * A pass-through to the Robinhood Chain RPC.
 *
 * Why this exists: the public endpoint sometimes answers with the
 * Access-Control-Allow-Origin header set twice — literally "*,*" — and every
 * browser rejects that outright. It is intermittent, so the page reaches the
 * chain directly and only falls back here when the browser refuses the answer.
 *
 * This forwards the request body untouched and returns the answer untouched.
 * Nothing is cached, rewritten, precomputed or stored. The only thing it adds
 * is a CORS header the browser will accept.
 */
export const config = { runtime: 'edge' };

const UPSTREAM = 'https://rpc.mainnet.chain.robinhood.com';

/** Read-only methods. Nothing that could sign, send or change state. */
const ALLOWED = new Set([
  'eth_call',
  'eth_getLogs',
  'eth_blockNumber',
  'eth_chainId',
  'eth_getBlockByNumber',
  'net_version',
]);

function permitted(body: unknown): boolean {
  const one = (m: unknown) => typeof m === 'string' && ALLOWED.has(m);
  if (Array.isArray(body)) {
    return body.length > 0 && body.length <= 64 && body.every((c) => one((c as { method?: unknown })?.method));
  }
  return one((body as { method?: unknown })?.method);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  if (req.method !== 'POST') {
    return new Response('POST only', { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }
  if (!permitted(body)) {
    return new Response(JSON.stringify({ error: 'only read-only calls are forwarded' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}
