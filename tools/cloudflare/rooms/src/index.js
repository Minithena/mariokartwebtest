// Online rooms for the Mario Kart Wii browser build.
//
// Each room is a Durable Object. Every player's game opens one WebSocket to it and the room acts
// as their network: it gives each player a private address (10.77.0.x), carries UDP between
// players, and answers what the game sends to "Nintendo's servers" (every host name resolves to
// 10.77.255.1) with a small stand-in for the old Nintendo Wi-Fi Connection (./wfc.js).
// The frame format is described in runtime/src/platform/web/web_vnet.cpp in the WiiCompiled fork.
//
//   POST /v1/rooms              -> { code }   a new room
//   GET  /v1/rooms/<code>/ws    WebSocket     join it
//   GET  /v1/rooms/<code>/lobby WebSocket     reserve a place before the game starts
//
// A room exists as long as someone knows its code; the code is the only key, so it is long and
// random.

import { Wfc } from './wfc.js';

const SERVER_IP = 0x0a4dff01; // 10.77.255.1
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_PLAYERS = 12;
const MAX_FRAME_BYTES = 65544; // IPv4 UDP payload plus our envelope

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/v1/rooms' && request.method === 'POST') {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      return Response.json({ code }, { headers: cors });
    }

    const match = url.pathname.match(/^\/v1\/rooms\/([a-z0-9]{6,32})\/(?:ws|lobby)$/);
    if (match) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket', { status: 426 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    return new Response('Not found', { status: 404, headers: cors });
  },
};

const ipText = (ip) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');

