import { GameError, newRoom, validateName, validateCode, applyAction, publicState } from './game.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode() {
  // 32 symbols means byte modulo is unbiased.
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => ALPHABET[byte % ALPHABET.length]).join('');
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenHash(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new GameError('UNAUTHORIZED', 'Your seat could not be verified. Rejoin from your original browser.', 401);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class GameService {
  constructor(store, { now = () => Date.now(), onChange = () => {} } = {}) {
    this.store = store;
    this.now = now;
    this.onChange = onChange;
  }

  notify(code) {
    // A committed move remains successful even if an optional transport fails.
    try { Promise.resolve(this.onChange(code)).catch(() => {}); } catch { /* transport will resync */ }
  }

  async load(code) {
    const normalized = validateCode(code);
    const record = await this.store.get(normalized);
    if (!record || record.expiresAt <= this.now()) throw new GameError('ROOM_NOT_FOUND', 'This room was not found or has expired. Check the code or create a new room.', 404);
    return record;
  }

  async authenticate(record, token) {
    const hash = await tokenHash(token);
    const index = record.room.players.findIndex(player => player?.tokenHash === hash);
    if (index === -1) throw new GameError('UNAUTHORIZED', 'Your seat could not be verified. Rejoin from your original browser.', 401);
    return index + 1;
  }

  async create(input) {
    const name = validateName(input);
    const token = randomToken();
    const hash = await tokenHash(token);
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode();
      const room = newRoom(code, name, hash);
      if (await this.store.create(room, this.now())) {
        const record = await this.store.get(code);
        return { code, token, player: 1, state: publicState(record, this.now()) };
      }
    }
    throw new GameError('TRY_AGAIN', 'Could not create a room. Please try again.', 503);
  }

  async join(inputCode, inputName) {
    const name = validateName(inputName);
    const record = await this.load(inputCode);
    const { room } = record;
    if (room.status === 'closed') throw new GameError('ROOM_CLOSED', 'A player left this room. Create a new room.', 410);
    if (room.players[1]) throw new GameError('ROOM_FULL', 'Both seats are taken. Ask your friend to create a new room.', 409);
    const token = randomToken();
    const next = structuredClone(room);
    next.players[1] = { name, tokenHash: await tokenHash(token) };
    next.status = 'playing';
    next.revision++;
    if (!await this.store.compareAndSet(next, room.revision, this.now())) throw new GameError('ROOM_CHANGED', 'This room changed. Please try joining again.', 409);
    await this.store.touch(room.code, 2, this.now());
    this.notify(room.code);
    return { code: room.code, token, player: 2, state: publicState(await this.store.get(room.code), this.now()) };
  }

  async state(code, token) {
    const record = await this.load(code);
    const player = await this.authenticate(record, token);
    await this.store.touch(record.room.code, player, this.now());
    // Authentication and storage are asynchronous. A room may expire (or be
    // collected) while this request waits; never return a stale expired record.
    return { state: publicState(await this.load(record.room.code), this.now()) };
  }

  async action(code, token, action) {
    const record = await this.load(code);
    const player = await this.authenticate(record, token);
    await this.store.touch(record.room.code, player, this.now());
    record.seen[player - 1] = this.now();
    const state = publicState(record, this.now());
    const next = applyAction(record.room, player, action, state.players.map(p => Boolean(p?.online)));
    if (!await this.store.compareAndSet(next, record.room.revision, this.now())) throw new GameError('STALE_STATE', 'The board changed. Please try again.', 409);
    this.notify(record.room.code);
    return { state: publicState(await this.store.get(record.room.code), this.now()) };
  }
}
