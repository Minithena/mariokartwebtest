import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Room } from '../src/index.js';
import { Wfc } from '../src/wfc.js';
import { matchesFilter } from '../src/filter.js';

const encode = (s) => new TextEncoder().encode(s);
const decode = (s) => new TextDecoder().decode(s);
const player = (ip) => ({ ip, received: [], ws: { send(bytes) { this.owner.received.push(bytes); } } });
function add(room, ip) {
  const p = player(ip);
  p.ws.owner = p;
  room.players.set(ip, p);
  return p;
}
function udp(port, ip, destPort, data) {
  const msg = new Uint8Array(9 + data.length);
  const v = new DataView(msg.buffer);
  msg[0] = 1;
  v.setUint16(1, port); v.setUint32(3, ip); v.setUint16(7, destPort);
  msg.set(data, 9);
  return msg;
}
function service() {
  const replies = [], closed = [];
  const wfc = new Wfc({ sendTcp: (p, conn, data) => replies.push({ p, conn, data }),
    closeTcp: (p, conn) => closed.push(conn), sendUdp() {} });
  const p = { ip: 0x0a4d0001 };
  return { wfc, p, replies, closed };
}

test('room creation returns random invite codes and CORS headers', async () => {
  const codes = new Set();
  for (let n = 0; n < 32; n++) {
    const response = await worker.fetch(new Request('https://rooms.test/v1/rooms', { method: 'POST' }), {});
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    const { code } = await response.json();
    assert.match(code, /^[a-z0-9]{12}$/);
    codes.add(code);
  }
  assert.equal(codes.size, 32);
});

test('room relay preserves ports, payload and authenticated source address', () => {
  const room = new Room({}, {});
  const a = add(room, 0x0a4d0001), b = add(room, 0x0a4d0002);
  room.receive(a, udp(2345, b.ip, 6789, Uint8Array.of(0, 255, 34, 0)));
  const received = b.received[0], view = new DataView(received.buffer);
  assert.equal(received[0], 0x81);
  assert.equal(view.getUint32(1), a.ip);
  assert.equal(view.getUint16(5), 2345);
  assert.equal(view.getUint16(7), 6789);
  assert.deepEqual([...received.subarray(9)], [0, 255, 34, 0]);
  assert.equal(a.received.length, 0);
});

test('players in different rooms cannot exchange packets', () => {
  const one = new Room({}, {}), two = new Room({}, {});
  const a = add(one, 0x0a4d0001), b = add(two, 0x0a4d0002);
  one.receive(a, udp(2345, b.ip, 6789, Uint8Array.of(1)));
  assert.equal(b.received.length, 0);
});

test('full rooms reject joins before allocating an address', async () => {
  const room = new Room({}, {});
  for (let n = 1; n <= 12; n++) add(room, 0x0a4d0000 | n);
  const response = await room.fetch(new Request('https://rooms.test/v1/rooms/abcdef/ws'));
  assert.equal(response.status, 409);
});

test('truncated envelopes are ignored and TCP cannot reach external hosts', () => {
  const room = new Room({}, {}), a = add(room, 0x0a4d0001);
  for (const type of [1, 2, 3, 4]) for (let size = 1; size < 5; size++) {
    const data = new Uint8Array(size); data[0] = type;
    assert.doesNotThrow(() => room.receive(a, data));
  }
  const open = new Uint8Array(13), v = new DataView(open.buffer);
  open[0] = 2; v.setUint32(1, 9); v.setUint32(5, 0x08080808); v.setUint16(9, 443);
  room.receive(a, open);
  assert.deepEqual([...a.received[0]], [0x84, 0, 0, 0, 9, 1]);
});

test('profile commands survive fragmentation and preserve a trailing partial command', async () => {
  const { wfc, p, replies } = service();
  wfc.tcpOpen(p, 1, 29900, 1000);
  wfc.tcpData(p, 1, encode('\\ka\\\\final\\\\getpro'));
  await wfc.conns.get(wfc.key(p, 1)).processing;
  assert.equal(decode(replies[0].data), '\\ka\\\\final\\');
  assert.equal(wfc.conns.get(wfc.key(p, 1)).buffer, '\\getpro');
  wfc.tcpData(p, 1, encode('file\\\\profileid\\7\\id\\2\\final\\'));
  await wfc.conns.get(wfc.key(p, 1)).processing;
  assert.match(decode(replies[1].data), /\\profileid\\7/);
});

test('oversized incomplete requests close only the offending virtual socket', () => {
  const { wfc, p, closed } = service();
  wfc.tcpOpen(p, 1, 80, 1000); wfc.tcpOpen(p, 2, 29900, 1001);
  wfc.tcpData(p, 1, new Uint8Array(65537));
  assert.deepEqual(closed, [1]);
  assert.ok(wfc.conns.has(wfc.key(p, 2)));
});

test('leaving clears player tokens, profiles and advertised matches', () => {
  const { wfc, p } = service();
  wfc.tcpOpen(p, 1, 29900, 1000);
  wfc.tokens.set('token', { player: p }); wfc.profiles.set(1, { player: p });
  wfc.qr2.set('match', { player: p });
  wfc.playerLeft(p);
  for (const map of [wfc.conns, wfc.tokens, wfc.profiles, wfc.qr2]) assert.equal(map.size, 0);
});

test('match filters honour game mode, capacity, exclusions and signed values', () => {
  const keys = { dwc_pid: '43', dwc_mver: '90', numplayers: '2', maxplayers: '11', rk: 'vs', ev: '5000', n: '-3' };
  assert.equal(matchesFilter("dwc_mver = 90 and dwc_pid != 44 and numplayers < 11 and (rk = 'vs' and ev >= 4250 and ev <= 5750)", keys), true);
  assert.equal(matchesFilter('dwc_pid != 43', keys), false);
  assert.equal(matchesFilter('numplayers >= maxplayers', keys), false);
  assert.equal(matchesFilter('n < -2', keys), true);
  assert.equal(matchesFilter('dwc_pid =', keys), false);
});
