// Run against Wrangler or the deployed Worker; creates disposable rooms with synthetic players.
// Usage: node test/live-smoke.mjs http://127.0.0.1:8787
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const md5 = (s) => createHash('md5').update(s, 'latin1').digest('hex');
const bytes = (s) => Buffer.from(s, 'latin1');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const wire = (type, ...parts) => Buffer.concat([Buffer.from([type]), ...parts]);
const dwcEncode = (s) => bytes(s).toString('base64').replace(/\+/g, '.').replace(/\//g, '-').replace(/=/g, '*');
const dwcDecode = (s) => Buffer.from(s.replace(/\./g, '+').replace(/-/g, '/').replace(/\*/g, '='), 'base64').toString('latin1');

class Client {
  constructor(code) {
    this.queue = [];
    this.ws = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/rooms/${code}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', (e) => this.queue.push(Buffer.from(e.data)));
    this.ws.addEventListener('error', () => { this.error = true; });
  }
  async take(type, conn) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const i = this.queue.findIndex((m) => m[0] === type && (conn === undefined || m.readUInt32BE(1) === conn));
      if (i >= 0) return this.queue.splice(i, 1)[0];
      assert.ok(!this.error, 'WebSocket failed');
      await delay(5);
    }
    throw new Error(`Timed out waiting for frame ${type.toString(16)}`);
  }
  async ready() { this.ip = (await this.take(0x80)).readUInt32BE(1); return this; }
  async open(conn, port) {
    this.ws.send(wire(2, u32(conn), u32(0x0a4dff01), u16(port), u16(40000 + conn)));
    await this.take(0x82, conn);
  }
  data(conn, text) { this.ws.send(wire(3, u32(conn), bytes(text))); }
  udp(ip, payload) { this.ws.send(wire(1, u16(25000), u32(ip), u16(25000), payload)); }
  close() { this.ws.close(); }
}

async function newRoom() {
  const response = await fetch(`${base}/v1/rooms`, { method: 'POST' });
  assert.equal(response.status, 200);
  const { code } = await response.json();
  assert.match(code, /^[a-z0-9]{12}$/);
  return code;
}

async function login(client) {
  await client.open(1, 80);
  const body = Object.entries({ action: 'login', userid: '123456789012', gamecd: 'RMCP', gsbrcd: 'RMCJ' })
    .map(([k, v]) => `${k}=${dwcEncode(v)}`).join('&');
  client.data(1, `POST /ac HTTP/1.1\r\nHost: naswii.nintendowifi.net\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  const http = (await client.take(0x83, 1)).subarray(5).toString('latin1');
  assert.match(http, /^HTTP\/1.1 200 /);
  const fields = Object.fromEntries(http.split('\r\n\r\n')[1].replace(/\0$/, '').split('&')
    .map((v) => { const i = v.indexOf('='); return [v.slice(0, i), dwcDecode(v.slice(i + 1))]; }));
  await client.open(2, 29900);
  const challengeReply = (await client.take(0x83, 2)).subarray(5).toString('latin1');
  const challenge = /\\challenge\\([^\\]+)/.exec(challengeReply)[1];
  const ours = 'synthetic-client';
  const hash = md5(fields.challenge);
  const response = md5(hash + ' '.repeat(48) + fields.token + ours + challenge + hash);
  const message = `\\login\\\\challenge\\${ours}\\authtoken\\${fields.token}\\response\\${response}\\id\\1\\final\\`;
  // Exercise stream reassembly rather than relying on a single WebSocket frame.
  client.data(2, message.slice(0, 27)); client.data(2, message.slice(27));
  const reply = (await client.take(0x83, 2)).subarray(5).toString('latin1');
  assert.match(reply, /^\\lc\\2\\/);
  assert.equal(/\\proof\\([^\\]+)/.exec(reply)[1], md5(hash + ' '.repeat(48) + fields.token + challenge + ours + hash));
  return /\\profileid\\(\d+)/.exec(reply)[1];
}

const clients = [];
try {
  const code = await newRoom();
  const a = new Client(code), b = new Client(code), isolated = new Client(await newRoom());
  clients.push(a, b, isolated);
  await Promise.all(clients.map((c) => c.ready()));
  assert.notEqual(a.ip, b.ip);
  const profiles = await Promise.all([login(a), login(b)]);
  assert.notEqual(profiles[0], profiles[1], 'cloned saves need different live profiles');
  for (let i = 0; i < 180; i++) {
    const payload = Buffer.concat([u32(i), randomBytes(512)]);
    a.udp(b.ip, payload); b.udp(a.ip, payload);
    const [fromA, fromB] = await Promise.all([b.take(0x81), a.take(0x81)]);
    assert.equal(fromA.readUInt32BE(1), a.ip);
    assert.equal(fromB.readUInt32BE(1), b.ip);
    assert.equal(fromA.readUInt16BE(5), 25000);
    assert.equal(fromA.readUInt16BE(7), 25000);
    assert.deepEqual(fromA.subarray(9), payload);
    assert.deepEqual(fromB.subarray(9), payload);
  }
  isolated.udp(b.ip, bytes('must not cross rooms'));
  await delay(200);
  assert.equal(b.queue.filter((m) => m[0] === 0x81).length, 0);
  assert.equal(isolated.queue.filter((m) => m[0] === 0x81).length, 0);
  console.log(`PASS ${base}: room creation, WSS/WS admission, NAS login, fragmented GameSpy proof, cloned-save profiles, 360 datagrams, room isolation`);
} finally {
  for (const client of clients) client.close();
}
