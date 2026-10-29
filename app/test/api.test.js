import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../server/api.js';
import { GameService } from '../server/service.js';
import { MemoryStore } from '../server/stores.js';

function apiFixture() {
  const service = new GameService(new MemoryStore());
  const handle = createApi(service);
  return {
    service,
    handle,
    request(path, { method = 'GET', data, token, headers = {}, raw } = {}) {
      return handle(new Request(`https://fourward.test${path}`, {
        method,
        headers: { ...(data === undefined && raw === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        ...(data === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(data) }),
      }));
    },
  };
}

test('HTTP create → join → move → read produces the same authoritative state', async () => {
  const api = apiFixture();
  const created = await api.request('/api/rooms', { method: 'POST', data: { name: 'Alice' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('x-content-type-options'), 'nosniff');
  const a = await created.json();
  const joined = await api.request(`/api/rooms/${a.code}/join`, { method: 'POST', data: { name: 'Bob' } });
  assert.equal(joined.status, 200);
  const b = await joined.json();
  const moved = await api.request(`/api/rooms/${a.code}/action`, { method: 'POST', token: a.token,
    data: { type: 'move', column: 3, revision: b.state.revision } });
  assert.equal(moved.status, 200);
  const { state } = await moved.json();
  const read = await api.request(`/api/rooms/${a.code}`, { token: b.token });
  assert.equal(read.status, 200);
  const { expiresAt: readExpiry, ...readState } = (await read.json()).state;
  const { expiresAt: moveExpiry, ...movedState } = state;
  assert.deepEqual(readState, movedState);
  assert.ok(readExpiry >= moveExpiry);
  assert.ok(readState.players.every(player => player?.online));
  assert.equal(state.board[5][3], 1);
  assert.equal(state.turn, 2);
});

test('HTTP errors preserve useful status and machine-readable error codes', async () => {
  const api = apiFixture();
  const a = await api.service.create('Alice');
  const missingAuth = await api.request(`/api/rooms/${a.code}`);
  assert.equal(missingAuth.status, 401);
  assert.equal((await missingAuth.json()).error.code, 'UNAUTHORIZED');
  const missingRoom = await api.request('/api/rooms/ABCDEF', { token: a.token });
  assert.equal(missingRoom.status, 404);
  const wrongMethod = await api.request(`/api/rooms/${a.code}/join`);
  assert.equal(wrongMethod.status, 405);
  const missingRoute = await api.request('/api/unknown');
  assert.equal(missingRoute.status, 404);
});

test('cross-origin and browser cross-site API requests are rejected', async () => {
  const api = apiFixture();
  for (const headers of [{ origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await api.request('/api/rooms', { method: 'POST', data: { name: 'Alice' }, headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'FORBIDDEN_ORIGIN');
  }
  const sameOrigin = await api.request('/api/rooms', { method: 'POST', data: { name: 'Alice' }, headers: { origin: 'https://fourward.test' } });
  assert.equal(sameOrigin.status, 201);
});

test('non-JSON, malformed JSON, arrays, and oversized request bodies are bounded', async () => {
  const api = apiFixture();
  const nonJson = await api.request('/api/rooms', { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(nonJson.status, 415);
  for (const raw of ['{oops', '[]', 'null']) {
    const response = await api.request('/api/rooms', { method: 'POST', raw });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_BODY');
  }
  // Deliberately omit Content-Length to exercise the streaming byte limit.
  const oversized = await api.request('/api/rooms', { method: 'POST', raw: JSON.stringify({ name: 'A'.repeat(3000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'BODY_TOO_LARGE');
});

test('invalid or stale mutations return JSON errors and cannot alter the board', async () => {
  const api = apiFixture();
  const a = await api.service.create('Alice');
  const b = await api.service.join(a.code, 'Bob');
  const response = await api.request(`/api/rooms/${a.code}/action`, { method: 'POST', token: a.token,
    data: { type: 'move', column: 2, revision: b.state.revision - 1 } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'STALE_STATE');
  assert.equal((await api.service.state(a.code, a.token)).state.moveCount, 0);
});

test('health is cache-disabled and non-API requests pass through to the site', async () => {
  const api = apiFixture();
  const health = await api.request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(await api.handle(new Request('https://fourward.test/styles.css')), null);
});