export class Room {
  constructor(state, env) {
    this.state = state;
    this.traceTraffic = env?.TRACE_TRAFFIC === '1';
    this.players = new Map(); // ip -> participant; lobby and game sockets share one place
    this.tokens = new Map(); // private reconnect token -> participant; never broadcast
    this.nextHost = 1;
    this.traffic = new Map(); // "a>b" -> packets since the last report (debugging aid)
    this.trafficTimer = null;
    this.rosterTimer = null;
    this.wfc = new Wfc({
      sendUdp: (dstIp, srcPort, dstPort, data) => this.sendUdp(SERVER_IP, srcPort, dstIp, dstPort, data),
      sendTcp: (player, conn, data) => this.send(player, frame(0x83, u32(conn), data)),
      closeTcp: (player, conn) => this.send(player, frame(0x84, u32(conn), [0])),
      players: () => [...this.players.values()],
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const lobby = url.pathname.endsWith('/lobby');
    const token = url.searchParams.get('token');
    let player = token ? this.tokens.get(token) : null;
    if (token && !player) return new Response('Invalid room session.', { status: 403 });
    if (player && (lobby ? player.lobbyWs : player.ws)) return new Response('Already connected.', { status: 409 });
    if (!player && this.players.size >= MAX_PLAYERS) return new Response('This room is full (12 players).', { status: 409 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.binaryType = 'arraybuffer';

    if (!player) {
      let host = this.nextHost;
      while (this.players.has((0x0a4d0000 | host) >>> 0)) host = (host % 250) + 1;
      this.nextHost = (host % 250) + 1;
      player = { ws: null, lobbyWs: null, ip: (0x0a4d0000 | host) >>> 0,
        name: `Player ${host}`, token: crypto.randomUUID().replaceAll('-', '') };
      this.players.set(player.ip, player);
      this.tokens.set(player.token, player);
      console.log(`player ${ipText(player.ip)} joined (${this.players.size} in the room)`);
    }
    if (lobby) {
      player.lobbyWs = server;
      server.send(JSON.stringify({ type: 'welcome', id: player.ip, token: player.token }));
    } else {
      player.ws = server;
      this.send(player, frame(0x80, u32(player.ip)));
    }

    server.addEventListener('message', (event) => this.handleMessage(player, server, lobby, event.data));
    const leave = () => this.leave(player, server, lobby);
    server.addEventListener('close', leave);
    server.addEventListener('error', leave);
    this.broadcastRoster();
    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(player, server, lobby, data) {
    const key = lobby ? 'lobbyWs' : 'ws';
    // A session token can attach a replacement socket while the old connection is closing.
    // Ignore any late messages from the superseded socket so it cannot mutate the new session.
    if (player[key] !== server || this.players.get(player.ip) !== player) return;

    if (lobby) {
      if (typeof data !== 'string') {
        server.close(1003, 'Expected a text lobby message');
        return;
      }
      if (new TextEncoder().encode(data).byteLength > 512) {
        server.close(1009, 'Lobby message too large');
        return;
      }
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        server.close(1002, 'Invalid lobby message');
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        server.close(1002, 'Invalid lobby message');
        return;
      }
      if (message.type === 'name') {
        if (typeof message.name !== 'string') {
          server.close(1002, 'Invalid lobby name');
          return;
        }
        this.setName(player, message.name);
      }
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      server.close(1003, 'Expected a binary room frame');
      return;
    }
    if (data.byteLength > MAX_FRAME_BYTES) {
      server.close(1009, 'Room frame too large');
      return;
    }
    try {
      this.receive(player, new Uint8Array(data));
    } catch (error) {
      console.warn('[room] invalid packet:', error.message);
      server.close(1002, 'Invalid room packet');
    }
  }

  leave(player, server, lobby) {
    const key = lobby ? 'lobbyWs' : 'ws';
    if (player[key] !== server) return;
    player[key] = null;
    if (!lobby) this.wfc.playerLeft(player);
    if (!player.ws && !player.lobbyWs) this.removePlayer(player);
    else this.broadcastRoster();
  }

  removePlayer(player) {
    if (this.players.get(player.ip) !== player) return;
    this.players.delete(player.ip);
    this.tokens.delete(player.token);
    this.wfc.playerLeft(player);
    if (!this.players.size) {
      clearTimeout(this.trafficTimer);
      this.trafficTimer = null;
      this.traffic.clear();
    }
    this.broadcastRoster();
    console.log(`player ${ipText(player.ip)} left (${this.players.size} in the room)`);
  }

  broadcastRoster() {
    clearTimeout(this.rosterTimer);
    this.rosterTimer = null;
    const players = [...this.players.values()].map(p => ({ id: p.ip, name: p.name || `Player ${p.ip & 255}`, inGame: !!p.ws }));
    const json = JSON.stringify({ type: 'roster', players, capacity: MAX_PLAYERS });
    const message = frame(0x85, new TextEncoder().encode(json));
    for (const player of this.players.values()) {
      this.send(player, message);
      try { player.lobbyWs?.send(json); } catch {}
    }
  }

  setName(player, text) {
    const name = Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ').trim()).slice(0, 24).join('') || `Player ${player.ip & 255}`;
    if (name !== player.name && this.players.get(player.ip) === player) {
      player.name = name;
      // Coalesce rapid edits so one client cannot flood every sidebar with DOM updates.
      if (!this.rosterTimer) this.rosterTimer = setTimeout(() => this.broadcastRoster(), 100);
    }
  }

  receive(player, msg) {
    if (this.players.get(player.ip) !== player) return;
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    switch (msg[0]) {
      case 0x01: { // UDP: srcPort dstIp dstPort data
        if (msg.length < 9) return;
        const srcPort = view.getUint16(1);
        const dstIp = view.getUint32(3);
        const dstPort = view.getUint16(7);
        const data = msg.subarray(9);
        if (dstIp === SERVER_IP) this.wfc.udp(player, srcPort, dstPort, data);
        else this.sendUdp(player.ip, srcPort, dstIp, dstPort, data);
        return;
      }
      case 0x02: { // OPEN: conn dstIp dstPort srcPort
        if (msg.length < 13) return;
        const conn = view.getUint32(1);
        const dstIp = view.getUint32(5);
        const dstPort = view.getUint16(9);
        const srcPort = view.getUint16(11);
        const accepted = dstIp === SERVER_IP && this.wfc.tcpOpen(player, conn, dstPort, srcPort);
        this.send(player, accepted ? frame(0x82, u32(conn)) : frame(0x84, u32(conn), [1]));
        if (accepted) this.wfc.tcpOpened(player, conn);
        return;
      }
      case 0x03: // DATA: conn data
        if (msg.length >= 5) this.wfc.tcpData(player, view.getUint32(1), msg.subarray(5));
        return;
      case 0x04: // CLOSE: conn
        if (msg.length >= 5) this.wfc.tcpClose(player, view.getUint32(1));
        return;
      case 0x05: { // NAME: bounded UTF-8 display name, unrelated to WFC account identity
        if (msg.length > 129) throw new Error('Display name too long');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(msg.subarray(1));
        this.setName(player, text);
        return;
      }
    }
  }

  sendUdp(srcIp, srcPort, dstIp, dstPort, data) {
    const target = this.players.get(dstIp);
    if (!target) return;
    if (this.traceTraffic && srcIp !== SERVER_IP) this.countTraffic(srcIp, dstIp);
    const head = new Uint8Array(9);
    const view = new DataView(head.buffer);
    head[0] = 0x81;
    view.setUint32(1, srcIp);
    view.setUint16(5, srcPort);
    view.setUint16(7, dstPort);
    this.send(target, concat(head, data));
  }

  // Logs the player-to-player packet rate every 2 seconds while there is any.
  countTraffic(srcIp, dstIp) {
    const key = `${srcIp & 255}>${dstIp & 255}`;
    this.traffic.set(key, (this.traffic.get(key) ?? 0) + 1);
    if (this.trafficTimer) return;
    this.trafficTimer = setTimeout(() => {
      this.trafficTimer = null;
      const parts = [...this.traffic].map(([k, n]) => `${k}: ${n}`);
      this.traffic.clear();
      if (parts.length) console.log(`[room] packets in 2 s: ${parts.join(', ')}`);
    }, 2000);
  }

  send(player, bytes) {
    if (!player.ws) return;
    try {
      player.ws.send(bytes);
    } catch {
      // closed; the close handler removes the player
    }
  }
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function frame(type, ...parts) {
  return concat(Uint8Array.of(type), ...parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))));
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
