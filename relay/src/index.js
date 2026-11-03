// Relé de Spotify para Deska.
// Une el panel (sandbox de Deska) con el companion que corre en el PC de cada persona.
// Un Durable Object por pareja (id), con WebSockets hibernables para no gastar tiempo en reposo.
import { DurableObject } from 'cloudflare:workers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const ROUTE = /^\/(ws\/c|ws\/p|state|cmd|cover)\/([a-z0-9]{16,32})$/;
const MAX_WS_MESSAGE = 800_000;
const MAX_COVER_B64 = 600_000;
const ACK_TIMEOUT_MS = 8000;
const IDLE_DELETE_MS = 30 * 24 * 3600 * 1000;

export function validCmd(c, a) {
  switch (c) {
    case 'status': case 'toggle': case 'pause': case 'resume': case 'next': case 'prev':
      return a === '';
    case 'volume':
      return /^\d{1,3}$/.test(a) && Number(a) <= 100;
    case 'seek':
      return /^\d{1,5}(\.\d)?$/.test(a);
    default:
      return false;
  }
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) ? v : 0);
export function cleanState(s) {
  if (!s || typeof s !== 'object') return { run: false };
  return {
    run: s.run === true,
    playing: s.playing === true,
    title: str(s.title, 200),
    artist: str(s.artist, 200),
    album: str(s.album, 200),
    pos: num(s.pos),
    dur: num(s.dur),
    vol: Number.isFinite(s.vol) ? Math.max(0, Math.min(100, s.vol)) : null,
    cover: str(s.cover, 32),
  };
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/') return json({ ok: true, service: 'deska-spotify-relay' });
    const m = url.pathname.match(ROUTE);
    if (!m) return json({ ok: false, out: 'not found' }, 404);
    if (!/^[a-f0-9]{32,64}$/.test(url.searchParams.get('k') || '')) return json({ ok: false, out: 'auth' }, 401);
    return env.HUB.get(env.HUB.idFromName(m[2])).fetch(req);
  },
};

export class Hub extends DurableObject {
  pending = new Map(); // peticiones HTTP esperando el ack del companion
  hits = [];
  lastTouch = 0;

  constructor(ctx, env) {
    super(ctx, env);
    // Latido: el cliente envía "ping" y el relé responde "pong" sin despertar al objeto.
    // Así ambos lados detectan una conexión muerta (p. ej. tras caerse el internet).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async auth(k) {
    const hash = await sha256Hex(k);
    const stored = await this.ctx.storage.get('h');
    if (!stored) { await this.ctx.storage.put('h', hash); return true; } // el primero que se presenta fija la clave
    const a = new TextEncoder().encode(stored);
    const b = new TextEncoder().encode(hash);
    return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
  }

