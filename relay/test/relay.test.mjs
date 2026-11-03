// Prueba de extremo a extremo del relé: requiere `wrangler dev` y un companion emparejado con TEST_ID/TEST_K.
import assert from 'node:assert/strict';

const R = process.env.RELAY || 'http://127.0.0.1:8787';
const ID = process.env.TEST_ID || 'testpair0123456789ab';
const K = process.env.TEST_K || 'a'.repeat(32);
const WS = R.replace(/^http/, 'ws');

const get = (p) => fetch(`${R}${p}`).then(async (r) => ({ status: r.status, body: await r.text() }));

// 1) panel por WebSocket: estado inicial + comando con ack + difusión del estado
const ws = new WebSocket(`${WS}/ws/p/${ID}?k=${K}`);
const msgs = [];
ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
await new Promise((r) => setTimeout(r, 500));
assert.equal(msgs[0].t, 'state');
assert.equal(msgs[0].online, true, 'el companion debe estar conectado');

ws.send(JSON.stringify({ t: 'cmd', id: 'x1', c: 'volume', a: '90' }));
await new Promise((r) => setTimeout(r, 1800));
assert.ok(msgs.some((m) => m.t === 'ack' && m.id === 'x1' && m.ok), 'ack del comando por WebSocket');
assert.ok(msgs.some((m) => m.t === 'state' && m.s.vol === 90), 'estado difundido tras el comando');

ws.send(JSON.stringify({ t: 'cmd', id: 'x2', c: 'rm', a: '-rf' }));
await new Promise((r) => setTimeout(r, 300));
assert.ok(msgs.some((m) => m.t === 'ack' && m.id === 'x2' && !m.ok), 'comando no permitido rechazado');
await fetch(`${R}/cmd/${ID}?k=${K}&c=volume&a=100`);
ws.close();

// 2) clave de otra persona
assert.equal((await get(`/state/${ID}?k=${'b'.repeat(32)}`)).status, 401);
// 3) websocket con clave incorrecta
const bad = new WebSocket(`${WS}/ws/p/${ID}?k=${'b'.repeat(32)}`);
const closed = await new Promise((res) => { bad.onerror = () => res('error'); bad.onopen = () => res('open'); });
assert.equal(closed, 'error', 'WebSocket con clave incorrecta rechazado');
// 4) límites
assert.equal((await get(`/cmd/${ID}?k=${K}&c=volume&a=999`)).status, 400);
assert.equal((await get(`/nada`)).status, 404);
console.log('relé: todo correcto');
