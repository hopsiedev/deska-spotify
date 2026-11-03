import { RELAY, REPO, REF } from './relay.js';

const HOST = new URL(RELAY).host;
const $ = (id) => document.getElementById(id);

let pair = null;
let online = false;
let showPair = false;
let playing = false;
let coverKey = '';
let lastTrack = '';
let pos = 0;
let dur = 0;
let posAt = 0;
let seeking = false;
let volTimer = null;
let volHold = 0;
let lastExtras = '';
let tab = /Mac/i.test(navigator.userAgent) ? 'mac' : 'win';

const say = (t) => { $('msg').textContent = t || ''; };

// ---------- emparejamiento ----------
const randHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const randId = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

async function loadPair() {
  let p = await deska.storage.get('pair');
  if (!p || !/^[a-z0-9]{20}$/.test(p.id) || !/^[a-f0-9]{32}$/.test(p.secret)) {
    p = { id: randId(20), secret: randHex(16) };
    await deska.storage.set('pair', p);
  }
  return p;
}

const raw = (f) => `https://raw.githubusercontent.com/${REPO}/${REF}/installers/${f}`;
function command() {
  const code = `${pair.id}.${pair.secret}`;
  return tab === 'mac'
    ? `curl -fsSL ${raw('install.sh')} | DESKA_SPOTIFY_CODE='${code}' bash`
    : `$env:DESKA_SPOTIFY_CODE='${code}'; irm ${raw('install.ps1')} | iex`;
}

function renderPair() {
  $('tabWin').classList.toggle('on', tab === 'win');
  $('tabMac').classList.toggle('on', tab === 'mac');
  $('cmdBox').textContent = command();
}

function setView() {
  const pairing = !online || showPair;
  $('pair').hidden = !pairing;
  $('player').hidden = !online;
  $('closePair').hidden = !online;
  $('waiting').hidden = online;
  $('pairTitle').textContent = online ? 'Conectar otro PC' : (lastTrack ? 'Tu PC está desconectado' : 'Conecta tu PC');
}

$('tabWin').onclick = () => { tab = 'win'; renderPair(); };
$('tabMac').onclick = () => { tab = 'mac'; renderPair(); };
$('copy').onclick = async () => {
  try { await deska.clipboard.write(command()); say('Comando copiado: pégalo en tu terminal'); }
  catch { say('No se pudo copiar; selecciona el texto manualmente'); }
};
$('newCode').onclick = async () => {
  pair = { id: randId(20), secret: randHex(16) };
  await deska.storage.set('pair', pair);
  online = false;
  lastTrack = '';
  renderPair();
  setView();
  reconnect();
};
$('setup').onclick = () => { showPair = true; setView(); };
$('closePair').onclick = () => { showPair = false; setView(); };

// ---------- conexión con el relé ----------
// Base: sondeo cada pocos segundos (siempre funciona). Mejora: WebSocket; en cuanto llega su
// primer mensaje se deja de sondear, y si se cae o se cuelga se vuelve al sondeo.
let sock = null;
let wsLive = false;
let wsFails = 0;
let pollTimer = null;
let retryTimer = null;
let watchdog = null;
let pollTicks = 0;
let seq = 0;
const acks = new Map();

function setDiag(t) {
  $('waiting').textContent = t ? `Esperando a tu PC… (${t})` : 'Esperando a tu PC…';
}

function handle(m) {
  if (m.t === 'ack') {
    const f = acks.get(m.id);
    if (f) { acks.delete(m.id); f({ ok: m.ok, out: m.out }); }
  } else if (m.t === 'state') apply(m);
}

async function poll() {
  try {
    const r = await fetch(`${RELAY}/state/${pair.id}?k=${pair.secret}`);
    if (!r.ok) return setDiag(`el servidor respondió ${r.status}`);
    const m = await r.json();
    setDiag('');
    apply(m);
  } catch (e) {
    setDiag(`sin respuesta del servidor: ${(e && e.message) || e}`);
  }
}
function startPoll() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(() => {
    if (deska.visible === false) return;
    if (deska.idle && ++pollTicks % 4) return; // ventana sin foco: más espaciado
    poll();
  }, 2500);
}
function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

function openWs() {
  if (sock || !pair || deska.visible === false) return;
  let s;
  try { s = new WebSocket(`wss://${HOST}/ws/p/${pair.id}?k=${pair.secret}`); } catch { return; }
  sock = s;
  wsLive = false;
  let lastRx = Date.now();
  let dropped = false;
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { if (!wsLive) drop(); }, 5000);

  // Una conexión muerta (p. ej. se cayó el internet) no avisa: se detecta con el latido y se vuelve al sondeo.
  const drop = () => {
    if (dropped) return;
    dropped = true;
    clearInterval(pinger);
    clearTimeout(watchdog);
    if (sock === s) sock = null;
    wsLive = false;
    try { s.close(); } catch { /* ya cerrado */ }
    startPoll();
    wsFails++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(openWs, Math.min(2000 * 2 ** Math.min(wsFails, 5), 60000));
  };
  const pinger = setInterval(() => {
    if (Date.now() - lastRx > 25000) return drop();
    try { if (s.readyState === 1) s.send('ping'); } catch { drop(); }
  }, 10000);

  s.onmessage = (e) => {
    lastRx = Date.now();
    if (!wsLive) { wsLive = true; wsFails = 0; stopPoll(); }
    try { handle(JSON.parse(e.data)); } catch { /* "pong" u otro mensaje */ }
  };
  s.onclose = drop;
  s.onerror = drop;
}

