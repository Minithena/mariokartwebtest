// Stand-in for Nintendo Wi-Fi Connection, just enough for the players in one room to find each
// other and race. It follows the protocols as reimplemented by WiiLink WFC
// (https://github.com/WiiLink24/wfc-server) and the AltWFC server emulator
// (https://github.com/barronwaffles/dwc_network_server_emulator), both AGPL-3.0; this file is
// AGPL-3.0 too. Everything lives in the room's memory: a room forgets its players when it empties.
//
// Services, by port on the room's server address:
//   TCP 80     HTTP: connection test (conntest) and login (NAS /ac)
//   TCP 29900  GPCM: GameSpy presence (profile login, status)
//   TCP 29901  GPSP: GameSpy profile search
//   TCP 28910  server browser: match listings
//   UDP 27900  QR2: match hosting and heartbeats
//   UDP 27901  NATNEG: connecting two players

const TCP_PORTS = new Set([80, 443, 29900, 29901, 28910]);
const MAX_BUFFER_BYTES = 65536;
const MAX_CONNECTIONS_PER_PLAYER = 64;

import { matchesFilter } from './filter.js';
import { encryptTypeX } from './enctypex.js';

// Bytes <-> strings with one character per byte (TextDecoder's "latin1" is really windows-1252).
const text = { decode: (data) => { let s = ''; for (const b of data) s += String.fromCharCode(b); return s; } };
const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const MKW_SECRET_KEY = bytes('9r3Rmy'); // GameSpy secret key of "mariokartwii"

function preview(data) {
  const s = text.decode(data.subarray(0, 300));
  return s.replace(/[^\x20-\x7e]/g, '.') + (data.length > 300 ? `… (${data.length} bytes)` : '');
}

// DWC's base64: '.' '-' and '*' in place of '+' '/' and '='.
const dwcDecode = (s) => atob(s.replace(/\./g, '+').replace(/-/g, '/').replace(/\*/g, '='));
const dwcEncode = (s) => btoa(s).replace(/\+/g, '.').replace(/\//g, '-').replace(/=/g, '*');

function randomString(length, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => alphabet[v % alphabet.length]).join('');
}

