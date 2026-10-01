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
function socket() {
  return { sent: [], closed: [], send(message) { this.sent.push(message); }, close(code, reason) { this.closed.push({ code, reason }); } };
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

test('rosters contain only this room and distinguish lobby reservations from game connections', () => {
  const room = new Room({}, {}), other = new Room({}, {});
  const a = add(room, 0x0a4d0001), b = add(room, 0x0a4d0002), stranger = add(other, 0x0a4d0001);
  a.name = 'Alice'; b.name = 'Bob';
  const lobbyMessages = [];
  b.ws = null; b.lobbyWs = { send: message => lobbyMessages.push(JSON.parse(message)) };
  b.token = 'must-not-be-broadcast';
  room.broadcastRoster();
  const roster = JSON.parse(decode(a.received[0].subarray(1)));
  assert.equal(a.received[0][0], 0x85);
  assert.deepEqual(roster.players, [
    { id: a.ip, name: 'Alice', inGame: true }, { id: b.ip, name: 'Bob', inGame: false },
  ]);
  assert.equal(roster.capacity, 12);
  assert.deepEqual(lobbyMessages, [roster]);
  assert.equal(JSON.stringify(roster).includes(b.token), false);
  assert.equal(stranger.received.length, 0);
});

test('display names are bounded, sanitised and coalesced before broadcasting', () => {
  const room = new Room({}, {}), a = add(room, 0x0a4d0001);
  room.receive(a, Uint8Array.of(5, ...encode('  Alice\u202e\n  Racer  ')));
  assert.equal(a.name, 'Alice Racer');
  assert.equal(a.received.length, 0);
  room.setName(a, 'x'.repeat(80));
  assert.equal(a.name.length, 24);
  room.setName(a, '');
  assert.equal(a.name, 'Player 1');
  room.broadcastRoster();
  assert.equal(a.received.length, 1);
  assert.throws(() => room.receive(a, new Uint8Array(130).fill(5)), /too long/);
  assert.throws(() => room.receive(a, Uint8Array.of(5, 255)));
});

test('leaving removes the participant token and updates remaining players only once', () => {
  const room = new Room({}, {}), a = add(room, 0x0a4d0001), b = add(room, 0x0a4d0002);
  a.token = 'reserved-token'; room.tokens.set(a.token, a);
  room.removePlayer(a);
  room.removePlayer(a);
  assert.equal(room.tokens.size, 0);
  assert.equal(b.received.length, 1);
  assert.equal(JSON.parse(decode(b.received[0].subarray(1))).players.length, 1);
  room.receive(a, udp(123, b.ip, 456, encode('stale connection')));
  assert.equal(b.received.length, 1);
});

test('invalid or duplicate participant tokens cannot claim an existing slot', async () => {
  const room = new Room({}, {}), a = add(room, 0x0a4d0001);
  a.token = 'existing-token'; room.tokens.set(a.token, a);
  const invalid = await room.fetch(new Request('https://rooms.test/v1/rooms/abcdef/ws?token=invalid'));
  const duplicate = await room.fetch(new Request('https://rooms.test/v1/rooms/abcdef/ws?token=existing-token'));
  assert.equal(invalid.status, 403);
  assert.equal(duplicate.status, 409);
  assert.equal(room.players.size, 1);
});

test('lobby reservations consume capacity and survive either single-channel disconnect', async () => {
  const room = new Room({}, {});
  const reserved = add(room, 0x0a4d0001);
  reserved.ws = null;
  reserved.lobbyWs = socket();
  reserved.token = 'reservation-token';
  room.tokens.set(reserved.token, reserved);
  for (let n = 2; n <= 12; n++) {
    const p = add(room, 0x0a4d0000 | n);
    p.token = `token-${n}`;
    room.tokens.set(p.token, p);
  }

  const full = await room.fetch(new Request('https://rooms.test/v1/rooms/abcdef/lobby'));
  assert.equal(full.status, 409);
  assert.equal(room.players.size, 12);

  const lobby = reserved.lobbyWs;
  const game = socket();
  reserved.ws = game;
  room.leave(reserved, lobby, true);
  assert.equal(room.players.get(reserved.ip), reserved);
  assert.equal(room.tokens.get(reserved.token), reserved);
  assert.equal(reserved.lobbyWs, null);

  room.leave(reserved, game, false);
  assert.equal(room.players.has(reserved.ip), false);
  assert.equal(room.tokens.has('reservation-token'), false);
  assert.equal(room.players.size, 11);
});

test('superseded sockets cannot change names, relay packets or disconnect replacements', () => {
  const room = new Room({}, {}), a = add(room, 0x0a4d0001), b = add(room, 0x0a4d0002);
  const oldLobby = socket(), currentLobby = socket();
  a.lobbyWs = oldLobby;
  a.token = 'reconnect-token'; room.tokens.set(a.token, a);
  room.leave(a, oldLobby, true);
  a.lobbyWs = currentLobby; // token reconnects the lobby channel while the game channel remains live

  room.handleMessage(a, oldLobby, true, JSON.stringify({ type: 'name', name: 'Impostor' }));
  room.leave(a, oldLobby, true);
  assert.equal(a.name, undefined);
  assert.equal(a.lobbyWs, currentLobby);

  const oldGame = a.ws, currentGame = socket();
  a.ws = currentGame;
  const before = b.received.length;
  room.handleMessage(a, oldGame, false, udp(1000, b.ip, 2000, encode('stale')).buffer);
  room.leave(a, oldGame, false);
  assert.equal(b.received.length, before);
  assert.equal(a.ws, currentGame);
  assert.equal(room.players.get(a.ip), a);

  room.handleMessage(a, currentLobby, true, JSON.stringify({ type: 'name', name: 'Alice' }));
  assert.equal(a.name, 'Alice');
});

test('lobby messages reject malformed shapes, binary frames and oversized UTF-8 payloads', () => {
  const room = new Room({}, {}), a = add(room, 0x0a4d0001);
  const cases = [
    ['{broken', 1002],
    ['null', 1002],
    [JSON.stringify({ type: 'name', name: 3 }), 1002],
    ['💚'.repeat(129), 1009],
    [new ArrayBuffer(0), 1003],
  ];
  for (const [data, code] of cases) {
    const ws = socket();
    a.lobbyWs = ws;
    room.handleMessage(a, ws, true, data);
    assert.equal(ws.closed[0]?.code, code);
  }
  assert.equal(a.name, undefined);
});

test('malformed game display names close only the current game socket', () => {
  const room = new Room({}, {}), a = add(room, 0x0a4d0001);
  const ws = socket();
  a.ws = ws;
  room.handleMessage(a, ws, false, Uint8Array.of(5, 255).buffer);
  assert.equal(ws.closed[0]?.code, 1002);
  assert.equal(room.players.get(a.ip), a);
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
