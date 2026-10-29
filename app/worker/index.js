import { GameService } from '../server/service.js';
import { D1Store } from '../server/stores.js';
import { createApi } from '../server/api.js';
import { assetResponse, jsonResponse } from '../server/headers.js';

// Build embeds the static assets so the deployment is a single portable Worker.
const assets = __PUBLIC_ASSETS__;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/config') return jsonResponse({ transport: 'polling', pollInterval: 1000 });
    if (path === '/health') return jsonResponse({ ok: true, service: 'fourward', transport: 'polling' });
    if (path.startsWith('/api/')) {
      if (!env.DB) return jsonResponse({ error: { code: 'UNAVAILABLE', message: 'The game service is temporarily unavailable. Please try again.' } }, 503);
      return createApi(new GameService(new D1Store(env.DB)))(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    const content = assets[path];
    if (content === undefined) return new Response('Page not found', { status: 404 });
    return assetResponse(path, request.method === 'HEAD' ? null : content);
  },
};
