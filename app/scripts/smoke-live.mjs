import assert from 'node:assert/strict';

// Creates one disposable room on the selected deployment and closes it at the end.
// Seat credentials stay in process memory and are never printed or written to disk.
const origin = new URL(process.argv[2] || 'http://localhost:3000').origin;
let seats;
let state;
let checks = 0;

async function request(path, body, token, expected = 200) {
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${data.error?.message || response.status}`);
  checks++;
  return data;
}

function gameState(value) {
  const { expiresAt, ...game } = value;
  assert.ok(expiresAt > Date.now());
  return game;
}

try {
  assert.equal((await request('/health')).ok, true);
  const a = await request('/api/rooms', { name: 'QA Player A' }, null, 201);
  seats = [a];
  const b = await request(`/api/rooms/${a.code}/join`, { name: 'QA Player B' });
  seats.push(b);
  state = b.state;
  await request(`/api/rooms/${a.code}/join`, { name: 'Third player' }, null, 409);
  await request(`/api/rooms/${a.code}`, undefined, '0'.repeat(64), 401);
  await request(`/api/rooms/${a.code}/action`, { type: 'move', column: 0, revision: state.revision }, b.token, 409);
  for (const column of [0, 0, 1, 1, 2, 2, 3]) {
    // Authenticate both seats to keep the check valid on slower networks too.
    for (const seat of seats) await request(`/api/rooms/${a.code}`, undefined, seat.token);
    const oldRevision = state.revision;
    const seat = seats[state.turn - 1];
    ({ state } = await request(`/api/rooms/${a.code}/action`, { type: 'move', column, revision: oldRevision }, seat.token));
    await request(`/api/rooms/${a.code}/action`, { type: 'move', column, revision: oldRevision }, seat.token, 409);
    const views = await Promise.all(seats.map(player => request(`/api/rooms/${a.code}`, undefined, player.token)));
    assert.deepEqual(gameState(views[0].state), gameState(views[1].state));
    assert.deepEqual(gameState(state), gameState(views[1].state));
  }
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 1);
  assert.equal(state.winningCells.length, 4);
  for (const seat of seats) ({ state } = await request(`/api/rooms/${a.code}/action`, { type: 'rematch', revision: state.revision }, seat.token));
  assert.equal(state.round, 2);
  assert.equal(state.turn, 2);
  assert.equal(state.moveCount, 0);
  assert.deepEqual(state.scores, [1, 0]);
  console.log(JSON.stringify({ origin, result: 'PASS', requests: checks, verified: ['health', 'create/join', 'third-seat rejection', 'authentication', 'turn enforcement', 'duplicate/stale moves', 'both-client agreement', 'complete win', 'consensual rematch', 'alternating starter'] }));
} finally {
  if (seats?.[0]) {
    try {
      const seat = seats[0];
      const latest = await request(`/api/rooms/${seat.code}`, undefined, seat.token);
      await request(`/api/rooms/${seat.code}/action`, { type: 'leave', revision: latest.state.revision }, seat.token);
      console.log('Disposable test room closed.');
    } catch { console.error('Test room cleanup could not complete; it will expire after inactivity.'); }
  }
}
