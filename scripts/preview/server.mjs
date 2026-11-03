// Vista previa local del panel con un SDK de Deska simulado y un relé de mentira (para capturas y pruebas visuales).
//   node scripts/preview/server.mjs   →  http://127.0.0.1:4173/index.html?theme=dark&scene=playing
// Escenas: playing | paused | offline.  Temas: dark | light.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = path.resolve(here, '../../panel');
const PORT = 4173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const TOKENS = {
  dark: { bg: 'rgb(18,18,20)', surface: 'rgb(30,31,35)', 'surface-raised': 'rgb(42,43,49)', text: 'rgb(236,236,240)', 'text-secondary': 'rgb(170,172,182)', 'text-tertiary': 'rgb(120,122,132)', accent: 'rgb(29,185,84)', 'on-accent': 'rgb(0,0,0)', border: 'rgb(52,53,60)', focus: 'rgb(29,185,84)', danger: 'rgb(230,107,79)', success: 'rgb(29,185,84)' },
  light: { bg: 'rgb(246,247,249)', surface: 'rgb(255,255,255)', 'surface-raised': 'rgb(238,239,243)', text: 'rgb(24,26,31)', 'text-secondary': 'rgb(88,92,104)', 'text-tertiary': 'rgb(130,134,146)', accent: 'rgb(29,185,84)', 'on-accent': 'rgb(0,0,0)', border: 'rgb(214,216,222)', focus: 'rgb(18,140,62)', danger: 'rgb(190,60,40)', success: 'rgb(18,140,62)' },
};

const sdk = `
(() => {
  const q = new URLSearchParams(location.search);
  const mode = q.get('theme') === 'light' ? 'light' : 'dark';
  const tokens = ${JSON.stringify(TOKENS)}[mode];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty('--deska-' + k, v);
  root.style.colorScheme = mode;
  const scene = q.get('scene') || 'playing';
  const id = (scene + '00000000000000000000').slice(0, 20);
  const store = new Map([['pair', { id, secret: '0123456789abcdef0123456789abcdef' }]]);
  window.deska = {
    visible: true, idle: false, theme: { mode, tokens },
    ready: async () => ({ place: 'panel', theme: { mode, tokens } }),
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => (store.set(k, v), true), remove: async (k) => (store.delete(k), true), keys: async () => [...store.keys()] },
    setTitle: async () => true, on: () => () => {},
    extras: { set: async () => true }, clipboard: { write: async () => true },
  };
})();`;

const cover = (hue) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360},70%,28%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="150" r="70" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="10"/><circle cx="150" cy="150" r="14" fill="#fff" fill-opacity=".8"/></svg>`;

const STATE = {
  playing: { run: true, playing: true, title: 'Midnight Drive', artist: 'The Neon Echoes', album: 'City Lights', pos: 74, dur: 214, vol: 70, cover: 'c1' },
  paused: { run: true, playing: false, title: 'Midnight Drive', artist: 'The Neon Echoes', album: 'City Lights', pos: 74, dur: 214, vol: 70, cover: 'c1' },
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (body, type, status = 200) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(body); };
  if (u.pathname === '/__deska/sdk.js') return send(sdk, 'text/javascript');
  if (u.pathname === '/relay.js') return send(`export const RELAY = 'http://127.0.0.1:${PORT}/mock'; export const REPO = 'hopsiedev/deska-spotify'; export const REF = 'main';`, 'text/javascript');
  const m = u.pathname.match(/^\/mock\/(state|cover)\/([a-z0-9]+)$/);
  if (m) {
    const scene = m[2].replace(/0+$/, '');
    if (m[1] === 'cover') return send(cover(150), 'image/svg+xml');
    const s = STATE[scene];
    return send(JSON.stringify({ t: 'state', online: Boolean(s), rev: 1, s: s || { run: false } }), 'application/json');
  }
  const file = path.join(panel, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!file.startsWith(panel) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send('not found', 'text/plain', 404);
  send(fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, '127.0.0.1', () => console.log(`vista previa en http://127.0.0.1:${PORT}/index.html`));
