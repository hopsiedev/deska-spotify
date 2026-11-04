// Relé de Spotify para Deska.
// Une el panel (sandbox de Deska) con el companion que corre en el PC de cada persona.
// Un Durable Object por pareja (id), con WebSockets hibernables para no gastar tiempo en reposo.
import { DurableObject } from 'cloudflare:workers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-secret',
};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const ROUTE = /^\/(ws\/c|ws\/p|state|cmd|cover|revoke)\/([a-z0-9]{16,32})$/;
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

export function extractSecret(req) {
  const auth = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const x = req.headers.get('x-secret');
  if (x) return x.trim();
  const url = new URL(req.url);
  const q = url.searchParams.get('k');
  if (q) return q.trim();
  return null;
}

// Limitador de tasa por IP en la entrada del Worker
const ipHits = new Map();
function ipRateOk(ip) {
  const now = Date.now();
  let hits = ipHits.get(ip) || [];
  hits = hits.filter((t) => now - t < 10000);
  if (hits.length >= 120) return false;
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 2000) {
    for (const [k, v] of ipHits) if (!v.length || now - v[v.length - 1] > 10000) ipHits.delete(k);
  }
  return true;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/') return json({ ok: true, service: 'deska-spotify-relay' });

    const m = url.pathname.match(ROUTE);
    if (!m) return json({ ok: false, out: 'not found' }, 404);

    const clientIp = req.headers.get('cf-connecting-ip') || '127.0.0.1';
    if (!ipRateOk(clientIp)) {
      return json({ ok: false, out: 'demasiadas peticiones' }, 429, { 'Retry-After': '5' });
    }

    const kind = m[1];
    // Para WebSocket, el secreto ya no va en la URL; se autentica en el primer frame WS
    const isWs = kind === 'ws/c' || kind === 'ws/p';
    if (!isWs) {
      const secret = extractSecret(req);
      if (!secret || !/^[a-f0-9]{32,64}$/.test(secret)) {
        return json({ ok: false, out: 'auth' }, 401);
      }
    }

    return env.HUB.get(env.HUB.idFromName(m[2])).fetch(req);
  },
};

export class Hub extends DurableObject {
  pending = new Map(); // peticiones HTTP esperando el ack del companion
  hits = [];           // historial general de peticiones HTTP en este Hub
  cmdHits = [];        // historial de comandos
  authFails = [];      // intentos fallidos de autenticación (fuerza bruta)
  lastTouch = 0;

