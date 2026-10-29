import { ROOM_TTL_MS } from './game.js';

export class MemoryStore {
  constructor() { this.rooms = new Map(); }
  async get(code) { return structuredClone(this.rooms.get(code) ?? null); }
  async create(room, now) {
    if (this.rooms.has(room.code)) return false;
    this.rooms.set(room.code, { room: structuredClone(room), seen: [now, 0], expiresAt: now + ROOM_TTL_MS });
    // Keep the self-hosted memory adapter bounded by removing expired rooms.
    for (const [code, record] of this.rooms) if (record.expiresAt < now) this.rooms.delete(code);
    return true;
  }
  async compareAndSet(room, expectedRevision, now) {
    const record = this.rooms.get(room.code);
    if (!record || record.room.revision !== expectedRevision || record.expiresAt <= now) return false;
    record.room = structuredClone(room);
    record.expiresAt = now + ROOM_TTL_MS;
    return true;
  }
  async touch(code, player, now) {
    const record = this.rooms.get(code);
    if (!record || record.expiresAt <= now) return;
    record.seen[player - 1] = now;
    record.expiresAt = now + ROOM_TTL_MS;
  }
}

export class D1Store {
  constructor(db) { this.db = db; }
  async get(code) {
    const result = await this.db.prepare('SELECT state, p1_seen, p2_seen, expires_at FROM rooms WHERE code = ?').bind(code).first();
    if (!result) return null;
    return { room: JSON.parse(result.state), seen: [result.p1_seen, result.p2_seen], expiresAt: result.expires_at };
  }
  async create(room, now) {
    const result = await this.db.prepare('INSERT OR IGNORE INTO rooms (code, state, revision, p1_seen, p2_seen, expires_at) VALUES (?, ?, ?, ?, 0, ?)')
      .bind(room.code, JSON.stringify(room), room.revision, now, now + ROOM_TTL_MS).run();
    // Expired sessions are garbage-collected in bounded batches, never exposed.
    await this.db.prepare('DELETE FROM rooms WHERE code IN (SELECT code FROM rooms WHERE expires_at < ? LIMIT 100)').bind(now).run();
    return result.meta.changes === 1;
  }
  async compareAndSet(room, expectedRevision, now) {
    const result = await this.db.prepare('UPDATE rooms SET state = ?, revision = ?, expires_at = ? WHERE code = ? AND revision = ? AND expires_at > ?')
      .bind(JSON.stringify(room), room.revision, now + ROOM_TTL_MS, room.code, expectedRevision, now).run();
    return result.meta.changes === 1;
  }
  async touch(code, player, now) {
    // Column names are selected from fixed literals, never user input.
    const column = player === 1 ? 'p1_seen' : 'p2_seen';
    await this.db.prepare(`UPDATE rooms SET ${column} = ?, expires_at = ? WHERE code = ? AND expires_at > ? AND ${column} < ?`)
      .bind(now, now + ROOM_TTL_MS, code, now, now - 5000).run();
  }
}
