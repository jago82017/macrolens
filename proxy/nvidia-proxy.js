// Macrolens → NVIDIA API proxy (Cloudflare Worker, free plan).
//
// NVIDIA's API (integrate.api.nvidia.com) doesn't send CORS headers, so a web app can't call it
// from the browser. This Worker forwards /v1/* requests to NVIDIA and adds CORS headers, streaming
// responses straight through.
//
// Settings (Worker → Settings → Variables and Secrets):
//   NVIDIA_API_KEY   (Secret, recommended)  your nvapi-… key. Then leave the key blank in the app.
//   ALLOWED_ORIGINS  (Text, recommended)    comma-separated sites allowed to use this proxy, e.g.
//                                           https://yourname.github.io,http://localhost:8080
//                                           (origin only: no path, no trailing slash)
// If ALLOWED_ORIGINS is unset, any site can use the proxy — only do that if the key is NOT stored here.

const UPSTREAM = 'https://integrate.api.nvidia.com';

export default {
  async fetch(request, env) {
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
      return new Response('Macrolens NVIDIA proxy is running. Use this URL in the app (Profile → AI).', { headers: { ...cors, 'Content-Type': 'text/plain' } });
    }
    if (!url.pathname.startsWith('/v1/') || !['GET', 'POST'].includes(request.method)) {
      return new Response('Not found', { status: 404, headers: cors });
    }

    // A key sent by the app wins; otherwise use the Worker secret.
    const auth = request.headers.get('Authorization') || (env.NVIDIA_API_KEY ? `Bearer ${env.NVIDIA_API_KEY}` : '');
    const headers = { Accept: request.headers.get('Accept') || 'application/json' };
    if (auth) headers.Authorization = auth;
    if (request.method === 'POST') headers['Content-Type'] = 'application/json';

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : undefined,
    });

    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    out.delete('content-encoding'); // body is already decoded by fetch
    out.delete('content-length');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
