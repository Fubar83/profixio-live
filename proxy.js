// Same-origin relay to Profixio, shared by the Cloudflare Worker (worker.js) and the local dev
// server (server.js). Profixio sends no CORS headers, so the browser can't fetch it directly.
//
//   GET/POST /proxy/<path>?<query>  ->  https://www.profixio.com/app/<path>?<query>
//
// Only the few paths the app uses are allowed, so this is not an open proxy. Profixio's session
// cookie (needed for Livewire's loadMore) is tunnelled through the X-Profixio-Cookie request header
// and the X-Profixio-Set-Cookie response header, because the browser won't hand a third-party
// cookie to this origin.

const UPSTREAM = 'https://www.profixio.com/app/';
const ALLOWED = [
  ['GET', /^lx\/match\/\d+$/],
  ['GET', /^lx\/competition\/leagueid\d+\/teams\/\d+$/],
  ['GET', /^api\/matches\/live-state$/],
  ['GET', /^api\/time$/],
  ['POST', /^livewire\/update$/],
];
const FORWARD_HEADERS = ['content-type', 'x-livewire', 'x-csrf-token'];

export async function handleProxy(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/proxy/')) return null;

  const path = url.pathname.slice('/proxy/'.length);
  if (!ALLOWED.some(([method, re]) => method === request.method && re.test(path))) {
    return new Response('Not allowed', { status: 403 });
  }

  const headers = new Headers({ 'User-Agent': 'Mozilla/5.0 (profixio-live helper)', 'Accept-Language': 'sv,en;q=0.8' });
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cookie = request.headers.get('x-profixio-cookie');
  if (cookie) headers.set('Cookie', cookie);
  const referer = request.headers.get('x-profixio-referer');
  if (referer?.startsWith(UPSTREAM)) headers.set('Referer', referer);

  const upstream = await fetch(UPSTREAM + path + url.search, {
    method: request.method,
    headers,
    body: request.method === 'POST' ? await request.text() : undefined,
    redirect: 'follow',
  });

  const out = new Headers({
    'Content-Type': upstream.headers.get('content-type') || 'text/plain',
    'Cache-Control': 'no-store',
  });
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length) out.set('X-Profixio-Set-Cookie', setCookies.map((c) => c.split(';')[0]).join('; '));
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