  constructor(ctx, env) {
    super(ctx, env);
    // Latido: el cliente envía "ping" y el relé responde "pong" sin despertar al objeto.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async auth(k) {
    if (!k || typeof k !== 'string' || !/^[a-f0-9]{32,64}$/.test(k)) return false;
    const now = Date.now();
    this.authFails = this.authFails.filter((t) => now - t < 60000);
    if (this.authFails.length >= 6) return false;

    const hash = await sha256Hex(k);
    const stored = await this.ctx.storage.get('h');
    if (!stored) {
      await this.ctx.storage.put('h', hash);
      return true; // el primero que se presenta fija la clave
    }
    const a = new TextEncoder().encode(stored);
    const b = new TextEncoder().encode(hash);
    const ok = a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
    if (!ok) this.authFails.push(now);
    return ok;
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

  // El companion envía "ping" cada 10 s; si lleva más de 40 s callado se considera caído.
  alive(w) {
    const ts = this.ctx.getWebSocketAutoResponseTimestamp(w);
    let since = 0;
    try { since = w.deserializeAttachment()?.t || 0; } catch { /* sin adjunto */ }
    return Date.now() - Math.max(ts ? ts.getTime() : 0, since) < 40000;
  }

  online() {
    return this.ctx.getWebSockets('c').some((w) => {
      const att = w.deserializeAttachment();
      return att?.authed && this.alive(w);
    });
  }

  // `closing`: socket que se está cerrando; sigue figurando en getWebSockets() y no debe contar como conectado.
  async snapshot(closing) {
    const st = (await this.ctx.storage.get('state')) || { s: { run: false }, rev: 0 };
    const online = this.ctx.getWebSockets('c').some((w) => {
      if (w === closing) return false;
      const att = w.deserializeAttachment();
      return att?.authed && this.alive(w);
    });
    return { t: 'state', online, rev: st.rev, s: st.s };
  }

  async broadcast(extra, closing) {
    const msg = JSON.stringify(extra || (await this.snapshot(closing)));
    for (const w of this.ctx.getWebSockets('p')) {
      const att = w.deserializeAttachment();
      if (!att?.authed) continue;
      try { w.send(msg); } catch { /* socket cerrado */ }
    }
  }

  // Limitación de tasa para peticiones generales al Hub (60 peticiones cada 10 s)
  rateOk() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 10000);
    if (this.hits.length >= 60) return false;
    this.hits.push(now);
    return true;
  }

  // Limitación de tasa específica para comandos (15 comandos cada 5 s)
  cmdRateOk() {
    const now = Date.now();
    this.cmdHits = this.cmdHits.filter((t) => now - t < 5000);
    if (this.cmdHits.length >= 15) return false;
    this.cmdHits.push(now);
    return true;
  }

  async forward(cid, c, a) {
    const comp = this.ctx.getWebSockets('c').find((w) => {
      const att = w.deserializeAttachment();
      return att?.authed && this.alive(w);
    });
    if (!comp) return false;
    comp.send(JSON.stringify({ t: 'cmd', id: cid, c, a }));
    return true;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const match = url.pathname.match(ROUTE);
    if (!match) return json({ ok: false, out: 'not found' }, 404);
    const kind = match[1];

    if (!this.rateOk()) {
      return json({ ok: false, out: 'demasiadas peticiones' }, 429, { 'Retry-After': '5' });
    }

    // 1) Revocación de pareja ("Nuevo código"): limpia datos y desconecta sockets de inmediato
    if (kind === 'revoke') {
      const secret = extractSecret(req);
      if (!(await this.auth(secret))) return json({ ok: false, out: 'auth' }, 401);

      for (const w of this.ctx.getWebSockets()) {
        try { w.close(4003, 'revoked'); } catch {}
      }
      try { await this.ctx.storage.deleteAlarm(); } catch {}
      await this.ctx.storage.deleteAll();
      return json({ ok: true, revoked: true });
    }

    // 2) Conexiones WebSocket: se aceptan y se autentican en el primer mensaje
    if (kind === 'ws/c' || kind === 'ws/p') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ ok: false, out: 'websocket' }, 426);
      const { 0: client, 1: server } = new WebSocketPair();

      if (kind === 'ws/c') {
        this.ctx.acceptWebSocket(server, ['c']);
        server.serializeAttachment({ authed: false, kind: 'c', t: Date.now() });
      } else {
        const panels = this.ctx.getWebSockets('p');
        while (panels.length >= 5) {
          try { panels.shift().close(4001, 'too many'); } catch {}
        }
        this.ctx.acceptWebSocket(server, ['p']);
        server.serializeAttachment({ authed: false, kind: 'p', t: Date.now() });
      }
      await this.touch();
      return new Response(null, { status: 101, webSocket: client });
    }

    // 3) HTTP endpoints autenticados por cabecera
    const secret = extractSecret(req);
    if (!(await this.auth(secret))) return json({ ok: false, out: 'auth' }, 401);
    await this.touch();

    if (kind === 'state') return json(await this.snapshot());

    if (kind === 'cover') {
      const cv = await this.ctx.storage.get('cover');
      if (!cv) return json({ ok: false }, 404);
      const bin = Uint8Array.from(atob(cv.b64), (ch) => ch.charCodeAt(0));
      const type = bin[0] === 0x89 ? 'image/png' : 'image/jpeg';
      return new Response(bin, { headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'private, no-cache' } });
    }

    if (kind === 'cmd') {
      let c = '';
      let a = '';
      if (req.method === 'POST') {
        try {
          const body = await req.json();
          c = String(body.c || '');
          a = String(body.a || '');
        } catch {
          return json({ ok: false, out: 'cuerpo no válido' }, 400);
        }
      } else {
        c = url.searchParams.get('c') || '';
        a = url.searchParams.get('a') || '';
      }

      if (!validCmd(c, a)) return json({ ok: false, out: 'comando no válido' }, 400);
      if (!this.cmdRateOk()) return json({ ok: false, out: 'demasiadas peticiones' }, 429, { 'Retry-After': '5' });

      const cid = `h${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const result = new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(cid); resolve({ ok: false, out: 'timeout' }); }, ACK_TIMEOUT_MS);
        this.pending.set(cid, (r) => { clearTimeout(timer); resolve(r); });
      });
      if (!(await this.forward(cid, c, a))) {
        this.pending.delete(cid);
        return json({ ok: false, out: 'offline' }, 503);
      }
      return json(await result);
    }

    return json({ ok: false, out: 'not found' }, 404);
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_WS_MESSAGE) return ws.close(1009, 'mensaje no válido');
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    const att = ws.deserializeAttachment() || {};

    // 1) Manejo de autenticación en el primer mensaje
    if (!att.authed) {
      if (msg.t === 'auth') {
        const ok = await this.auth(msg.k);
        if (ok) {
          ws.serializeAttachment({ ...att, authed: true, t: Date.now() });
          try { ws.send(JSON.stringify({ t: 'auth', ok: true })); } catch {}

          if (att.kind === 'c') {
            // Desconectar otros companions previos
            for (const other of this.ctx.getWebSockets('c')) {
              if (other !== ws) {
                try { other.close(4000, 'replaced'); } catch {}
              }
            }
            await this.broadcast();
          } else if (att.kind === 'p') {
            try { ws.send(JSON.stringify(await this.snapshot())); } catch {}
          }
        } else {
          try { ws.send(JSON.stringify({ t: 'auth', ok: false })); } catch {}
          ws.close(4401, 'auth failed');
        }
      } else {
        // Mensaje no permitido sin autenticar
        ws.close(4401, 'unauthorized');
      }
      return;
    }

    // 2) Companion autenticado
    if (att.kind === 'c') {
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

    // 3) Panel autenticado
    if (att.kind === 'p' && msg.t === 'cmd') {
      const id = typeof msg.id === 'string' && /^[a-z0-9]{1,16}$/.test(msg.id) ? msg.id : '';
      const c = typeof msg.c === 'string' ? msg.c : '';
      const a = typeof msg.a === 'string' ? msg.a : '';
      if (!id) return;
      if (!validCmd(c, a)) return ws.send(JSON.stringify({ t: 'ack', id, ok: false, out: 'comando no válido' }));
      if (!this.cmdRateOk()) return ws.send(JSON.stringify({ t: 'ack', id, ok: false, out: 'demasiadas peticiones' }));
      if (!(await this.forward(id, c, a))) ws.send(JSON.stringify({ t: 'ack', id, ok: false, out: 'offline' }));
    }
  }

  async webSocketClose(ws) {
    let wasAuthedCompanion = false;
    try {
      const att = ws.deserializeAttachment();
      wasAuthedCompanion = att?.authed && att?.kind === 'c';
    } catch {}
    try { ws.close(); } catch {}
    if (wasAuthedCompanion) await this.broadcast(null, ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
