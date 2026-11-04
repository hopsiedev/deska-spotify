import { RELAY, REPO, REF, VERSION, INSTALLER_HASH } from './relay.js';

const HOST = new URL(RELAY).host;
const $ = (id) => document.getElementById(id);

let pair = null;
let online = false;
let showPair = false;
let playing = false;
let coverKey = '';
let currentCoverUrl = '';
let lastTrack = '';
let pos = 0;
let dur = 0;
let posAt = 0;
let seeking = false;
let volTimer = null;
let volHold = 0;
let lastExtras = '';

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

function command() {
  const code = `${pair.id}.${pair.secret}`;
  return `$env:DESKA_SPOTIFY_CODE='${code}'; $f="$env:TEMP\\deska-install.ps1"; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest 'https://raw.githubusercontent.com/${REPO}/${REF}/installers/install.ps1' -OutFile $f -UseBasicParsing; if ((Get-FileHash $f -Algorithm SHA256).Hash -ne '${INSTALLER_HASH}') { Remove-Item $f -Force; throw 'SHA-256 del instalador no coincide' }; & $f; Remove-Item $f -Force`;
}

function uninstCommand() {
  return `irm https://raw.githubusercontent.com/${REPO}/${REF}/installers/uninstall.ps1 | iex`;
}

function renderPair() {
  $('cmdBox').textContent = command();
  $('uninstBox').textContent = uninstCommand();
}

function setView() {
  const pairing = !online || showPair;
  $('pair').hidden = !pairing;
  $('player').hidden = !online;
  $('closePair').hidden = !online;
  $('waiting').hidden = online;
  $('pairTitle').textContent = online ? 'Configuración del PC' : (lastTrack ? 'Tu PC está desconectado' : 'Conecta tu PC');
}

$('copy').onclick = async () => {
  try {
    await deska.clipboard.write(command());
    say('Comando copiado: pégalo en PowerShell en tu PC');
  } catch {
    say('No se pudo copiar; selecciona el texto manualmente');
  }
};

$('copyUninst').onclick = async () => {
  try {
    await deska.clipboard.write(uninstCommand());
    say('Comando de desinstalación copiado al portapapeles');
  } catch {
    say('No se pudo copiar; selecciona el texto manualmente');
  }
};

$('newCode').onclick = async () => {
  const old = pair;
  if (old?.id && old?.secret) {
    try {
      await fetch(`${RELAY}/revoke/${old.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${old.secret}` }
      });
    } catch {
      // Ignorar fallo de red si el relé o internet no están disponibles
    }
  }
  pair = { id: randId(20), secret: randHex(16) };
  await deska.storage.set('pair', pair);
  online = false;
  lastTrack = '';
  coverKey = '';
  if (currentCoverUrl) {
    URL.revokeObjectURL(currentCoverUrl);
    currentCoverUrl = '';
  }
  renderPair();
  setView();
  reconnect();
};

$('setup').onclick = () => { showPair = true; setView(); };
$('closePair').onclick = () => { showPair = false; setView(); };

// ---------- conexión con el relé ----------
// Base: sondeo cada pocos segundos. Mejora: WebSocket con auth en el primer frame.
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
  if (!pair) return;
  try {
    const r = await fetch(`${RELAY}/state/${pair.id}`, {
      headers: { Authorization: `Bearer ${pair.secret}` }
    });
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
    if (deska.idle && ++pollTicks % 4) return;
    poll();
  }, 2500);
}
function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

