export const ROWS = 6;
export const COLUMNS = 7;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const ONLINE_GRACE_MS = 20_000;

export class GameError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = status;
  }
}

export function validateName(input) {
  if (typeof input !== 'string') throw new GameError('INVALID_NAME', 'Enter a name between 1 and 20 characters.');
  const name = input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if ([...name].length < 1 || [...name].length > 20 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new GameError('INVALID_NAME', 'Enter a name between 1 and 20 characters.');
  }
  return name;
}

export function validateCode(input) {
  if (typeof input !== 'string' || !/^[A-HJ-NP-Z2-9]{6}$/.test(input.toUpperCase())) {
    throw new GameError('INVALID_CODE', 'Enter a six-character room code.');
  }
  return input.toUpperCase();
}

export function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLUMNS).fill(0));
}

export function newRoom(code, name, tokenHash) {
  return {
    code, board: emptyBoard(), players: [{ name, tokenHash }, null],
    turn: 1, starter: 1, status: 'waiting', winner: null, winningCells: [],
    revision: 0, round: 1, scores: [0, 0], rematch: [false, false],
    lastMove: null, moveCount: 0,
  };
}

// Inspect lines through the last move; return the complete winning line(s).
export function findWinningCells(board, row, column, player) {
  const cells = new Map();
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [[row, column]];
    for (const direction of [-1, 1]) {
      let r = row + dr * direction;
      let c = column + dc * direction;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLUMNS && board[r][c] === player) {
        line.push([r, c]);
        r += dr * direction;
        c += dc * direction;
      }
    }
    if (line.length >= 4) for (const cell of line) cells.set(cell.join(','), cell);
  }
  return [...cells.values()];
}

export function applyAction(room, player, action, online) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new GameError('INVALID_ACTION', 'Choose a valid action.');
  }
  if (!Number.isSafeInteger(action.revision) || action.revision !== room.revision) {
    throw new GameError('STALE_STATE', 'The board changed. Please try again.', 409);
  }
  if (room.status === 'closed') throw new GameError('ROOM_CLOSED', 'A player left this room. Create a new room.', 410);
  const next = structuredClone(room);
  if (action.type === 'leave') {
    next.status = 'closed';
  } else if (action.type === 'move') {
    if (room.status === 'waiting') throw new GameError('WAITING_FOR_PLAYER', 'Invite a second player before making a move.', 409);
    if (room.status !== 'playing') throw new GameError('GAME_OVER', 'This round is over. Both players can request a rematch.', 409);
    if (!online.every(Boolean)) throw new GameError('PLAYER_OFFLINE', 'Waiting for your opponent to reconnect.', 409);
    if (room.turn !== player) throw new GameError('NOT_YOUR_TURN', 'It is your opponent’s turn.', 409);
    const column = action.column;
    if (!Number.isInteger(column) || column < 0 || column >= COLUMNS) {
      throw new GameError('INVALID_COLUMN', 'Choose a column from 1 to 7.');
    }
    let row = ROWS - 1;
    while (row >= 0 && room.board[row][column] !== 0) row--;
    if (row < 0) throw new GameError('COLUMN_FULL', 'That column is full. Choose another.', 409);
    next.board[row][column] = player;
    next.lastMove = { row, column, player };
    next.moveCount++;
    next.winningCells = findWinningCells(next.board, row, column, player);
    if (next.winningCells.length) {
      next.status = 'won';
      next.winner = player;
      next.scores[player - 1]++;
    } else if (next.moveCount === ROWS * COLUMNS) {
      next.status = 'draw';
    } else {
      next.turn = player === 1 ? 2 : 1;
    }
  } else if (action.type === 'rematch') {
    if (!['won', 'draw'].includes(room.status)) throw new GameError('ROUND_NOT_OVER', 'Finish this round before requesting a rematch.', 409);
    if (room.rematch[player - 1]) throw new GameError('ALREADY_REQUESTED', 'Your rematch request is already waiting.', 409);
    next.rematch[player - 1] = true;
    if (next.rematch.every(Boolean)) {
      next.board = emptyBoard();
      next.starter = room.starter === 1 ? 2 : 1;
      next.turn = next.starter;
      next.status = 'playing';
      next.winner = null;
      next.winningCells = [];
      next.rematch = [false, false];
      next.lastMove = null;
      next.moveCount = 0;
      next.round++;
    }
  } else {
    throw new GameError('INVALID_ACTION', 'Choose a valid action.');
  }
  next.revision++;
  return next;
}

export function publicState(record, now) {
  const { room, seen, expiresAt } = record;
  return {
    ...room,
    players: room.players.map((player, index) => player ? { name: player.name, online: now - seen[index] <= ONLINE_GRACE_MS } : null),
    expiresAt,
  };
}
