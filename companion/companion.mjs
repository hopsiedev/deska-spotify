// Companion de Spotify para Deska: corre en el PC de la persona, se conecta (solo saliente) al relé
// y traduce los comandos del panel a la app de escritorio de Spotify.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(process.env.DESKA_SPOTIFY_CONFIG || path.join(dir, 'config.json'), 'utf8'));
const dataDir = process.env.DESKA_SPOTIFY_DATA || dir;
if (!/^[a-z0-9]{16,32}$/.test(cfg.id) || !/^[a-f0-9]{32,64}$/.test(cfg.secret)) throw new Error('config.json: código de emparejamiento no válido');
const wsUrl = `${cfg.relay.replace(/^http/, 'ws').replace(/\/$/, '')}/ws/c/${cfg.id}`;

const platform = os.platform();
if (platform !== 'win32') throw new Error(`Sistema no compatible: ${platform}. Esta versión es solo para Windows.`);
const { createAdapter } = await import('./adapters/windows.mjs');
const adapter = createAdapter({ dir, dataDir });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Misma lista cerrada que el relé: nunca se ejecuta nada fuera de ella.
function validCmd(c, a) {
  switch (c) {
    case 'status': case 'toggle': case 'pause': case 'resume': case 'next': case 'prev': return a === '';
    case 'volume': return /^\d{1,3}$/.test(a) && Number(a) <= 100;
    case 'seek': return /^\d{1,5}(\.\d)?$/.test(a);
    default: return false;
  }
}

let ws = null;
let backoff = 1000;
let lastSent = null;
let lastSentAt = 0;
let sentCover = '';
let busy = false;
let authed = false;

const send = (obj) => { if (ws && ws.readyState === 1 && authed) { ws.send(JSON.stringify(obj)); return true; } return false; };

function changed(s) {
  if (!lastSent) return true;
  for (const k of ['run', 'playing', 'title', 'artist', 'album', 'dur', 'vol', 'cover']) if (s[k] !== lastSent[k]) return true;
  const expected = lastSent.pos + (lastSent.playing ? (Date.now() - lastSentAt) / 1000 : 0);
  if (Math.abs(s.pos - expected) > 2.5) return true; // salto de posición (seek)
  return Date.now() - lastSentAt > 15000; // latido: corrige la deriva de la barra
}

async function pushState(force = false) {
  if (busy || !ws || ws.readyState !== 1 || !authed) return;
  busy = true;
  try {
    const s = await adapter.status();
    if (!force && !changed(s)) return;
    if (s.run && s.cover && s.cover !== sentCover) {
      const img = await adapter.cover().catch(() => null);
      if (img && img.length > 0 && img.length < 440_000) send({ t: 'cover', hash: s.cover, b64: Buffer.from(img).toString('base64') });
      sentCover = s.cover;
    }
    if (send({ t: 'state', s })) { lastSent = s; lastSentAt = Date.now(); }
  } catch (e) {
    log('estado:', e.message);
  } finally {
    busy = false;
  }
}

async function onCommand({ id, c, a }) {
  if (typeof id !== 'string' || !validCmd(c, a)) return send({ t: 'ack', id: String(id).slice(0, 16), ok: false, out: 'comando no válido' });
  try {
    if (c !== 'status') await adapter.command(c, a);
    send({ t: 'ack', id, ok: true, out: '' });
  } catch (e) {
    send({ t: 'ack', id, ok: false, out: String(e.message || e).slice(0, 200) });
  }
  setTimeout(() => pushState(true), 250);
  setTimeout(() => pushState(true), 1200);
}

function connect() {
  log('conectando al relé…');
  authed = false;
  const s = new WebSocket(wsUrl);
  ws = s;
  let lastRx = Date.now();
  let pinger = null;
  let dropped = false;
  const connTimer = setTimeout(() => drop('no se pudo conectar'), 10000);

  // Pasa a "desconectado" una sola vez, aunque el socket viejo tarde en avisar (internet caído).
  const drop = (why) => {
    if (dropped) return;
    dropped = true;
    authed = false;
    clearTimeout(connTimer);
    clearInterval(pinger);
    if (ws === s) ws = null;
    try { s.close(); } catch { /* ya cerrado */ }
    const wait = backoff + Math.random() * 500;
    backoff = Math.min(backoff * 2, 30000);
    log(`desconectado (${why}); reintento en ${Math.round(wait / 1000)} s`);
    setTimeout(connect, wait);
  };

  s.onopen = () => {
    clearTimeout(connTimer);
    log('conectado al relé, enviando autenticación…');
    backoff = 1000;
    lastRx = Date.now();
    lastSent = null;
    sentCover = '';
    // Autenticación por mensaje (secreto fuera de la URL)
    s.send(JSON.stringify({ t: 'auth', k: cfg.secret }));
    // Latido cada 10 s; si el relé no responde en 30 s la conexión está muerta.
    pinger = setInterval(() => {
      if (Date.now() - lastRx > 30000) return drop('sin respuesta del relé');
      try { s.send('ping'); } catch { drop('error al enviar'); }
    }, 10000);
  };
  s.onmessage = (ev) => {
    lastRx = Date.now();
    let m;
    try { m = JSON.parse(String(ev.data)); } catch { return; } // "pong" u otro mensaje plano
    if (m.t === 'auth') {
      if (m.ok) {
        log('autenticado');
        authed = true;
        pushState(true);
      } else {
        log('autenticación rechazada por el relé');
        drop('auth rechazada');
      }
      return;
    }
    if (m.t === 'cmd') onCommand(m);
  };
  s.onclose = () => drop('cerrado');
  s.onerror = () => drop('error');
}

connect();
setInterval(() => pushState(false), 1000);
process.on('SIGTERM', () => { adapter.close?.(); process.exit(0); });
process.on('exit', () => adapter.close?.());
