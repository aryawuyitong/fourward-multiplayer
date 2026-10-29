import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import { GameService } from './service.js';
import { MemoryStore } from './stores.js';
import { createApi } from './api.js';
import { assetResponse, jsonResponse } from './headers.js';
import { GameError } from './game.js';

function socketError(error) {
  return error instanceof GameError
    ? { code: error.code, message: error.message }
    : { code: 'SERVER_ERROR', message: 'The server could not complete this request. Please try again.' };
}

export function createGameServer({ store = new MemoryStore() } = {}) {
  const service = new GameService(store);
  const api = createApi(service);
  const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));

  const server = createServer(async (req, res) => {
    try {
      const forwarded = req.headers['x-forwarded-proto']?.split(',')[0];
      const protocol = forwarded === 'https' ? 'https' : 'http';
      const url = new URL(req.url, `${protocol}://${req.headers.host || 'localhost'}`);
      let response;
      if (url.pathname === '/api/config') {
        response = jsonResponse({ transport: 'socket.io', pollInterval: 1000 });
      } else if (url.pathname === '/health') {
        response = jsonResponse({ ok: true, service: 'fourward', transport: 'socket.io' });
      } else if (url.pathname.startsWith('/api/')) {
        const options = { method: req.method, headers: req.headers };
        if (!['GET', 'HEAD'].includes(req.method)) {
          options.body = Readable.toWeb(req);
          options.duplex = 'half';
        }
        response = await api(new Request(url, options));
      } else if (['GET', 'HEAD'].includes(req.method)) {
        const asset = { '/': 'index.html', '/styles.css': 'styles.css', '/client.js': 'client.js' }[url.pathname];
        if (asset) response = assetResponse(url.pathname, req.method === 'HEAD' ? null : await readFile(resolve(publicRoot, asset), 'utf8'));
        else response = new Response(url.pathname === '/favicon.ico' ? null : 'Page not found', { status: url.pathname === '/favicon.ico' ? 204 : 404 });
      } else response = new Response('Method not allowed', { status: 405 });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('HTTP request failed:', error?.name || 'UnknownError');
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('The game service is temporarily unavailable. Please try again.');
    }
  });

  const io = new Server(server, {
    maxHttpBufferSize: 2048,
    serveClient: true,
    // Same-origin web clients only; native requests still require a seat token.
    allowRequest(req, callback) {
      const origin = req.headers.origin;
      if (!origin) return callback(null, true);
      try { callback(null, new URL(origin).host === req.headers.host); }
      catch { callback(null, false); }
    },
  });

  async function sendState(socket) {
    if (!socket.connected || !socket.data.session) return;
    const { code, token } = socket.data.session;
    try { socket.emit('state', (await service.state(code, token)).state); }
    catch (error) { socket.emit('session-error', socketError(error)); }
  }

  service.onChange = async code => {
    // `join` and `to` scope all updates to this game room, never the whole server.
    for (const socket of await io.in(code).fetchSockets()) await sendState(socket);
  };

  io.on('connection', socket => {
    socket.on('subscribe', async (payload, acknowledge = () => {}) => {
      if (typeof acknowledge !== 'function') return;
      try {
        const { state } = await service.state(payload?.code, payload?.token);
        if (socket.data.session) await socket.leave(socket.data.session.code);
        socket.data.session = { code: state.code, token: payload.token };
        await socket.join(state.code);
        acknowledge({ state });
      } catch (error) {
        acknowledge({ error: socketError(error) });
      }
    });
  });

  // Heartbeats keep only actually connected subscribers online and refresh presence.
  const heartbeat = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) void sendState(socket);
  }, 5000);
  heartbeat.unref();

  return {
    server, io, service,
    listen(port = 3000, host = '0.0.0.0') {
      return new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); accept(server.address()); });
      });
    },
    async close() {
      clearInterval(heartbeat);
      await new Promise(accept => io.close(accept));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const game = createGameServer();
  const address = await game.listen(Number(process.env.PORT) || 3000);
  console.log(`Fourward is ready at http://localhost:${address.port}`);
  console.log('Open this address on another device using your computer’s LAN IP, or use the public deployment.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await game.close(); process.exit(0); });
}
