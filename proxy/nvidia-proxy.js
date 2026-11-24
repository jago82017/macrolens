// Macrolens -> NVIDIA API proxy (Cloudflare Worker, free plan).
//
// NVIDIA's API (integrate.api.nvidia.com) doesn't send CORS headers, so a web app can't call it
// from the browser. This Worker forwards /v1/* requests to NVIDIA and adds CORS headers.
//
// Streaming requests get an immediate response with a keep-alive comment every 10 s while NVIDIA's
// queue is busy (big free-tier models like Kimi can take minutes to start). Without that, Cloudflare
// cuts the request off after ~100 s with error 524. Upstream errors are sent as an SSE error event.
//
// Settings (Worker -> Settings -> Variables and Secrets):
//   NVIDIA_API_KEY   (Secret, recommended)  your nvapi- key. Then leave the key blank in the app.
//   ALLOWED_ORIGINS  (Text, recommended)    comma-separated sites allowed to use this proxy, e.g.
//                                           https://yourname.github.io,http://localhost:8080
//                                           (origin only: no path, no trailing slash)
// If ALLOWED_ORIGINS is unset, any site can use the proxy - only do that if the key is NOT stored here.

const UPSTREAM = 'https://integrate.api.nvidia.com';
const KEEPALIVE_MS = 10000;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    const originOk = allowed.includes('*') || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin || '*' : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!originOk) return new Response(JSON.stringify({ error: `Origin ${origin || '(none)'} is not in ALLOWED_ORIGINS` }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('Macrolens NVIDIA proxy is running (v2, keep-alive). Use this URL in the app: Profile > AI.', { headers: { ...cors, 'Content-Type': 'text/plain' } });
    }
    if (!url.pathname.startsWith('/v1/') || !['GET', 'POST'].includes(request.method)) {
      return new Response('Not found', { status: 404, headers: cors });
    }

    // A key sent by the app wins; otherwise use the Worker secret.
    const auth = request.headers.get('Authorization') || (env.NVIDIA_API_KEY ? `Bearer ${env.NVIDIA_API_KEY}` : '');
    const headers = { Accept: request.headers.get('Accept') || 'application/json' };
    if (auth) headers.Authorization = auth;
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let streaming = false;
    try { streaming = body !== undefined && JSON.parse(body).stream === true; } catch { /* not JSON */ }

    const upstreamReq = fetch(UPSTREAM + url.pathname + url.search, { method: request.method, headers, body });

    if (!streaming) {
      const upstream = await upstreamReq;
      const out = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(cors)) out.set(k, v);
      out.delete('content-encoding');
      out.delete('content-length');
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    // Streaming: answer right away and keep the connection alive while NVIDIA queues the request.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = text => writer.write(enc.encode(text)).catch(() => {});
    const pump = (async () => {
      await send(': connected\n\n');
      const ping = setInterval(() => send(': waiting for model\n\n'), KEEPALIVE_MS);
      try {
        const upstream = await upstreamReq;
        clearInterval(ping);
        if (!upstream.ok) {
          const text = await upstream.text();
          await send(`data: ${JSON.stringify({ error: { status: upstream.status, message: text.slice(0, 500) } })}\n\n`);
          return;
        }
        const reader = upstream.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } catch (e) {
        clearInterval(ping);
        await send(`data: ${JSON.stringify({ error: { status: 502, message: String(e && e.message || e) } })}\n\n`);
      } finally {
        await writer.close().catch(() => {});
      }
    })();
    ctx.waitUntil(pump);
    return new Response(readable, { status: 200, headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  },
};
