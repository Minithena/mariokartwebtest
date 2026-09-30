# Private multiplayer rooms

This Worker hosts a room relay and a small Nintendo WFC protocol implementation. It serves no
game files. Each invite gets an isolated Durable Object; a player can only send game packets to
players in that room. A room accepts at most 12 browser connections.

The game speaks its original WFC matchmaking and peer protocols. Virtual sockets in the
WiiCompiled web runtime carry those packets over WSS to this Worker. Race packets are relayed
over WebSockets; this implementation does not use WebRTC or connect to Nintendo/Wiimmfi.

```sh
npm install
npm test
npm run dev
# After validation:
npm run deploy
```

With the service running, `node test/live-smoke.mjs http://127.0.0.1:8787` checks real WebSocket
admission, NAS login and GameSpy proof, two clients with the same seeded account, 360 relayed
datagrams, and room isolation. Pass the deployed HTTPS origin to run the same smoke test there.

For a local game served on port 8000, create a room in the controls sidebar. Open its invite in
two independent browser profiles (or use `127.0.0.1` for one player and `localhost` for the other).
Each player chooses **Nintendo WFC → Worldwide → VS Race** in the game. Despite the menu label,
matchmaking is restricted to the invite's room. Saves remain in each browser's own storage.

The hosted game still requires the existing Cloudflare Access login. Keep that protection on;
the separate room Worker contains no disc data and uses unguessable invite codes for admission.
Do not publish game assets, generated translation files, or the compiled game in either repo.

For packet-rate diagnostics, start Wrangler with `--var TRACE_TRAFFIC:1`. Room and profile data
are temporary and are removed when players leave; a Worker restart disconnects active rooms.

## Licence and provenance

The room server is AGPL-3.0-only; see [LICENSE](LICENSE). The game page links to its published
source. `src/enctypex.js` is adapted from WiiLink WFC's `common/encryption.go`; `src/wfc.js` follows
the protocols implemented by these AGPL projects:

- [WiiLink24/wfc-server](https://github.com/WiiLink24/wfc-server), reference commit
  `f0825bf89a28de560de99006802e065e17b9e038`.
- [AltWFC server emulator](https://github.com/barronwaffles/dwc_network_server_emulator), reference
  commit `2c65a9f6afe508e236c222bd1b8f26fd63621a91` (also used to check the enctypeX port).

The WiiCompiled runtime changes remain under that project's GPL licence.
