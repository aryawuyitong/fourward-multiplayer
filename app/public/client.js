(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('room-form');
  const nameInput = $('player-name');
  const codeInput = $('room-code-input');
  const board = $('board');
  const controls = $('column-controls');
  const cells = [];
  const columnButtons = [];
  const demoBoard = [
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 2, 0, 0, 0],
    [0, 0, 1, 1, 2, 0, 0],
    [0, 1, 2, 2, 1, 2, 0],
  ];
  let session = null;
  let state = null;
  let busy = false;
  let reachable = navigator.onLine;
  let epoch = 0;
  let pollTimer;
  let refreshInFlight = false;
  let socket = null;
  let socketHealthy = false;
  let transport = 'polling';
  let pollInterval = 1000;
  let toastTimer;
  let shownBoard = null;

  function stored(storage, key, value) {
    try {
      if (value === undefined) return storage.getItem(key);
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch { /* The game still works when browser storage is unavailable. */ }
    return null;
  }

  function errorMessage(message = '') {
    $('error-message').textContent = message;
    $('error-message').hidden = !message;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
  }

  async function request(path, { method = 'GET', body, authenticated = false } = {}) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 9000);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (authenticated && session) headers.Authorization = `Bearer ${session.token}`;
      const response = await fetch(path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('The server could not answer. Please try again.'); }
      if (!response.ok) {
        const error = new Error(data.error?.message || 'Something went wrong. Please try again.');
        error.status = response.status;
        error.code = data.error?.code;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The connection timed out. Check your internet and try again.');
      if (error instanceof TypeError) throw new Error('Connection lost. We’ll reconnect as soon as you’re back online.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  for (let column = 0; column < 7; column += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'column-button';
    button.setAttribute('aria-label', `Drop a disc in column ${column + 1}`);
    button.title = `Column ${column + 1} · keyboard ${column + 1}`;
    const number = document.createElement('span');
    number.className = 'column-number';
    number.textContent = column + 1;
    number.setAttribute('aria-hidden', 'true');
    const arrow = document.createElement('span');
    arrow.textContent = '↓';
    arrow.setAttribute('aria-hidden', 'true');
    button.append(number, arrow);
    button.addEventListener('click', () => move(column));
    controls.append(button);
    columnButtons.push(button);
  }
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const cell = document.createElement('span');
      cell.className = 'cell';
      cell.dataset.column = column;
      cell.setAttribute('role', 'img');
      board.append(cell);
      cells.push(cell);
    }
  }

  function bothOnline() {
    return state?.players?.length === 2 && state.players.every((player) => player && player.online);
  }

  function canMove() {
    return !!(session && state && !busy && reachable && state.status === 'playing' && state.turn === session.player && bothOnline());
  }

  function renderBoard() {
    const values = state?.board || demoBoard;
    const winners = new Set((state?.winningCells || []).map(([row, column]) => `${row}:${column}`));
    const enabled = canMove();
    board.classList.toggle('enabled', enabled);
    board.setAttribute('aria-label', session ? `Four-in-a-row board, round ${state?.round || 1}. Choose a column with the arrow buttons or keys 1 to 7.` : 'Preview of a four-in-a-row board. Create or join a room to play.');
    controls.className = `column-controls player-${session?.player || 1}`;
    cells.forEach((cell, index) => {
      const row = Math.floor(index / 7);
      const column = index % 7;
      const value = values[row][column];
      const justDropped = !!(state && shownBoard && value && shownBoard[row][column] === 0);
      cell.className = `cell${value ? ` disc-${value}` : ''}${winners.has(`${row}:${column}`) ? ' winner' : ''}${state?.lastMove?.row === row && state.lastMove.column === column ? ' last-move' : ''}${justDropped ? ' drop' : ''}`;
      cell.textContent = value || '';
      cell.setAttribute('aria-label', `Row ${row + 1}, column ${column + 1}: ${value ? `player ${value}${winners.has(`${row}:${column}`) ? ', winning disc' : ''}` : 'empty'}`);
    });
    shownBoard = values.map((row) => [...row]);
    columnButtons.forEach((button, column) => {
      const full = values[0][column] !== 0;
      button.disabled = !enabled || full;
      button.setAttribute('aria-label', `Column ${column + 1}${full && state ? ' is full' : ': drop a disc'}`);
    });
  }

  function setStatus(title, detail, pill, kind = '') {
    if ($('game-status').textContent !== title) $('game-status').textContent = title;
    $('game-substatus').textContent = detail;
    $('status-pill-text').textContent = pill;
    $('status-pill').className = `status-pill ${kind}`;
  }

  function playerName(player) {
    return state?.players?.[player - 1]?.name || `Player ${player}`;
  }

  function render() {
    $('create-room').disabled = busy;
    $('join-room').disabled = busy;
    $('create-room').firstElementChild.textContent = busy && !session ? 'Setting your table…' : 'Create a room';
    $('setup-panel').hidden = !!session;
    $('match-panel').hidden = !session;
    document.querySelector('.play-layout').classList.toggle('in-match', !!(session && state?.players[1]));
    $('leave-room').disabled = busy;
    if (!session || !state) {
      if (!session) setStatus('Your next move starts here.', 'Create a room. Invite a friend. Make a connection.', 'READY WHEN YOU ARE');
      renderBoard();
      return;
    }

    $('room-code-display').textContent = session.code;
    $('round-value').textContent = String(state.round).padStart(2, '0');
    $('moves-value').textContent = String(state.moveCount).padStart(2, '0');
    $('you-value').textContent = String(session.player).padStart(2, '0');
    $('invite-description').textContent = state.players[1] ? 'Your table is full. A little rivalry looks good on you.' : 'Send this code to your friend. They can join from any device.';
    const shareNote = state.players[1] ? 'Both seats are taken. Your game is ready.' : 'Anyone with this code can take the open seat.';
    if ($('share-note').textContent !== shareNote) $('share-note').textContent = shareNote;
    for (let player = 1; player <= 2; player += 1) {
      const prefix = player === 1 ? 'player-one' : 'player-two';
      const info = state.players[player - 1];
      $(`${prefix}-label`).textContent = `PLAYER ${player === 1 ? 'ONE' : 'TWO'}${session.player === player ? ' · YOU' : ''}`;
      $(`${prefix}-name`).textContent = info?.name || 'An open seat';
      $(`${prefix}-presence`).textContent = !info ? 'Waiting for a friend' : info.online ? 'At the table' : 'Away · seat reserved';
      $(`${prefix}-card`).classList.toggle('active', state.status === 'playing' && state.turn === player && reachable && bothOnline());
      $(player === 1 ? 'score-one' : 'score-two').textContent = state.scores[player - 1];
    }

    if (state.status === 'closed') {
      setStatus('A good game, well played.', 'This room is closed. Leave to create a new table.', 'ROOM CLOSED', 'paused');
    } else if (!reachable) {
      setStatus('Saving your seat.', 'Connection interrupted. We’re trying to reconnect.', 'RECONNECTING', 'paused');
    } else if (state.status === 'waiting') {
      setStatus('Good things take two.', 'Share your room code. Your first move is waiting.', 'WAITING FOR A FRIEND');
    } else if (state.status === 'won') {
      setStatus(state.winner === session.player ? 'Fourward. You’ve won!' : `${playerName(state.winner)} takes the round.`, 'Four connected. One good reason for a rematch.', 'FOUR IN A ROW', 'finished');
    } else if (state.status === 'draw') {
      setStatus('Perfectly matched.', 'The board is full. A draw, and a fresh start?', 'IT’S A DRAW', 'finished');
    } else if (!bothOnline()) {
      setStatus('A quick intermission.', 'Your rival is reconnecting. Their seat is saved.', 'GAME PAUSED', 'paused');
    } else if (state.turn === session.player) {
      setStatus('The next move is yours.', 'Choose a column. Make it count.', 'YOUR TURN', 'live');
    } else {
      setStatus(`${playerName(state.turn)} is thinking.`, 'A little patience is part of a good rivalry.', 'THEIR TURN', 'live');
    }

    const finished = ['won', 'draw'].includes(state.status);
    $('round-action').hidden = !finished;
    const voted = !!state.rematch[session.player - 1];
    const otherVoted = !!state.rematch[session.player === 1 ? 1 : 0];
    $('rematch').disabled = busy || voted || !reachable || !bothOnline();
    $('rematch').firstElementChild.textContent = voted ? 'Rematch requested' : 'Play another round';
    const rematchNote = voted ? 'Waiting for your rival to agree. A fresh board is close.' : otherVoted ? 'Your rival is ready. Accept to start the next round.' : 'Both players agree. The starting player alternates.';
    if ($('rematch-note').textContent !== rematchNote) $('rematch-note').textContent = rematchNote;
    $('connection-dot').classList.toggle('offline', !reachable);
    $('connection-text').textContent = !reachable ? 'Connection interrupted · seat saved' : transport === 'socket.io' && socketHealthy ? 'Live connection · Socket.IO' : 'Connected · synced every second';
    $('retry-connection').hidden = reachable;
    $('move-caption').textContent = state.lastMove ? `↳ ${playerName(state.lastMove.player)} dropped in column ${state.lastMove.column + 1}.` : state.status === 'waiting' ? '↳ An open seat, and plenty of possibility.' : `↳ ${playerName(state.starter)} starts this round. The board is yours.`;
    renderBoard();
  }

  function acceptState(incoming) {
    if (!session || !incoming || incoming.code !== session.code || (state && incoming.revision < state.revision)) return;
    state = incoming;
    render();
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!session) return;
    pollTimer = setTimeout(refresh, delay ?? (socketHealthy ? 5000 : pollInterval));
  }

  async function refresh() {
    if (!session) return;
    if (refreshInFlight) { schedulePoll(250); return; }
    refreshInFlight = true;
    const currentEpoch = epoch;
    try {
      const data = await request(`/api/rooms/${session.code}`, { authenticated: true });
      if (currentEpoch !== epoch) return;
      reachable = true;
      acceptState(data.state);
    } catch (error) {
      if (currentEpoch !== epoch) return;
      if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410) {
        resetSession();
        errorMessage(error.message);
        return;
      }
      reachable = false;
      render();
    } finally {
      refreshInFlight = false;
      if (currentEpoch === epoch) schedulePoll(reachable ? undefined : 2500);
    }
  }

  function disconnectSocket() {
    if (socket) socket.disconnect();
    socket = null;
    socketHealthy = false;
  }

  async function connectSocket() {
    if (transport !== 'socket.io' || !session) return;
    const currentEpoch = epoch;
    try {
      if (!window.io) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = '/socket.io/socket.io.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.append(script);
        });
      }
      if (currentEpoch !== epoch || !session) return;
      socket = window.io({ reconnection: true, timeout: 6000 });
      socket.on('connect', () => {
        if (!session || currentEpoch !== epoch) return;
        socket.emit('subscribe', { code: session.code, token: session.token }, (reply) => {
          if (currentEpoch !== epoch) return;
          if (reply?.state) {
            socketHealthy = true;
            reachable = true;
            acceptState(reply.state);
            schedulePoll();
          }
        });
      });
      socket.on('state', (incoming) => {
        if (currentEpoch !== epoch) return;
        reachable = true;
        acceptState(incoming?.state || incoming);
      });
      socket.on('disconnect', () => {
        if (currentEpoch !== epoch) return;
        socketHealthy = false;
        render();
        schedulePoll(100);
      });
      socket.on('connect_error', () => {
        if (currentEpoch !== epoch) return;
        socketHealthy = false;
        schedulePoll(100);
      });
    } catch { socketHealthy = false; schedulePoll(100); }
  }

  function attachSession(data) {
    epoch += 1;
    disconnectSocket();
    session = { code: data.code, token: data.token, player: data.player };
    state = data.state || null;
    shownBoard = null;
    reachable = true;
    stored(sessionStorage, `fourward.session.${session.code}`, JSON.stringify(session));
    stored(sessionStorage, 'fourward.active', session.code);
    const url = new URL(location.href);
    url.searchParams.set('room', session.code);
    history.replaceState(null, '', url);
    render();
    connectSocket();
    schedulePoll(data.state ? undefined : 1);
  }

  function resetSession() {
    epoch += 1;
    clearTimeout(pollTimer);
    disconnectSocket();
    if (session) stored(sessionStorage, `fourward.session.${session.code}`, null);
    stored(sessionStorage, 'fourward.active', null);
    session = null;
    state = null;
    shownBoard = null;
    busy = false;
    reachable = navigator.onLine;
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    for (const prefix of ['player-one', 'player-two']) {
      $(`${prefix}-card`).classList.remove('active');
      $(`${prefix}-name`).textContent = prefix === 'player-one' ? 'Your side' : 'A worthy rival';
      $(`${prefix}-label`).textContent = prefix === 'player-one' ? 'PLAYER ONE' : 'PLAYER TWO';
      $(`${prefix}-presence`).textContent = prefix === 'player-one' ? 'The first connection' : 'The other half';
    }
    $('score-one').textContent = '0';
    $('score-two').textContent = '0';
    $('move-caption').textContent = '↳ A preview of your next friendly rivalry.';
    render();
  }

  async function enterRoom(join) {
    if (busy || session) return;
    errorMessage();
    nameInput.value = nameInput.value.trim();
    if (!nameInput.reportValidity()) return;
    const code = codeInput.value.trim().toUpperCase();
    if (join && !/^[A-Z0-9]{6}$/.test(code)) {
      errorMessage('Enter the six-character room code your friend shared.');
      codeInput.focus();
      return;
    }
    busy = true;
    render();
    try {
      const data = await request(join ? `/api/rooms/${code}/join` : '/api/rooms', { method: 'POST', body: { name: nameInput.value } });
      stored(localStorage, 'fourward.name', nameInput.value);
      attachSession(data);
      if (matchMedia('(max-width: 620px)').matches) $('game-status').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    } catch (error) { errorMessage(error.message); }
    finally { busy = false; render(); }
  }

  async function action(payload) {
    if (!session || !state || busy) return;
    busy = true;
    errorMessage();
    render();
    const currentEpoch = epoch;
    try {
      const data = await request(`/api/rooms/${session.code}/action`, {
        method: 'POST', authenticated: true, body: { ...payload, revision: state.revision },
      });
      if (currentEpoch !== epoch) return;
      reachable = true;
      acceptState(data.state);
    } catch (error) {
      if (currentEpoch !== epoch) return;
      errorMessage(error.message);
      await refresh();
    } finally {
      if (currentEpoch === epoch) { busy = false; render(); }
    }
  }

  function move(column) {
    if (!canMove() || state.board[0][column]) return;
    action({ type: 'move', column });
  }

  async function copy(text, success) {
    try {
      await navigator.clipboard.writeText(text);
      toast(success);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      toast(copied ? success : 'Copy is unavailable. Share the room code shown above.');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    enterRoom(document.activeElement === codeInput && !!codeInput.value.trim());
  });
  $('join-room').addEventListener('click', () => enterRoom(true));
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  board.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-column]');
    if (cell) move(Number(cell.dataset.column));
  });
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || document.querySelector('dialog[open]') || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (/^[1-7]$/.test(event.key)) { event.preventDefault(); move(Number(event.key) - 1); }
  });
  $('copy-code').addEventListener('click', () => { if (session) copy(session.code, 'Room code copied. A good game is one invite away.'); });
  $('copy-link').addEventListener('click', () => {
    if (!session) return;
    const invite = new URL('/', location.origin);
    invite.searchParams.set('room', session.code);
    copy(invite.href, 'Invite link copied. Send it to your favorite rival.');
  });
  $('rules-open').addEventListener('click', () => $('rules-dialog').showModal());
  $('leave-room').addEventListener('click', () => {
    if (state?.status === 'closed') { resetSession(); errorMessage(); }
    else $('leave-dialog').showModal();
  });
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => $(button.dataset.close).close());
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
  }
  $('confirm-leave').addEventListener('click', async () => {
    if (!session || busy) return;
    $('confirm-leave').disabled = true;
    errorMessage();
    try {
      if (state?.status !== 'closed') {
        await request(`/api/rooms/${session.code}/action`, { method: 'POST', authenticated: true, body: { type: 'leave', revision: state?.revision } });
      }
      $('leave-dialog').close();
      resetSession();
      toast('Good game. There’s always another round.');
    } catch (error) {
      if ([401, 403, 404, 410].includes(error.status)) { $('leave-dialog').close(); resetSession(); }
      else { $('leave-dialog').close(); errorMessage(error.message); await refresh(); }
    } finally { $('confirm-leave').disabled = false; }
  });
  $('rematch').addEventListener('click', () => action({ type: 'rematch' }));
  $('retry-connection').addEventListener('click', () => refresh());
  window.addEventListener('online', () => { if (session) refresh(); });
  window.addEventListener('offline', () => { reachable = false; render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session) refresh(); });

  async function init() {
    nameInput.value = stored(localStorage, 'fourward.name') || '';
    const invitedCode = new URL(location.href).searchParams.get('room')?.trim().toUpperCase();
    if (invitedCode && /^[A-Z0-9]{6}$/.test(invitedCode)) {
      codeInput.value = invitedCode;
      $('setup-title').textContent = 'Your table is waiting.';
      $('setup-panel').querySelector('.panel-description').textContent = 'You’ve been invited. Add your name and join the room below.';
    }
    render();
    try {
      const config = await request('/api/config');
      transport = config.transport === 'socket.io' ? 'socket.io' : 'polling';
      pollInterval = Math.max(1000, Math.min(5000, Number(config.pollInterval) || 1000));
    } catch { /* Same-origin HTTP polling works without transport discovery. */ }
    const activeCode = invitedCode || stored(sessionStorage, 'fourward.active');
    if (activeCode && /^[A-Z0-9]{6}$/.test(activeCode)) {
      try {
        const saved = JSON.parse(stored(sessionStorage, `fourward.session.${activeCode}`) || 'null');
        if (saved && saved.code === activeCode && typeof saved.token === 'string' && [1, 2].includes(saved.player)) attachSession(saved);
      } catch { /* Ignore an incomplete stored session and let the player join. */ }
    }
  }
  init();
})();