function openWs() {
  if (sock || !pair || deska.visible === false) return;
  let s;
  try { s = new WebSocket(`wss://${HOST}/ws/p/${pair.id}`); } catch { return; }
  sock = s;
  wsLive = false;
  let lastRx = Date.now();
  let dropped = false;
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { if (!wsLive) drop(); }, 6000);

  const drop = () => {
    if (dropped) return;
    dropped = true;
    clearInterval(pinger);
    clearTimeout(watchdog);
    if (sock === s) sock = null;
    wsLive = false;
    try { s.close(); } catch {}
    startPoll();
    wsFails++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(openWs, Math.min(2000 * 2 ** Math.min(wsFails, 5), 60000));
  };

  const pinger = setInterval(() => {
    if (Date.now() - lastRx > 25000) return drop();
    try { if (s.readyState === 1) s.send('ping'); } catch { drop(); }
  }, 10000);

  s.onopen = () => {
    // Autenticación por mensaje (secreto fuera de la URL)
    try { s.send(JSON.stringify({ t: 'auth', k: pair.secret })); } catch { drop(); }
  };

  s.onmessage = (e) => {
    lastRx = Date.now();
    let data;
    try { data = JSON.parse(e.data); } catch { return; } // pong u otro
    if (data.t === 'auth') {
      if (data.ok) {
        if (!wsLive) { wsLive = true; wsFails = 0; stopPoll(); }
      } else {
        drop();
      }
      return;
    }
    if (!wsLive) { wsLive = true; wsFails = 0; stopPoll(); }
    handle(data);
  };
  s.onclose = drop;
  s.onerror = drop;
}

function disconnect() {
  clearTimeout(retryTimer);
  clearTimeout(watchdog);
  stopPoll();
  if (sock) { const s = sock; sock = null; wsLive = false; try { s.close(); } catch {} }
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
    const res = await fetch(`${RELAY}/cmd/${pair.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pair.secret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ c, a })
    });
    const r = await res.json();
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
  $('icPlay').toggleAttribute('hidden', p);
  $('icPause').toggleAttribute('hidden', !p);
}

function restoreCached() {
  try {
    const raw = sessionStorage.getItem('deska_spotify_state');
    if (raw) {
      const m = JSON.parse(raw);
      if (m && m.s) apply(m);
    }
  } catch {}
}

async function loadCover(hash) {
  if (!pair) return;
  try {
    const res = await fetch(`${RELAY}/cover/${pair.id}`, {
      headers: { Authorization: `Bearer ${pair.secret}` }
    });
    if (!res.ok) throw new Error('cover');
    const blob = await res.blob();
    if (currentCoverUrl) URL.revokeObjectURL(currentCoverUrl);
    currentCoverUrl = URL.createObjectURL(blob);
    $('cover').src = currentCoverUrl;
  } catch {
    $('cover').hidden = true;
    $('coverPh').hidden = false;
  }
}

function apply(m) {
  const was = online;
  online = m.online === true;
  const s = m.s || { run: false };
  if (online && s.run) {
    try { sessionStorage.setItem('deska_spotify_state', JSON.stringify(m)); } catch {}
    setPlaying(s.playing);
    pos = s.pos || 0;
    dur = s.dur || 0;
    posAt = Date.now();
    $('title').textContent = s.title || 'Spotify';
    $('artist').textContent = s.artist || '—';
    if (s.cover && s.cover !== coverKey) {
      coverKey = s.cover;
      loadCover(s.cover);
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
    try { deska.extras.set({ state, progress: online && dur ? now / dur : null, control: online ? (playing ? 'pause' : 'play') : null }).catch(() => {}); } catch {}
  }
}
setInterval(tick, 250);
setInterval(() => { if (wsLive && deska.visible !== false) poll(); }, 20000);

$('cover').onload = () => { $('cover').hidden = false; $('coverPh').hidden = true; };
$('cover').onerror = () => { $('cover').hidden = true; $('coverPh').hidden = false; };

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

deska.on('extras.control', () => { if (online) { setPlaying(!playing); posAt = Date.now(); cmd('toggle'); } });
window.addEventListener('online', () => reconnect());
try { deska.on('place', (p) => document.body.classList.toggle('is-extras', p === 'extras' || deska.place === 'extras')); } catch {}
deska.on('visibility', () => { if (deska.visible === false) disconnect(); else reconnect(); });

deska.ready().then(async (ctx) => {
  if (deska.place === 'extras' || ctx?.place === 'extras') document.body.classList.add('is-extras');
  restoreCached();
  $('ver').textContent = `v${VERSION}`;
  pair = await loadPair();
  renderPair();
  setView();
  reconnect();
});
