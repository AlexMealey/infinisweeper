# Multiplayer Plan — InfiniSweeper Co-op

Turn the single-player app into a co-op experience: a share link opens the same
board for two (or more) players, each other's cursors visible with their names
attached, moves synchronized, all existing features preserved.

## Architecture at a glance

**Transport:** short-polling HTTP. Every ~300ms each client hits one PHP
endpoint that sends its recent activity (cursor + any new moves) and receives
whatever's changed since its last known version. This keeps PHP stateless
(fits shared hosting / cheap LAMP) — no WebSocket daemon, no long-running
process, no Swoole/Ratchet.

**Authority:** server-authoritative moveLog. Clients propose moves; the server
assigns a global order and both clients replay. Cursor positions are
best-effort broadcast (no ordering required, latest-wins per player).

**Room = shared game.** Players are looking at the same board, same seed,
same reveal state. Cursors show who's where; either player's click affects
the shared board.

## Server side (PHP, ~3 endpoints)

```
php/
├── create-room.php    POST — mints a room
├── sync.php           POST — the one hot-path endpoint
└── lib.php            shared: room load/save, ID gen, rate limit
data/
└── rooms/
    └── <room_id>.json   one file per active room
```

**Storage: one JSON file per room** (`data/rooms/<id>.json`). Simplest
possible; no DB, no migrations. `flock` during read-modify-write to serialize
concurrent syncs. If load ever becomes a problem, swap to SQLite behind the
same `lib.php` API — no client change.

Room file shape:

```json
{
  "version": 42,
  "seed": "abc123",
  "hints": { ... },
  "moveLog": "r5,3;r6,3;f5,4;...",
  "moveOwners": "abcd1234;abcd1234;ef567890;...",
  "players": {
    "<pid>": {
      "name": "Alice",
      "color": "#5b9bd5",
      "cursor": { "x": 12, "y": -3, "cellSize": 36 },
      "lastSeen": 1727548800
    }
  },
  "createdAt": ..., "lastActivity": ...
}
```

**Endpoints:**

`POST create-room.php` — body `{seed?, hints?}` → returns `{roomId, playerId}`.

`POST sync.php` — body `{roomId, playerId, name, sinceVersion, moveIndex, cursor, moves}` →
returns `{version, moveIndex, newMoves, players, hints, seed}`. The server appends
the client's moves to the moveLog, updates that player's cursor, bumps `version`,
returns everything the client is behind on.

**Housekeeping:** on any load, kick players where `lastSeen < now() - 30s`.
`create-room.php` opportunistically GC's rooms where `mtime < now() - 24h`.

**Guardrails:** cap `moves` array length per request (50). Cap name to 24 chars,
strip HTML. Room IDs are 32 hex chars of `random_bytes`.

## Client side (JS additions)

**Entry:** if URL has `?room=<id>`, boot into multiplayer mode.
Otherwise unchanged single-player.

```
js/
├── net.js               polling loop, request batching, reconnect (regular JS)
```

Multiplayer React components (`NamePromptModal`, `CursorOverlay`,
`MultiplayerBadge`) live in `components.js` alongside the existing UI.

**net.js — the sync loop.** Poll every 300ms. Batch: outgoing cursor + any
moves accumulated since last tick; incoming applied through the same
`applyReveal` / `applyFlag` functions already in `game.js`. Server response
contains only *new* tail moves so replay cost stays bounded. Backoff on errors
(300ms → 1s → 3s → 10s cap) with a visible status dot.

**State reconciliation.** On each sync response, new tail moves are appended
to a canonical move log kept in a ref, then `replayMoveLog` rebuilds `cells`,
`moves`, `flags`, `gameOver`, `firstClick`. Same code path used for
load-from-save, so first-click safety, chord-flag, and game-over all just
work.

**Cursor overlay.** Absolutely-positioned div layer *inside* the game
container. For each other player: a small cursor SVG + name badge at their
`(x, y)` world coordinates, translated into the local viewport. Own cursor
tracked via `mousemove` on the grid container, converted to world coords,
sent throttled to ~10 Hz (skip if unchanged).

**Share link UI.** In multiplayer mode, header shows a `MultiplayerBadge`
with connection dot, player count, "🔗 Invite" and leave buttons.
In single-player, a "👥 Play with a friend" button in the header POSTs to
`create-room.php` with the current seed + hints, then navigates to
`?room=<id>`.

**Name entry.** First time a room is joined without a stored name,
`NamePromptModal` appears. Name persisted in
`localStorage['minesweeper_name']`. `playerId` stored per room in
`localStorage['minesweeper_room_<id>']` so refresh keeps the same identity.