async function md5Hex(s) {
  const digest = await crypto.subtle.digest('MD5', bytes(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// GameSpy text messages: \command\value\key\value...\final\
function parseGameSpy(message) {
  const commands = [];
  for (const chunk of message.split('\\final\\')) {
    if (!chunk.startsWith('\\')) continue;
    const parts = chunk.slice(1).split('\\');
    const command = { name: parts[0], value: parts[1] ?? '', fields: {} };
    for (let i = 2; i + 1 < parts.length + 1; i += 2) command.fields[parts[i]] = parts[i + 1] ?? '';
    commands.push(command);
  }
  return commands;
}

function gameSpy(name, value, fields) {
  let out = `\\${name}\\${value}`;
  for (const [k, v] of Object.entries(fields)) out += `\\${k}\\${v}`;
  return out + '\\final\\';
}

function dateTime() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

export class Wfc {
  constructor(io) {
    this.io = io;
    this.conns = new Map(); // "ip:conn" -> { player, conn, port, buffer }
    this.tokens = new Map(); // NAS token -> login details
    this.profiles = new Map(); // profile id -> { player, name, ... }
    this.qr2 = new Map(); // "ip:port" -> matchmaking session (heartbeat keys and state)
    this.natnegSessions = new Map(); // cookie -> { version, clients }
  }

  key(player, conn) {
    return `${player.ip}:${conn}`;
  }

  tcpOpen(player, conn, port, srcPort) {
    if (this.conns.has(this.key(player, conn)) ||
        [...this.conns.values()].filter((c) => c.player === player).length >= MAX_CONNECTIONS_PER_PLAYER) return false;
    if (!TCP_PORTS.has(port)) {
      console.log(`[wfc] refused TCP to port ${port}`);
      return false;
    }
    this.conns.set(this.key(player, conn), { player, conn, port, srcPort, buffer: '', bin: new Uint8Array(0) });
    console.log(`[wfc] TCP ${port} opened by ${player.ip & 255} (conn ${conn})`);
    return true;
  }

  tcpOpened(player, conn) {
    const c = this.conns.get(this.key(player, conn));
    if (c.port === 29900) {
      c.challenge = randomString(10);
      this.reply(c, gameSpy('lc', '1', { challenge: c.challenge, id: '1' }));
    }
  }

  tcpData(player, conn, data) {
    const c = this.conns.get(this.key(player, conn));
    if (!c) return;
    if (c.buffer.length + c.bin.length + data.length > MAX_BUFFER_BYTES) return this.close(c);
    if (c.port === 28910) {
      const joined = new Uint8Array(c.bin.length + data.length);
      joined.set(c.bin);
      joined.set(data, c.bin.length);
      c.bin = joined;
      return this.serverBrowser(c);
    }
    c.buffer += text.decode(data);
    switch (c.port) {
      case 80:
      case 443:
        return this.http(c);
      case 29900:
        // Login computes an asynchronous proof. Keep subsequent commands on this connection
        // ordered, including a command split across two WebSocket frames.
        if (!c.processing) {
          c.processing = this.gpcm(c).catch((error) => {
            console.warn('[wfc] profile request failed:', error.message);
            this.close(c);
          }).finally(() => { c.processing = null; });
        }
        return;
      case 29901:
        return this.gpsp(c);
      default:
        console.log(`[wfc] TCP ${c.port} from ${player.ip & 255}: ${preview(data)}`);
        c.buffer = '';
    }
  }

  tcpClose(player, conn) {
    this.conns.delete(this.key(player, conn));
  }

  udp(player, srcPort, dstPort, data) {
    if (dstPort === 27900) return this.qr2Packet(player, srcPort, data);
    if (dstPort === 27901) return this.natneg(player, srcPort, data);
    console.log(`[wfc] UDP ${srcPort}->${dstPort} from ${player.ip & 255}: ${preview(data)}`);
  }

  playerLeft(player) {
    for (const [k, c] of this.conns) if (c.player === player) this.conns.delete(k);
    for (const [id, p] of this.profiles) if (p.player === player) this.profiles.delete(id);
    for (const [k, q] of this.qr2) if (q.player === player) this.qr2.delete(k);
    for (const [k, t] of this.tokens) if (t.player === player) this.tokens.delete(k);
    for (const [k, s] of this.natnegSessions) {
      if ([...s.clients.values()].some((c) => c.negotiate?.player === player)) {
        s.cancelled = true;
        this.natnegSessions.delete(k);
      }
    }
  }

  reply(c, message) {
    this.io.sendTcp(c.player, c.conn, typeof message === 'string' ? bytes(message) : message);
  }

  close(c) {
    this.io.closeTcp(c.player, c.conn);
    this.conns.delete(this.key(c.player, c.conn));
  }

  // --- HTTP ---------------------------------------------------------------------------------

  http(c) {
    const headerEnd = c.buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const head = c.buffer.slice(0, headerEnd);
    const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
    if (c.buffer.length < headerEnd + 4 + length) return;
    const body = c.buffer.slice(headerEnd + 4, headerEnd + 4 + length);
    c.buffer = c.buffer.slice(headerEnd + 4 + length);
    const [method, path] = head.split('\r\n')[0].split(' ');
    const host = (/\r\nhost:\s*([^\r\n]+)/i.exec(head)?.[1] ?? '').toLowerCase();
    console.log(`[wfc] HTTP ${method} ${host}${path}`);

    if (host.startsWith('conntest.')) {
      const page =
        '\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ' +
        '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n<html>\n<head>\n' +
        '<title>HTML Page</title>\n</head>\n<body bgcolor="#FFFFFF">\nThis is test.html page\n</body>\n</html>\n';
      return this.httpReply(c, 200, page, { 'Content-type': 'text/html', 'X-Organization': 'Nintendo' });
    }
    if (path === '/ac' && method === 'POST') return this.nas(c, body);
    if (path === '/pr' && method === 'POST') {
      // Name check: nothing is rejected in a private room.
      return this.nasReply(c, { prwords: '0', returncd: '000', datetime: dateTime() });
    }
    console.log(`[wfc] unhandled HTTP request:\n${head}\n${body.slice(0, 500)}`);
    this.httpReply(c, 404, '<html><body>404 Not Found</body></html>', { 'Content-Type': 'text/html' });
  }

  httpReply(c, status, body, headers) {
    let head = `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Not Found'}\r\n`;
    for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
    head += `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    this.reply(c, head + body);
    this.close(c);
  }

  nasReply(c, fields) {
    const body = Object.entries(fields).map(([k, v]) => `${k}=${dwcEncode(v)}`).join('&') + '\0';
    this.httpReply(c, 200, body, { 'Content-Type': 'text/plain' });
  }

  nas(c, body) {
    const fields = {};
    for (const pair of body.replace(/\0+$/, '').split('&')) {
      const [k, v = ''] = pair.split('=');
      if (!k || k.startsWith('_')) continue;
      try {
        fields[k] = dwcDecode(decodeURIComponent(v));
      } catch {
        fields[k] = '';
      }
    }
    const action = (fields.action ?? '').toLowerCase();
    console.log(`[wfc] NAS ${action} gamecd=${fields.gamecd} userid=${fields.userid}`);

    if (action === 'acctcreate') {
      const userid = String(Math.floor(Math.random() * 0x7fffffffff) + 1);
      return this.nasReply(c, { retry: '0', datetime: dateTime(), returncd: '002', userid });
    }
    if (action === 'login') {
      for (const [key, token] of this.tokens) if (token.player === c.player) this.tokens.delete(key);
      const challenge = randomString(8);
      const token = 'NDS' + randomString(80, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
      this.tokens.set(token, {
        challenge,
        userid: fields.userid ?? '0',
        gsbrcd: fields.gsbrcd || (fields.gamecd ?? 'RMCP').slice(0, 3) + 'J',
        gamecd: fields.gamecd ?? '',
        ingamesn: fields.ingamesn ?? '',
        cfc: fields.cfc ?? '',
        player: c.player,
      });
      return this.nasReply(c, {
        retry: '0', datetime: dateTime(), locator: 'gamespy.com', returncd: '001', challenge, token,
      });
    }
    if (action === 'svcloc') {
      return this.nasReply(c, {
        retry: '0', datetime: dateTime(), returncd: '007', statusdata: 'Y',
        servicetoken: 'NDS/SVCLOC/TOKEN', svchost: 'n/a',
      });
    }
    console.log(`[wfc] unhandled NAS action ${action}: ${JSON.stringify(fields)}`);
    this.nasReply(c, { retry: '0', datetime: dateTime(), returncd: '109' });
  }

  // --- GPCM ---------------------------------------------------------------------------------

  async gpcm(c) {
    let end;
    while ((end = c.buffer.indexOf('\\final\\')) !== -1) {
      const message = c.buffer.slice(0, end + 7);
      c.buffer = c.buffer.slice(end + 7);
      const command = parseGameSpy(message)[0];
      if (!command || this.conns.get(this.key(c.player, c.conn)) !== c) continue;
      // Do not log authentication tokens, proofs or console identifiers.
      console.log(`[wfc] GPCM ${command.name} from player ${c.player.ip & 255}`);
      switch (command.name) {
        case 'ka':
          this.reply(c, '\\ka\\\\final\\');
          break;
        case 'login':
          await this.gpcmLogin(c, command);
          break;
        case 'logout':
          break;
        case 'status':
          if (c.profile) c.profile.status = command.fields;
          break;
        case 'getprofile': {
          const id = command.fields.profileid;
          const p = this.profiles.get(Number(id));
          this.reply(c, gameSpy('pi', '', {
            profileid: id, nick: p?.uniquenick ?? '', userid: p?.userid ?? '0', email: p?.email ?? '',
            sig: randomString(32, '0123456789abcdef'), uniquenick: p?.uniquenick ?? '',
            firstname: p?.firstname ?? '', lastname: p?.lastname ?? '', pid: '11', lon: '0.000000', lat: '0.000000', loc: '',
            id: command.fields.id ?? '',
          }));
          break;
        }
        case 'updatepro':
          // The game stores its console and licence IDs here and reads them back.
          if (c.profile) {
            for (const k of ['firstname', 'lastname', 'email', 'zipcode']) {
              if (k in command.fields) c.profile[k] = command.fields[k];
            }
          }
          break;
        default:
          console.log(`[wfc] unhandled GPCM command ${command.name}`);
      }
    }
  }

  async gpcmLogin(c, command) {
    const authtoken = command.fields.authtoken ?? '';
    const login = this.tokens.get(authtoken);
    if (!login || login.player !== c.player) {
      console.log('[wfc] GPCM login with an unknown token');
      this.reply(c, gameSpy('error', '', { err: '256', fatal: '', errmsg: 'Login failed.', id: '1' }));
      return;
    }
    const response = async (a, b) => {
      const hash = await md5Hex(login.challenge);
      return md5Hex(hash + ' '.repeat(48) + authtoken + a + b + hash);
    };
    // generateResponse(gpcmChallenge, nas, token, client) hashes client challenge, then ours.
    if ((await response(command.fields.challenge, c.challenge)) !== command.fields.response) {
      console.log('[wfc] GPCM login response did not match');
      this.reply(c, gameSpy('error', '', { err: '260', fatal: '', errmsg: 'Login failed.', id: '1' }));
      return;
    }
    const proof = await response(c.challenge, command.fields.challenge);
    if (this.conns.get(this.key(c.player, c.conn)) !== c) return;
    const userid = Number(login.userid) || 1;
    let profileid = (userid % 900000000) + 100000000;
    // Two browsers can start from the same seeded save. They still need distinct live profiles.
    while (this.profiles.has(profileid) && this.profiles.get(profileid).player !== c.player) {
      profileid = profileid === 999999999 ? 100000000 : profileid + 1;
    }
    const profile = {
      player: c.player, conn: c, userid: String(userid), profileid,
      uniquenick: randomString(20, 'abcdefghijklmnopqrstuvwxyz0123456789'),
      gsbrcd: login.gsbrcd, ingamesn: login.ingamesn, status: {},
    };
    this.profiles.set(profileid, profile);
    c.profile = profile;
    console.log(`[wfc] player ${c.player.ip & 255} logged in as profile ${profileid}`);
    this.reply(c, gameSpy('lc', '2', {
      sesskey: String(Math.floor(Math.random() * 290000000) + 10000000),
      proof, userid: String(userid), profileid: String(profileid), uniquenick: profile.uniquenick,
      lt: randomString(22, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789[]'),
      id: command.fields.id ?? '1',
    }));
  }

  // --- GPSP ---------------------------------------------------------------------------------

  gpsp(c) {
    const end = c.buffer.lastIndexOf('\\final\\');
    if (end < 0) return;
    const message = c.buffer.slice(0, end + 7);
    c.buffer = c.buffer.slice(end + 7);
    for (const command of parseGameSpy(message)) {
      if (command.name === 'otherslist') {
        // Unique nicknames of the friends it asks about, when they are in this room.
        let reply = '\\otherslist\\';
        for (const id of (command.fields.opids ?? '').split('|')) {
          const p = this.profiles.get(Number(id));
          if (p) reply += `\\o\\${id}\\uniquenick\\${p.uniquenick}`;
        }
        this.reply(c, reply + '\\oldone\\\\final\\');
      } else {
        console.log(`[wfc] unhandled GPSP command ${command.name}`);
      }
    }
  }

  // --- QR2 (UDP 27900) ----------------------------------------------------------------------
  // Header of every reply: FE FD <type> <session id, 4 bytes>.

  qr2Send(q, type, body = new Uint8Array(0)) {
    const out = new Uint8Array(7 + body.length);
    out.set([0xfe, 0xfd, type]);
    new DataView(out.buffer).setUint32(3, q.sessionId >>> 0);
    out.set(body, 7);
    this.io.sendUdp(q.player.ip, 27900, q.port, out);
  }

  qr2Packet(player, port, data) {
    const type = data[0];
    if (type === 0x09) {
      // "Is the service available?" -> yes
      this.io.sendUdp(player.ip, 27900, port, Uint8Array.of(0xfe, 0xfd, 0x09, 0, 0, 0, 0));
      return;
    }
    const key = `${player.ip}:${port}`;
    const sessionId = data.length >= 5 ? new DataView(data.buffer, data.byteOffset).getUint32(1) : 0;
    let q = this.qr2.get(key);
    if (type === 0x03) {
      const fields = text.decode(data.subarray(5)).split('\0');
      const keys = {};
      for (let i = 0; i + 1 < fields.length; i += 2) {
        if (!fields[i] || fields[i][0] === '+' || fields[i] === 'unknown') continue;
        keys[fields[i]] = fields[i + 1];
      }
      if (keys.statechanged === '2') {
        this.qr2.delete(key);
        return;
      }
      if (!q) {
        q = { player, port, sessionId, keys: {}, authenticated: false, challenge: '' };
        this.qr2.set(key, q);
      }
      q.sessionId = sessionId;
      Object.assign(q.keys, keys);
      // The game learns its public address from the challenge and reports it back.
      q.keys.publicip = String(player.ip | 0);
      q.keys.publicport = String(port);
      if (!q.authenticated || keys.publicip === undefined || keys.publicip === '0') {
        if (!q.challenge) {
          const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
          q.challenge = randomString(6) + '00' + hex(player.ip >>> 0, 8) + hex(port, 4);
        }
        this.qr2Send(q, 0x01, bytes(q.challenge + '\0'));
      }
      return;
    }
    if (!q) return;
    q.sessionId = sessionId;
    switch (type) {
      case 0x01: // challenge answered
        q.authenticated = true;
        this.qr2Send(q, 0x0a);
        return;
      case 0x08: // keep-alive
        q.sessionId = 0;
        this.qr2Send(q, 0x08);
        return;
      case 0x07: // a client message arrived
        return;
      default:
        console.log(`[wfc] QR2 packet 0x${type.toString(16)} from ${player.ip & 255}: ${preview(data)}`);
    }
  }

  // --- Server browser (TCP 28910) -----------------------------------------------------------
  // Requests: u16 length, u8 type. Replies to a list request are enctypeX-encrypted.

  serverBrowser(c) {
    while (c.bin.length >= 3) {
      const size = (c.bin[0] << 8) | c.bin[1];
      if (size < 3) return this.close(c);
      if (c.bin.length < size) return;
      const packet = c.bin.slice(0, size);
      c.bin = c.bin.slice(size);
      switch (packet[2]) {
        case 0x00:
          this.serverList(c, packet);
          break;
        case 0x02: {
          // Send a message to a hosting player (addressed by public IP and port) through QR2.
          if (packet.length < 9) break;
          const view = new DataView(packet.buffer);
          const target = this.qr2.get(`${view.getUint32(3)}:${view.getUint16(7)}`);
          if (target) this.qr2Message(target, packet.slice(9));
          else console.log('[wfc] message for a player who is not hosting');
          break;
        }
        case 0x03: // keep-alive reply
          break;
        default:
          console.log(`[wfc] unhandled server browser request 0x${packet[2].toString(16)}`);
      }
    }
  }

  serverList(c, packet) {
    let i = 9;
    const str = () => {
      const end = packet.indexOf(0, i);
      if (end < 0) throw new Error('truncated');
      const value = text.decode(packet.subarray(i, end));
      i = end + 1;
      return value;
    };
    let queryGame, gameName, challenge, filter, fieldText, options;
    try {
      queryGame = str();
      gameName = str();
      challenge = packet.slice(i, i + 8);
      i += 8;
      filter = str();
      fieldText = str();
      options = new DataView(packet.buffer).getUint32(i);
    } catch {
      return console.log('[wfc] malformed server list request');
    }
    const noList = (options & 0x02) !== 0;
    const fields = noList ? [] : fieldText.split('\\').filter(
      (f) => f && f !== ' ' && f !== 'publicip' && f !== 'publicport' && !f.startsWith('localip') && f !== 'localport');

    const out = [];
    const u16 = (v) => out.push((v >>> 8) & 255, v & 255);
    const u32 = (v) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    u32(c.player.ip);
    u16(c.srcPort);
    out.push(fields.length);
    for (const f of fields) out.push(0, ...bytes(f), 0);
    out.push(0);

    let listed = 0;
    if (!noList && filter && filter !== ' ' && filter !== '0') {
      for (const q of this.qr2.values()) {
        const keys = q.keys;
        if (!q.authenticated || keys.gamename !== queryGame || !keys.dwc_pid) continue;
        if (!matchesFilter(filter, keys)) continue;
        // Everyone in a room may see everyone's address, so list them plainly.
        let flags = 0x40 | 0x10 | 0x02 | 0x20 | 0x08; // keys, port, private IP, private port, ICMP IP
        if (keys.natneg && keys.natneg !== '0') flags |= 0x04;
        out.push(flags);
        u32(q.player.ip);
        u16(q.port);
        const local = (keys.localip0 ?? '').split('.').map(Number);
        if (local.length === 4 && local.every((n) => n >= 0 && n < 256)) out.push(...local);
        else u32(q.player.ip);
        u16(Number(keys.localport) || q.port);
        u32(0);
        for (const f of fields) out.push(0xff, ...bytes(keys[f] ?? ''), 0);
        listed++;
      }
      out.push(0x00, 0xff, 0xff, 0xff, 0xff);
    }
    console.log(`[wfc] server list for ${c.player.ip & 255}: ${listed} match(es) for "${filter}"`);
    this.reply(c, encryptTypeX(MKW_SECRET_KEY, challenge, Uint8Array.from(out)));
  }

  // QR2 "client message": FE FD 06 <session> <message key> <message>. The game answers 07 <key>.
  qr2Message(q, message) {
    const body = new Uint8Array(4 + message.length);
    body.set(crypto.getRandomValues(new Uint8Array(4)));
    body.set(message, 4);
    this.qr2Send(q, 0x06, body);
  }

  // --- NATNEG (UDP 27901) -------------------------------------------------------------------
  // Packets: FD FC 1E 66 6A B2 <version> <type> <cookie> <body>. Two players with the same cookie
  // are each told the other's game address; everyone in a room can reach everyone, so that works.

  natnegSend(player, port, version, type, cookie, body) {
    const out = new Uint8Array(12 + body.length);
    out.set([0xfd, 0xfc, 0x1e, 0x66, 0x6a, 0xb2, version, type]);
    new DataView(out.buffer).setUint32(8, cookie >>> 0);
    out.set(body, 12);
    this.io.sendUdp(player.ip, 27901, port, out);
  }

  natneg(player, port, data) {
    if (data.length < 12 || data[0] !== 0xfd || data[1] !== 0xfc) return;
    const version = data[6];
    const type = data[7];
    const cookie = new DataView(data.buffer, data.byteOffset).getUint32(8);
    const body = data.slice(12);
    let session = this.natnegSessions.get(cookie);
    if (!session) {
      session = { version, cookie, clients: new Map() };
      this.natnegSessions.set(cookie, session);
      setTimeout(() => this.natnegSessions.delete(cookie), 30000);
    }
    switch (type) {
      case 0x00: { // init
        if (body.length < 10) return;
        const [portType, index, useGamePort] = body;
        this.natnegSend(player, port, version, 0x01, cookie,
          Uint8Array.of(portType, index, 0xff, 0xff, 0x6d, 0x16, 0xb5, 0x7d, 0xea));
        let client = session.clients.get(index);
        if (!client) {
          client = { index, connectAck: false, sent: false };
          session.clients.set(index, client);
        }
        if (portType !== 0) client.negotiate = { player, port };
        if (useGamePort === 0 || portType === 0) client.server = { ip: player.ip, port };
        this.natnegConnect(session);
        return;
      }
      case 0x06: { // connect acknowledged
        const client = session.clients.get(body[1]);
        if (client) client.connectAck = true;
        return;
      }
      case 0x0d: { // report
        const reply = body.slice(0, 9);
        if (reply.length > 2) reply[2] = 0;
        this.natnegSend(player, port, version, 0x0e, cookie, reply);
        console.log(`[wfc] NATNEG ${cookie.toString(16)}: player ${player.ip & 255} reports result ${body[2]}`);
        return;
      }
      case 0x0f: { // pre-init: always ready
        const reply = body.slice(0, 6);
        if (reply.length > 1) reply[1] = 2;
        this.natnegSend(player, port, version, 0x10, cookie, reply);
        return;
      }
      default:
        console.log(`[wfc] NATNEG packet 0x${type.toString(16)} from ${player.ip & 255}`);
    }
  }

  natnegConnect(session) {
    const mapped = [...session.clients.values()].filter((c) => c.negotiate && c.server);
    if (mapped.length < 2) return;
    for (const client of mapped) {
      if (client.sent) continue;
      const other = mapped.find((o) => o !== client);
      client.sent = true;
      console.log(`[wfc] NATNEG ${session.cookie.toString(16)}: connecting players ${client.server.ip & 255} and ${other.server.ip & 255}`);
      const send = (tries) => {
        if (session.cancelled || client.connectAck || tries === 0) return;
        const body = new Uint8Array(8);
        new DataView(body.buffer).setUint32(0, other.server.ip >>> 0);
        new DataView(body.buffer).setUint16(4, other.server.port);
        body[6] = 0x42; // "got your data"
        this.natnegSend(client.negotiate.player, client.negotiate.port, session.version, 0x05, session.cookie, body);
        setTimeout(() => send(tries - 1), 500);
      };
      send(10);
    }
  }
}