  async touch() {
    const now = Date.now();
    if (now - this.lastTouch < 3600_000) return;
    this.lastTouch = now;
    await this.ctx.storage.setAlarm(now + IDLE_DELETE_MS);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) return this.ctx.storage.setAlarm(Date.now() + IDLE_DELETE_MS);
    await this.ctx.storage.deleteAll();
  }

  online() { return this.ctx.getWebSockets('c').length > 0; }

  async snapshot() {
    const st = (await this.ctx.storage.get('state')) || { s: { run: false }, rev: 0 };
    return { t: 'state', online: this.online(), rev: st.rev, s: st.s };
  }

  async broadcast(extra) {
    const msg = JSON.stringify(extra || (await this.snapshot()));
    for (const w of this.ctx.getWebSockets('p')) { try { w.send(msg); } catch { /* socket cerrado */ } }
  }

  rateOk() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 5000);
    if (this.hits.length >= 40) return false;
    this.hits.push(now);
    return true;
  }

  async forward(cid, c, a) {
    const comp = this.ctx.getWebSockets('c')[0];
    if (!comp) return false;
    comp.send(JSON.stringify({ t: 'cmd', id: cid, c, a }));
    return true;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, kind] = url.pathname.match(ROUTE);
    if (!(await this.auth(url.searchParams.get('k')))) return json({ ok: false, out: 'auth' }, 401);
    await this.touch();

    if (kind === 'ws/c' || kind === 'ws/p') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ ok: false, out: 'websocket' }, 426);
      const { 0: client, 1: server } = new WebSocketPair();
      if (kind === 'ws/c') {
        for (const w of this.ctx.getWebSockets('c')) { try { w.close(4000, 'replaced'); } catch { /* ya cerrado */ } }
        this.ctx.acceptWebSocket(server, ['c']);
        await this.broadcast();
      } else {
        const panels = this.ctx.getWebSockets('p');
        while (panels.length >= 5) { try { panels.shift().close(4001, 'too many'); } catch { /* ya cerrado */ } }
        this.ctx.acceptWebSocket(server, ['p']);
        server.send(JSON.stringify(await this.snapshot()));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (kind === 'state') return json(await this.snapshot());

    if (kind === 'cover') {
      const cv = await this.ctx.storage.get('cover');
      if (!cv) return json({ ok: false }, 404);
      const bin = Uint8Array.from(atob(cv.b64), (ch) => ch.charCodeAt(0));
      const type = bin[0] === 0x89 ? 'image/png' : 'image/jpeg';
      return new Response(bin, { headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
    }

    // kind === 'cmd'
    const c = url.searchParams.get('c') || '';
    const a = url.searchParams.get('a') || '';
    if (!validCmd(c, a)) return json({ ok: false, out: 'comando no válido' }, 400);
    if (!this.rateOk()) return json({ ok: false, out: 'demasiadas peticiones' }, 429);
    const cid = `h${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(cid); resolve({ ok: false, out: 'timeout' }); }, ACK_TIMEOUT_MS);
      this.pending.set(cid, (r) => { clearTimeout(timer); resolve(r); });
    });
    if (!(await this.forward(cid, c, a))) { this.pending.delete(cid); return json({ ok: false, out: 'offline' }, 503); }
    return json(await result);
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_WS_MESSAGE) return ws.close(1009, 'mensaje no válido');
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const tags = this.ctx.getTags(ws);

    if (tags.includes('c')) {
      if (msg.t === 'state') {
        const prev = (await this.ctx.storage.get('state')) || { rev: 0 };
        await this.ctx.storage.put('state', { s: cleanState(msg.s), rev: prev.rev + 1 });
        await this.broadcast();
      } else if (msg.t === 'cover') {
        if (typeof msg.b64 === 'string' && msg.b64.length <= MAX_COVER_B64 && /^[A-Za-z0-9+/=]+$/.test(msg.b64)) {
          await this.ctx.storage.put('cover', { hash: str(msg.hash, 32), b64: msg.b64 });
        }
      } else if (msg.t === 'ack' && typeof msg.id === 'string') {
        const done = this.pending.get(msg.id);
        const out = { t: 'ack', id: msg.id.slice(0, 16), ok: msg.ok === true, out: str(msg.out, 200) };
        if (done) { this.pending.delete(msg.id); done({ ok: out.ok, out: out.out }); } else await this.broadcast(out);
      }
      return;
    }

    if (tags.includes('p') && msg.t === 'cmd') {
      const id = typeof msg.id === 'string' && /^[a-z0-9]{1,16}$/.test(msg.id) ? msg.id : '';
      const c = typeof msg.c === 'string' ? msg.c : '';
      const a = typeof msg.a === 'string' ? msg.a : '';
      if (!id) return;
      if (!validCmd(c, a)) return ws.send(JSON.stringify({ t: 'ack', id, ok: false, out: 'comando no válido' }));
      if (!this.rateOk()) return ws.send(JSON.stringify({ t: 'ack', id, ok: false, out: 'demasiadas peticiones' }));
      if (!(await this.forward(id, c, a))) ws.send(JSON.stringify({ t: 'ack', id, ok: false, out: 'offline' }));
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* ya cerrado */ }
    if (this.ctx.getTags(ws).includes('c')) await this.broadcast();
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }
}