## Feature preservation

| Existing feature | Multiplayer treatment |
|---|---|
| Seeded board | Shared — set once by whoever creates room; locked after first move |
| Reveal / flag / chord | Shared moveLog — both players' actions apply |
| Chord-flag (new setting) | Shared — comes from `hints` in room state |
| Undo | Shared. Either player triggers undo → applied to shared moveLog. Undo counter is shared too. |
| Hints (wrong flags, pulse neighbors, chordFlag, undoMode) | Shared. Whoever changes settings updates room hints; other client picks up on next sync. |
| UI settings (zoom, view mode, arrow buttons, showScores, etc.) | Per-client — never synced. Purely local visualization. |
| Save / Load JSON | Per-client. Loading a save in multiplayer prompts "leave room and load locally?" |
| Leaderboard | Per-client (localStorage) — multiplayer runs get a `coop:` prefix on the seed field to distinguish them |
| Image / video export | Per-client, unchanged — draws from local `cells` state |
| PWA offline | Still works for single-player. In multiplayer, show "offline — moves will sync when reconnected" and queue outgoing moves. |
| First-click safety | Applies to the *first move of the whole room*, not the first move per player |
| Game over | Shared. Whoever hits a mine ends the shared game. Game-over modal shows who died. |

## Rollout phases

**Phase 1 — MVP (get it working)** ← draft complete
- `create-room.php` + `sync.php` with JSON-file storage
- Share link, name prompt, cursor overlay for other players
- Shared reveal/flag/chord moves
- Reconnect on transient failures

**Phase 2 — feature parity** ← draft complete
- ✅ Shared undo: `'u'` moves round-trip; server rewrites the last matching `'r'` in
  moveLog in-place and bumps `logRevision`; clients rebuild from the full moveLog
  when their `logRevision` is stale.
- ✅ Shared hint settings: whitelisted gameplay hints (`wrongFlags`, `pulseNeighbors`,
  `undoEnabled`, `undoMode`, `chordFlag`) sync via `Net.sendHints`; server merges;
  echo loop prevented by comparing incoming server hints to a `lastSyncedHintsRef`
  snapshot before setHints fires.
- ✅ Shared game-over modal: server sends `moveOwners` parallel to moveLog; client
  looks up the last `'r'` entry's owner tag against the connected players map to
  show "{Name} hit a mine." (or "You hit a mine." if it was you).
- ✅ Player list UI: `PlayerListDropdown` shows every connected player with their
  color dot, name, and last-known cursor coords. Clicking anyone else pans the
  viewport to their cursor.
- ✅ First-click race: handled implicitly by the full-rebuild flow — since the
  client always replays from the server's canonical log, whoever's first move
  landed first at the server is the shared first-click for everyone. Local
  optimistic state may briefly differ then reconciles on next sync.
- Owner-tag-based echo skipping — deferred. Currently the full-rebuild-on-sync
  design means own moves get "reapplied" during replay, but replay is
  idempotent so there's no visible flicker in the common case. Real
  echo-skipping (skip append of moves whose owner is us) would save a bit of
  CPU on long games; it's a Phase-3 optimization.

**Phase 3 — polish**
- Room GC (24h TTL) via cron *and* opportunistic
- Rate limiting + name sanitization (already partly in Phase 1)
- Sync backoff indicator in header
- "Go to player" navigation — jump your viewport to another player's viewport center (uses `player.view`, not their cursor)

## Trade-offs / open questions

1. **Polling interval vs. server load** — 300ms is smooth for cursor movement
   but 3.3 req/s/player. 500ms is cheaper but cursors feel laggy. Adaptive
   (fast when someone's actively moving, slow when idle) is best but doubles
   complexity. **MVP: 300ms fixed.**
2. **Player cap** — 2 as originally described, or open-ended? Protocol is
   open-ended; UI designed for 2–4.
3. **Undo semantics** — shared undo means Alice can undo Bob's last move.
   Fine for co-op but worth confirming. **Recommend: shared.**
4. **Settings that are shared vs. local** — gameplay hints shared, UI settings
   local. Feels right but is a design call.
5. **Storage format** — JSON files are simplest but every sync rewrites the
   whole file. For 8-player rooms with 10k+ moves, that's ~500KB rewrites at
   ~30 Hz total. SQLite scales better here. **MVP: JSON; SQLite is a swap
   behind `lib.php` when needed.**
6. **Hosting requirements** — shared hosting works. If persistent process
   capability exists, WebSockets via Ratchet cut latency by ~150ms and drop
   server CPU dramatically — worth revisiting after MVP if latency bothers
   you.
