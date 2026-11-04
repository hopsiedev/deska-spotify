// Prueba de extremo a extremo del relé: requiere `wrangler dev` y un companion emparejado con TEST_ID/TEST_K.
import assert from 'node:assert/strict';

const R = process.env.RELAY || 'http://127.0.0.1:8787';
const ID = process.env.TEST_ID || 'testpair0123456789ab';
const K = process.env.TEST_K || 'a'.repeat(32);
const WS = R.replace(/^http/, 'ws');

const get = (p, headers = {}) => fetch(`${R}${p}`, { headers: { Authorization: `Bearer ${K}`, ...headers } }).then(async (r) => ({ status: r.status, body: await r.text() }));

// 1) panel por WebSocket: sin secreto en la URL, autenticación por primer mensaje
const ws = new WebSocket(`${WS}/ws/p/${ID}`);
const msgs = [];
ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
ws.send(JSON.stringify({ t: 'auth', k: K }));
await new Promise((r) => setTimeout(r, 600));
assert.ok(msgs.some((m) => m.t === 'auth' && m.ok), 'auth confirmada');
assert.ok(msgs.some((m) => m.t === 'state'), 'estado recibido');

ws.send(JSON.stringify({ t: 'cmd', id: 'x1', c: 'volume', a: '90' }));
await new Promise((r) => setTimeout(r, 1800));
assert.ok(msgs.some((m) => m.t === 'ack' && m.id === 'x1' && m.ok), 'ack del comando por WebSocket');

ws.send(JSON.stringify({ t: 'cmd', id: 'x2', c: 'rm', a: '-rf' }));
await new Promise((r) => setTimeout(r, 300));
assert.ok(msgs.some((m) => m.t === 'ack' && m.id === 'x2' && !m.ok), 'comando no permitido rechazado');
await fetch(`${R}/cmd/${ID}`, { method: 'POST', headers: { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ c: 'volume', a: '100' }) });
ws.close();

// 2) clave incorrecta en cabecera
assert.equal((await get(`/state/${ID}`, { Authorization: `Bearer ${'b'.repeat(32)}` })).status, 401);

// 3) websocket con clave incorrecta en mensaje
const bad = new WebSocket(`${WS}/ws/p/${ID}`);
const badClosed = await new Promise((res) => {
  bad.onopen = () => bad.send(JSON.stringify({ t: 'auth', k: 'b'.repeat(32) }));
  bad.onclose = () => res('closed');
  bad.onerror = () => res('error');
});
assert.ok(badClosed === 'closed' || badClosed === 'error', 'WebSocket con clave incorrecta rechazado');

// 4) límites
assert.equal((await fetch(`${R}/cmd/${ID}`, { method: 'POST', headers: { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ c: 'volume', a: '999' }) })).status, 400);
assert.equal((await fetch(`${R}/nada`, { headers: { Authorization: `Bearer ${K}` } })).status, 404);
console.log('relé: todo correcto');
