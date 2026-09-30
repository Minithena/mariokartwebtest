// GameSpy "enctypeX", which encrypts server browser replies. Ported from WiiLink WFC's
// common/encryption.go (AGPL-3.0); checked against the decoder in the AltWFC server emulator.
//
// encryptTypeX(key, challenge, data): key is the game's secret key ("9r3Rmy" for Mario Kart Wii),
// challenge the 8 bytes the client sent with its request. All three are Uint8Arrays.

export function encryptTypeX(key, challengeIn, data) {
  const challenge = Uint8Array.from(challengeIn); // enctypexFuncX mutates it
  const out = new Uint8Array(20 + data.length);
  out.set(crypto.getRandomValues(new Uint8Array(20)));
  out.set(data, 20);

  const headerLen = 7;
  out[0] = (headerLen - 2) ^ 0xec;
  out[1] = 0;
  out[2] = 0;
  out[headerLen - 1] = (20 - headerLen) ^ 0xea;
  const header = out.slice(0, 20);

  const encxkey = new Uint8Array(261);
  // initEncrypt: the random bytes after the header seed the key schedule
  const dataStart = out[headerLen - 1] ^ 0xea;
  funcX(encxkey, key, challenge, out.subarray(headerLen, headerLen + dataStart));
  const body = out.slice(headerLen + dataStart);
  for (let i = 0; i < body.length; i++) body[i] = func7e(encxkey, body[i]);

  const result = new Uint8Array(header.length + body.length);
  result.set(header);
  result.set(body, header.length);
  return result;
}

function funcX(encxkey, key, challenge, seed) {
  for (let i = 0; i < seed.length; i++) {
    challenge[(key[i % key.length] * i) & 7] ^= challenge[i & 7] ^ seed[i];
  }
  func4(encxkey, challenge, 8);
}

function func4(encxkey, id, idLen) {
  for (let i = 0; i < 256; i++) encxkey[i] = i;
  const state = { n1: 0, n2: 0 };
  for (let i = 255; i !== -1; i--) {
    const t1 = func5(encxkey, i, id, idLen, state);
    const t2 = encxkey[i];
    encxkey[i] = encxkey[t1];
    encxkey[t1] = t2;
  }
  encxkey[256] = encxkey[1];
  encxkey[257] = encxkey[3];
  encxkey[258] = encxkey[5];
  encxkey[259] = encxkey[7];
  encxkey[260] = encxkey[state.n1 & 0xff];
}

function func5(encxkey, cnt, id, idLen, state) {
  if (cnt === 0) return 0;
  let mask = 1;
  if (cnt > 1) {
    do mask = (mask << 1) + 1;
    while (mask < cnt);
  }
  let i = 0;
  let tmp;
  do {
    state.n1 = (encxkey[state.n1 & 0xff] + id[state.n2]) & 0xff; // byte arithmetic in the original
    state.n2 += 1;
    if (state.n2 >= idLen) {
      state.n2 = 0;
      state.n1 += idLen;
    }
    tmp = state.n1 & mask;
    i += 1;
    if (i > 11) tmp %= cnt;
  } while (tmp > cnt);
  return tmp;
}

function func7e(k, d) {
  let a = k[256];
  let b = k[257];
  let c = k[a];
  k[256] = (a + 1) & 0xff;
  k[257] = (b + c) & 0xff;

  a = k[260];
  b = k[257];
  b = k[b];
  c = k[a];
  k[a] = b;

  a = k[259];
  b = k[257];
  a = k[a];
  k[b] = a;

  a = k[256];
  b = k[259];
  a = k[a];
  k[b] = a;

  a = k[256];
  k[a] = c;

  b = k[258];
  a = k[c];
  c = k[259];
  b = (a + b) & 0xff;
  k[258] = b;

  a = b;
  c = k[c];
  b = k[257];
  b = k[b];
  a = k[a];
  c = (b + c) & 0xff;
  b = k[260];
  b = k[b];
  c = (b + c) & 0xff;
  b = k[c];
  c = k[256];
  c = k[c];
  a = (a + c) & 0xff;
  c = k[b];
  b = k[a];
  c ^= b ^ d;
  k[260] = c;
  k[259] = d;
  return c;
}
