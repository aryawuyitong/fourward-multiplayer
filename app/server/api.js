import { GameError } from './game.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function body(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new GameError('INVALID_BODY', 'Send a JSON request.', 415);
  if (Number(request.headers.get('content-length') ?? 0) > 2048) throw new GameError('BODY_TOO_LARGE', 'Request is too large.', 413);
  if (!request.body) throw new GameError('INVALID_BODY', 'Send a valid JSON object.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new GameError('BODY_TOO_LARGE', 'Request is too large.', 413); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GameError('INVALID_BODY', 'Send a valid JSON object.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GameError('INVALID_BODY', 'Send a valid JSON object.');
  return data;
}

function token(request) {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function createApi(service) {
  return async function handleApi(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return null;
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw new GameError('FORBIDDEN_ORIGIN', 'Open the game from its original website.', 403);
      if (request.headers.get('sec-fetch-site') === 'cross-site') throw new GameError('FORBIDDEN_ORIGIN', 'Open the game from its original website.', 403);
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
      if (url.pathname === '/api/rooms' && request.method === 'POST') return json(await service.create((await body(request)).name), 201);
      const route = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|action))?$/);
      if (!route) throw new GameError('NOT_FOUND', 'Endpoint not found.', 404);
      const [, code, operation] = route;
      if (!operation && request.method === 'GET') return json(await service.state(code, token(request)));
      if (operation === 'join' && request.method === 'POST') return json(await service.join(code, (await body(request)).name));
      if (operation === 'action' && request.method === 'POST') return json(await service.action(code, token(request), await body(request)));
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'This method is not supported.' } }, 405);
    } catch (error) {
      if (error instanceof GameError) return json({ error: { code: error.code, message: error.message } }, error.status);
      console.error('Fourward API request failed:', error?.name ?? 'UnknownError');
      return json({ error: { code: 'SERVER_ERROR', message: 'The server could not complete this request. Please try again.' } }, 500);
    }
  };
}
