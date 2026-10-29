import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { GameService } from '../server/service.js';
import { D1Store, MemoryStore } from '../server/stores.js';
import { ONLINE_GRACE_MS, ROOM_TTL_MS } from '../server/game.js';

// Use SQLite itself to exercise D1 SQL and optimistic concurrency locally.
// This is a D1 API adapter, not a claim that these tests run in Cloudflare.
function sqliteStore(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0000_room_storage.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return new D1Store({
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() { return db.prepare(sql).get(...values) ?? null; },
            async run() {
              const result = db.prepare(sql).run(...values);
              return { success: true, meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  });
}

function fixture(t, makeStore) {
  let time = 1_800_000_000_000;
  const store = makeStore(t);
  const changes = [];
  const service = new GameService(store, { now: () => time, onChange: code => changes.push(code) });
  return { service, store, changes, advance: milliseconds => { time += milliseconds; } };
}

async function pair(service) {
  const a = await service.create('Alice');
  const b = await service.join(a.code, 'Bob');
  return [a, b];
}

async function play(service, seats, columns) {
  let { state } = await service.state(seats[0].code, seats[0].token);
  for (const column of columns) {
    const player = seats[state.turn - 1];
    ({ state } = await service.action(player.code, player.token, { type: 'move', column, revision: state.revision }));
  }
  return state;
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, error => error.code === code);
}

const wins = {
  horizontal: [0, 0, 1, 1, 2, 2, 3],
  vertical: [0, 1, 0, 1, 0, 1, 0],
  'rising diagonal': [0, 1, 1, 2, 4, 2, 2, 3, 4, 3, 5, 3, 3],
  'falling diagonal': [6, 5, 5, 4, 2, 4, 4, 3, 2, 3, 1, 3, 3],
};

// A complete legal game. Its final board has paired horizontal colors and
// alternating rows, with no horizontal, vertical, or diagonal line of four.
const DRAW = [2, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2,
  3, 3, 3, 3, 3, 3, 6, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6];

for (const [adapter, makeStore] of [['memory', () => new MemoryStore()], ['D1 SQL / SQLite', sqliteStore]]) {
  test.describe(adapter, () => {
    test('rooms require two seats; state hides credentials and survives authenticated reconnect', async t => {
      const { service } = fixture(t, makeStore);
      const a = await service.create('  Alice   Wu  ');
      assert.match(a.code, /^[A-HJ-NP-Z2-9]{6}$/);
      assert.match(a.token, /^[a-f0-9]{64}$/);
      assert.equal(a.state.players[0].name, 'Alice Wu');
      assert.equal(a.state.status, 'waiting');
      await rejectsCode(service.action(a.code, a.token, { type: 'move', column: 0, revision: a.state.revision }), 'WAITING_FOR_PLAYER');
      const b = await service.join(a.code.toLowerCase(), 'Bob');
      assert.equal(b.player, 2);
      assert.equal(b.state.status, 'playing');
      await rejectsCode(service.join(a.code, 'Third'), 'ROOM_FULL');
      const { state } = await service.state(a.code, a.token);
      assert.equal(state.revision, b.state.revision);
      assert.deepEqual(state.players.map(p => p.online), [true, true]);
      const serialized = JSON.stringify(state);
      assert.ok(!serialized.includes(a.token) && !serialized.includes(b.token));
      assert.ok(!serialized.includes('tokenHash'));
      await rejectsCode(service.state(a.code, '0'.repeat(64)), 'UNAUTHORIZED');
      await rejectsCode(service.state(a.code, ''), 'UNAUTHORIZED');
    });

    test('invalid names and codes never create or join a room', async t => {
      const { service } = fixture(t, makeStore);
      for (const name of ['', '   ', 'a'.repeat(21), '\u0000Alice', null, 17]) {
        await rejectsCode(service.create(name), 'INVALID_NAME');
      }
      await rejectsCode(service.join('../oops', 'Bob'), 'INVALID_CODE');
      await rejectsCode(service.join('ABCDEF', 'Bob'), 'ROOM_NOT_FOUND');
    });

    test('turn order, column bounds, gravity, and full columns are enforced without mutation', async t => {
      const { service } = fixture(t, makeStore);
      const seats = await pair(service);
      let state = seats[1].state;
      await rejectsCode(service.action(seats[1].code, seats[1].token, { type: 'move', column: 0, revision: state.revision }), 'NOT_YOUR_TURN');
      for (const column of [-1, 7, 1.5, '0', null]) {
        await rejectsCode(service.action(seats[0].code, seats[0].token, { type: 'move', column, revision: state.revision }), 'INVALID_COLUMN');
      }
      state = await play(service, seats, [0, 0, 0, 0, 0, 0]);
      assert.deepEqual(state.board.map(row => row[0]), [2, 1, 2, 1, 2, 1]);
      assert.equal(state.moveCount, 6);
      await rejectsCode(service.action(seats[0].code, seats[0].token, { type: 'move', column: 0, revision: state.revision }), 'COLUMN_FULL');
      assert.deepEqual((await service.state(seats[0].code, seats[0].token)).state.board, state.board);
    });

    for (const [direction, columns] of Object.entries(wins)) {
      test(`a legal ${direction} win is agreed by both players and ends the round`, async t => {
        const { service } = fixture(t, makeStore);
        const seats = await pair(service);
        const state = await play(service, seats, columns);
        assert.equal(state.status, 'won');
        assert.equal(state.winner, 1);
        assert.deepEqual(state.scores, [1, 0]);
        assert.equal(state.winningCells.length, 4);
        for (const [row, column] of state.winningCells) assert.equal(state.board[row][column], 1);
        const viewA = await service.state(seats[0].code, seats[0].token);
        const viewB = await service.state(seats[1].code, seats[1].token);
        assert.deepEqual(viewA.state, viewB.state);
        await rejectsCode(service.action(seats[0].code, seats[0].token, { type: 'move', column: 6, revision: state.revision }), 'GAME_OVER');
      });
    }

    test('all 42 legal moves can finish in a draw, with no false winner', async t => {
      const { service } = fixture(t, makeStore);
      const seats = await pair(service);
      const state = await play(service, seats, DRAW);
      assert.equal(state.status, 'draw');
      assert.equal(state.moveCount, 42);
      assert.equal(state.board.flat().filter(Boolean).length, 42);
      assert.equal(state.winner, null);
      assert.deepEqual(state.winningCells, []);
      assert.deepEqual(state.scores, [0, 0]);
    });

    test('concurrent duplicate moves commit once and stale retries cannot move again', async t => {
      const { service } = fixture(t, makeStore);
      const [a, b] = await pair(service);
      const revision = b.state.revision;
      const results = await Promise.allSettled([0, 1].map(column => service.action(a.code, a.token, { type: 'move', column, revision })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'STALE_STATE').length, 1);
      const { state } = await service.state(a.code, a.token);
      assert.equal(state.moveCount, 1);
      assert.equal(state.revision, revision + 1);
      assert.equal(state.board.flat().filter(Boolean).length, 1);
      await rejectsCode(service.action(a.code, a.token, { type: 'move', column: 2, revision }), 'STALE_STATE');
    });

    test('simultaneous join requests can claim only one second seat', async t => {
      const { service } = fixture(t, makeStore);
      const a = await service.create('Alice');
      const results = await Promise.allSettled(['Bob', 'Carol'].map(name => service.join(a.code, name)));
      const successful = results.filter(r => r.status === 'fulfilled');
      assert.equal(successful.length, 1);
      const { state } = await service.state(a.code, a.token);
      assert.equal(state.players[1].name, successful[0].value.state.players[1].name);
      assert.equal(state.revision, 1);
    });

    test('a rematch requires both votes, clears the board, preserves scores, and alternates starter', async t => {
      const { service } = fixture(t, makeStore);
      const seats = await pair(service);
      let state = await play(service, seats, wins.horizontal);
      ({ state } = await service.action(seats[0].code, seats[0].token, { type: 'rematch', revision: state.revision }));
      assert.equal(state.status, 'won');
      assert.deepEqual(state.rematch, [true, false]);
      await rejectsCode(service.action(seats[0].code, seats[0].token, { type: 'rematch', revision: state.revision }), 'ALREADY_REQUESTED');
      ({ state } = await service.action(seats[1].code, seats[1].token, { type: 'rematch', revision: state.revision }));
      assert.equal(state.status, 'playing');
      assert.equal(state.round, 2);
      assert.equal(state.turn, 2);
      assert.equal(state.starter, 2);
      assert.equal(state.moveCount, 0);
      assert.equal(state.lastMove, null);
      assert.equal(state.winner, null);
      assert.equal(state.board.flat().filter(Boolean).length, 0);
      assert.deepEqual(state.rematch, [false, false]);
      assert.deepEqual(state.scores, [1, 0]);
      await rejectsCode(service.action(seats[0].code, seats[0].token, { type: 'move', column: 1, revision: state.revision }), 'NOT_YOUR_TURN');
    });

    test('a disconnected opponent pauses play; their original token restores the same seat and board', async t => {
      const { service, advance } = fixture(t, makeStore);
      const [a, b] = await pair(service);
      advance(ONLINE_GRACE_MS + 1);
      let { state } = await service.state(a.code, a.token);
      assert.deepEqual(state.players.map(p => p.online), [true, false]);
      await rejectsCode(service.action(a.code, a.token, { type: 'move', column: 0, revision: state.revision }), 'PLAYER_OFFLINE');
      await rejectsCode(service.join(a.code, 'Seat thief'), 'ROOM_FULL');
      ({ state } = await service.state(b.code, b.token));
      assert.deepEqual(state.players.map(p => p.online), [true, true]);
      ({ state } = await service.action(a.code, a.token, { type: 'move', column: 0, revision: state.revision }));
      assert.equal(state.moveCount, 1);
      assert.equal(state.players[1].name, 'Bob');
    });

    test('unrelated rooms remain isolated and a token from another room is rejected', async t => {
      const { service } = fixture(t, makeStore);
      const seats = await pair(service);
      const other = await service.create('Carol');
      await play(service, seats, [2]);
      const { state } = await service.state(other.code, other.token);
      assert.equal(state.status, 'waiting');
      assert.equal(state.moveCount, 0);
      assert.equal(state.players[1], null);
      await rejectsCode(service.state(seats[0].code, other.token), 'UNAUTHORIZED');
    });

    test('leaving closes the room for both players and expired rooms cannot be revived', async t => {
      const { service, advance } = fixture(t, makeStore);
      const [a, b] = await pair(service);
      const closed = await service.action(a.code, a.token, { type: 'leave', revision: b.state.revision });
      assert.equal(closed.state.status, 'closed');
      assert.equal((await service.state(b.code, b.token)).state.status, 'closed');
      await rejectsCode(service.join(a.code, 'Carol'), 'ROOM_CLOSED');
      await rejectsCode(service.action(b.code, b.token, { type: 'move', column: 0, revision: closed.state.revision }), 'ROOM_CLOSED');
      const expiring = await service.create('Dana');
      advance(ROOM_TTL_MS + 1);
      await rejectsCode(service.state(expiring.code, expiring.token), 'ROOM_NOT_FOUND');
      await rejectsCode(service.join(expiring.code, 'Eli'), 'ROOM_NOT_FOUND');
    });

    test('a room expiring during an asynchronous heartbeat is rejected before its state is returned', async t => {
      const { service, store, advance } = fixture(t, makeStore);
      const seat = await service.create('Alice');
      const touch = store.touch.bind(store);
      store.touch = async (code, player, time) => {
        await touch(code, player, time);
        // Simulate a storage/authentication wait spanning the room lifetime.
        advance(ROOM_TTL_MS + 1);
      };
      await rejectsCode(service.state(seat.code, seat.token), 'ROOM_NOT_FOUND');
    });

    test('transport notification failures do not undo committed moves', async t => {
      const { service } = fixture(t, makeStore);
      const seats = await pair(service);
      service.onChange = () => { throw new Error('transport unavailable'); };
      const state = await play(service, seats, [1]);
      assert.equal(state.moveCount, 1);
      assert.equal((await service.state(seats[1].code, seats[1].token)).state.board[5][1], 1);
    });
  });
}