function disconnect() {
  clearTimeout(retryTimer);
  clearTimeout(watchdog);
  stopPoll();
  if (sock) { const s = sock; sock = null; wsLive = false; try { s.close(); } catch { /* ya cerrado */ } }
}
function reconnect() { disconnect(); wsFails = 0; startPoll(); openWs(); }

async function cmd(c, a = '') {
  if (sock && wsLive && sock.readyState === 1) {
    const id = `p${(++seq).toString(36)}${randId(4)}`;
    const wait = new Promise((resolve) => {
      acks.set(id, resolve);
      setTimeout(() => { if (acks.delete(id)) resolve({ ok: false, out: 'timeout' }); }, 8000);
    });
    sock.send(JSON.stringify({ t: 'cmd', id, c, a }));
    const r = await wait;
    say(r.ok ? '' : r.out === 'offline' ? 'Tu PC no está conectado' : r.out === 'timeout' ? 'Tu PC no responde; reconectando…' : r.out);
    if (r.out === 'timeout') reconnect();
    return r;
  }
  try {
    const r = await (await fetch(`${RELAY}/cmd/${pair.id}?k=${pair.secret}&c=${c}&a=${encodeURIComponent(a)}`)).json();
    say(r.ok ? '' : r.out === 'offline' ? 'Tu PC no está conectado' : r.out === 'timeout' ? 'Tu PC no responde; reconectando…' : r.out);
    setTimeout(poll, 500);
    return r;
  } catch {
    say('Sin conexión con el servidor');
    return { ok: false, out: 'red' };
  }
}

// ---------- estado y reproductor ----------
function setPlaying(p) {
  playing = p;
  // `hidden` no es una propiedad de los elementos SVG: hay que usar el atributo.
  $('icPlay').toggleAttribute('hidden', p);
  $('icPause').toggleAttribute('hidden', !p);
}

function apply(m) {
  const was = online;
  online = m.online === true;
  const s = m.s || { run: false };
  if (online && s.run) {
    setPlaying(s.playing);
    pos = s.pos || 0;
    dur = s.dur || 0;
    posAt = Date.now();
    $('title').textContent = s.title || 'Spotify';
    $('artist').textContent = s.artist || '—';
    if (s.cover && s.cover !== coverKey) {
      coverKey = s.cover;
      $('cover').src = `${RELAY}/cover/${pair.id}?k=${pair.secret}&h=${s.cover}`;
    }
    if (Date.now() > volHold && s.vol != null) $('vol').value = s.vol;
    const track = `${s.artist} - ${s.title}`;
    if (track !== lastTrack) { lastTrack = track; deska.setTitle(track); }
  } else if (online) {
    $('title').textContent = 'Spotify cerrado';
    $('artist').textContent = 'Ábrelo en tu PC';
    setPlaying(false);
    pos = 0;
    dur = 0;
  }
  if (online !== was || !was) { setView(); if (!online) say(''); }
  tick();
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// La posición llega solo cuando cambia algo; entre medias se avanza con el reloj local.
function tick() {
  if (seeking) return;
  const now = Math.min(dur || Infinity, pos + (playing ? (Date.now() - posAt) / 1000 : 0));
  $('seek').max = dur || 1;
  $('seek').value = now;
  $('tPos').textContent = fmt(now);
  $('tLeft').textContent = dur ? `-${fmt(Math.max(0, dur - now))}` : '-0:00';
  const state = online ? `${$('artist').textContent} · ${$('title').textContent}` : 'PC desconectado';
  const key = `${state}|${playing}|${Math.round(now / 5)}`;
  if (key !== lastExtras) {
    lastExtras = key;
    try { deska.extras.set({ state, progress: online && dur ? now / dur : null, control: online ? (playing ? 'pause' : 'play') : null }).catch(() => {}); } catch { /* sin Extras */ }
  }
}
setInterval(tick, 250);

$('cover').onload = () => { $('cover').hidden = false; $('coverPh').hidden = true; };
$('cover').onerror = () => { $('cover').hidden = true; $('coverPh').hidden = false; };

// Feedback inmediato: animación de pulsación y estado "ocupado" hasta que responde el PC.
async function press(btn, fn) {
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop', 'busy');
  try { await fn(); } finally { btn.classList.remove('busy'); }
}

$('toggle').onclick = (e) => press(e.currentTarget, async () => { setPlaying(!playing); posAt = Date.now(); await cmd('toggle'); });
$('next').onclick = (e) => press(e.currentTarget, () => cmd('next'));
$('prev').onclick = (e) => press(e.currentTarget, () => cmd('prev'));
$('vol').oninput = () => {
  volHold = Date.now() + 2500;
  clearTimeout(volTimer);
  volTimer = setTimeout(() => cmd('volume', $('vol').value), 120);
};
$('seek').oninput = () => { seeking = true; $('tPos').textContent = fmt(+$('seek').value); };
$('seek').onchange = async () => {
  pos = +$('seek').value;
  posAt = Date.now();
  seeking = false;
  await cmd('seek', pos.toFixed(1));
};

// Botón redondo de la fila en Extras: reproduce o pausa.
deska.on('extras.control', () => { if (online) { setPlaying(!playing); posAt = Date.now(); cmd('toggle'); } });
// Con el panel oculto se cierra la conexión para no gastar peticiones.
window.addEventListener('online', () => reconnect()); // volvió el internet
deska.on('visibility', () => { if (deska.visible === false) disconnect(); else reconnect(); });

deska.ready().then(async () => {
  pair = await loadPair();
  renderPair();
  setView();
  reconnect();
});
