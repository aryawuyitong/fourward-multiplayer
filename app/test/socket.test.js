import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';

async function serverFixture(t) {
  const app = createGameServer();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await app.close();
  });
  const address = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    app,
    origin,
    async request(path, data, token) {
      const response = await fetch(origin + path, { method: data ? 'POST' : 'GET',
        headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
    async socket() {
      const socket = connect(origin, { forceNew: true, reconnection: false, transports: ['websocket'] });
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
      });
      return socket;
    },
  };
}

function waitState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', listener);
      reject(new Error('Expected room update was not broadcast'));
    }, 3000);
    function listener(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off('state', listener);
      resolve(state);
    }
    socket.on('state', listener);
  });
}

function assertSameGame(actual, expected) {
  // Each authenticated read is also a heartbeat. Room expiry is refreshed
  // between reads, while the authoritative game revision and board stay equal.
  const { expiresAt: actualExpiry, ...actualGame } = actual;
  const { expiresAt: expectedExpiry, ...expectedGame } = expected;
  assert.deepEqual(actualGame, expectedGame);
  assert.ok(Number.isFinite(actualExpiry) && Number.isFinite(expectedExpiry));
  assert.ok(actual.players.every(player => player?.online));
}

test('two independent Socket.IO clients receive identical boards through a complete win and rematch', { timeout: 15000 }, async t => {
  const fixture = await serverFixture(t);
  const { body: a, status } = await fixture.request('/api/rooms', { name: 'Alice' });
  assert.equal(status, 201);
  const { body: b } = await fixture.request(`/api/rooms/${a.code}/join`, { name: 'Bob' });
  const socketA = await fixture.socket();
  const socketB = await fixture.socket();
  const subA = await socketA.timeout(3000).emitWithAck('subscribe', { code: a.code, token: a.token });
  const subB = await socketB.timeout(3000).emitWithAck('subscribe', { code: b.code, token: b.token });
  assertSameGame(subA.state, subB.state);
  assert.ok(subB.state.expiresAt >= subA.state.expiresAt);
  let state = subA.state;
  for (const column of [0, 0, 1, 1, 2, 2, 3]) {
    const revision = state.revision + 1;
    const updates = Promise.all([socketA, socketB].map(socket => waitState(socket, view => view.revision === revision)));
    const seat = [a, b][state.turn - 1];
    const result = await fixture.request(`/api/rooms/${a.code}/action`, { type: 'move', column, revision: state.revision }, seat.token);
    assert.equal(result.status, 200);
    const [viewA, viewB] = await updates;
    assertSameGame(viewA, viewB);
    assertSameGame(viewA, result.body.state);
    assert.ok(viewA.expiresAt >= state.expiresAt);
    assert.ok(viewB.expiresAt >= state.expiresAt);
    state = viewA;
  }
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 1);

  // A new connection with the original seat token receives the finished board.
  socketA.disconnect();
  const restoredA = await fixture.socket();
  const restored = await restoredA.timeout(3000).emitWithAck('subscribe', { code: a.code, token: a.token });
  assertSameGame(restored.state, state);
  assert.ok(restored.state.expiresAt >= state.expiresAt);

  for (const seat of [a, b]) {
    const expectedRevision = state.revision + 1;
    const updates = Promise.all([restoredA, socketB].map(socket => waitState(socket, view => view.revision === expectedRevision)));
    const response = await fixture.request(`/api/rooms/${a.code}/action`, { type: 'rematch', revision: state.revision }, seat.token);
    assert.equal(response.status, 200);
    const views = await updates;
    assertSameGame(views[0], views[1]);
    assert.ok(views[0].expiresAt >= state.expiresAt);
    assert.ok(views[1].expiresAt >= state.expiresAt);
    state = views[0];
  }
  assert.equal(state.round, 2);
  assert.equal(state.turn, 2);
  assert.equal(state.moveCount, 0);
  assert.deepEqual(state.scores, [1, 0]);
});

test('Socket.IO rooms isolate broadcasts and reject a forged seat token', { timeout: 10000 }, async t => {
  const fixture = await serverFixture(t);
  const a = await fixture.app.service.create('Alice');
  const b = await fixture.app.service.join(a.code, 'Bob');
  const other = await fixture.app.service.create('Carol');
  const otherSocket = await fixture.socket();
  await otherSocket.timeout(3000).emitWithAck('subscribe', { code: other.code, token: other.token });
  const seen = [];
  otherSocket.on('state', state => seen.push(state));
  const forgedSocket = await fixture.socket();
  const denied = await forgedSocket.timeout(3000).emitWithAck('subscribe', { code: a.code, token: other.token });
  assert.equal(denied.error.code, 'UNAUTHORIZED');
  const forgedUpdates = [];
  forgedSocket.on('state', state => forgedUpdates.push(state));
  const result = await fixture.request(`/api/rooms/${a.code}/action`, { type: 'move', column: 2, revision: b.state.revision }, a.token);
  assert.equal(result.status, 200);
  // Broadcast callbacks run asynchronously after the HTTP mutation commits.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(seen.every(state => state.code === other.code));
  assert.equal(forgedUpdates.length, 0);
  assert.equal((await fixture.app.service.state(other.code, other.token)).state.moveCount, 0);
});
