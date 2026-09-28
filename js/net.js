// net.js — polling loop for the multiplayer sync endpoint.
// Regular JS (no JSX), synchronous load, exposed on window.Net.
//
// Usage from the React layer:
//   Net.start({roomId, playerId, name, onSync: ({newMoves, players, hints, seed}) => {...}})
//   Net.sendMove(['r', 5, 3])   // called after a local move is applied; sent right away
//   Net.pendingMoves()          // our moves the server hasn't taken yet
//   Net.sendCursor(worldX, worldY, cellSize)  // called on mousemove
//   Net.requestReset('restart'|'new'|'load', seed, needsVote, moveLog?)  // start over, or ask the room to
//   Net.vote(voteId, yes)                     // answer an open start-over vote
//   Net.stop()
//
// One sync request per tick carries both directions: outgoing (queued moves +
// latest cursor) and incoming (whatever the client is behind on). Server owns
// canonical move ordering. Clicks (moves, votes, resets) don't wait for the next
// poll: they go out straight away, or right after the request already in flight.
(function(){
    const POLL_ACTIVE_MS = 250;  // 4 syncs/sec while anyone in the room is doing something
    const POLL_IDLE_MS = 500;    // 2 syncs/sec once the room has been quiet for IDLE_AFTER_MS
    const IDLE_AFTER_MS = 5000;
    const MIN_SEND_GAP_MS = 100; // clicks closer together than this share a request (keeps under the server's rate limit)
    const CURSOR_MIN_INTERVAL_MS = 100; // rate-limit outgoing cursor updates
    const BACKOFF_STEPS_MS = [500, 1500, 4000, 10000];

    let cfg = null;             // {roomId, playerId, name, onSync, onError, onStatus, endpoint}
    let running = false;
    let timer = null;
    let inflight = false;
    let sinceVersion = 0;
    let moveIndex = 0;           // count of moveLog entries the client has applied from the server's log
    let logRevision = 0;         // last-seen server logRevision (bumps on undo rewrites)
    let outMoves = [];           // moves waiting to be sent
    let pendingCursor = null;    // latest cursor, to be sent on next sync
    let pendingHints = null;     // shared hints to push next sync (null = don't send)
    let currentView = null;      // latest viewport center in world coords — sent every tick when set
    let round = null;            // last-seen server round (bumps when the room starts over); null until first sync
    let pendingReset = null;     // start-over request to send next sync
    let pendingVote = null;      // our answer to an open start-over vote
    let lastActivityAt = 0;      // last local input or remote change — picks the poll rate
    let lastOthersSig = '';      // other players' cursor/view positions, to spot remote movement
    let timerDueAt = 0;          // when the pending tick fires
    let lastSentAt = 0;          // when the last request went out
    let flushWanted = false;     // a click came in mid-request: send again as soon as it returns
    let lastCursorSent = 0;
    let errStreak = 0;

    function log(...a){ if (window.NET_DEBUG) console.log('[net]', ...a); }

    function schedule(delay){
        timerDueAt = Date.now() + delay;
        timer = setTimeout(tick, delay);
    }

    function isIdle(){ return Date.now() - lastActivityAt >= IDLE_AFTER_MS; }

    function markActive(){
        const wasIdle = isIdle();
        lastActivityAt = Date.now();
        // Waking from idle: pull the pending slow tick forward so the first action goes out
        // POLL_ACTIVE_MS after the last sync, not POLL_IDLE_MS. (Not during error backoff.)
        if (wasIdle && running && timer && !inflight && errStreak === 0) {
            const soonest = timerDueAt - POLL_IDLE_MS + POLL_ACTIVE_MS;
            if (soonest < timerDueAt) { clearTimeout(timer); schedule(Math.max(0, soonest - Date.now())); }
        }
    }

    function sendGap(){ return Math.max(0, lastSentAt + MIN_SEND_GAP_MS - Date.now()); }

    // Send queued clicks now instead of at the next poll. Several calls in one event (a chord
    // flag queues many moves) land in the same request. Error backoff is left alone.
    function flushSoon(){
        if (!running || errStreak > 0) return;
        if (inflight) { flushWanted = true; return; }
        const wait = sendGap();
        if (timer && timerDueAt - Date.now() <= wait) return;
        clearTimeout(timer);
        schedule(wait);
    }

    function othersSig(players){
        let s = '';
        for (const pid in players || {}) {
            if (pid === cfg.playerId) continue;
            const p = players[pid] || {};
            s += pid + ':' + (p.cursor ? p.cursor.x + ',' + p.cursor.y : '') + '|' + (p.view ? p.view.x + ',' + p.view.y : '') + ';';
        }
        return s;
    }

    async function tick(){
        if (!running || inflight) return;
        inflight = true;
        lastSentAt = Date.now();
        flushWanted = false;
        // Snapshot outgoing state so anything that arrives mid-request goes in the next tick.
        const moves = outMoves;
        outMoves = [];
        const cursor = pendingCursor;
        // Skip cursor field entirely if we sent one very recently and nothing else is going out.
        const cursorToSend = (moves.length > 0 || (Date.now() - lastCursorSent) >= CURSOR_MIN_INTERVAL_MS) ? cursor : null;
        if (cursorToSend) lastCursorSent = Date.now();

        // Snapshot pending hints similarly so a mid-request change queues for the next tick.
        const hints = pendingHints;
        pendingHints = null;
        const reset = pendingReset;
        pendingReset = null;
        const vote = pendingVote;
        pendingVote = null;

        try {
            const body = {
                roomId: cfg.roomId,
                playerId: cfg.playerId,
                name: cfg.name,
                sinceVersion,
                moveIndex,
                logRevision,
                cursor: cursorToSend,
                view: currentView,
                moves,
                hints,
                // Server drops moves/reset tagged with an old round, so clicks made just before
                // someone else's reset don't land on the fresh board.
                round,
                reset,
                vote,
            };
            const res = await fetch(cfg.endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body),
                // Multiplayer state must always come from network, never from SW cache.
                cache: 'no-store',
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            errStreak = 0;
            if (cfg.onStatus) cfg.onStatus('connected');

            if (typeof data.version === 'number') sinceVersion = data.version;
            if (typeof data.moveIndex === 'number') moveIndex = data.moveIndex;
            if (typeof data.logRevision === 'number') logRevision = data.logRevision;
            if (typeof data.round === 'number') round = data.round;
            // Other players' activity keeps us at the fast rate too, so watching someone play stays smooth.
            const sig = othersSig(data.players);
            if (sig !== lastOthersSig || (data.newMoves && data.newMoves.length) || typeof data.moveLog === 'string'
                    || (data.resetVote && data.resetVote.status === 'open')) markActive();
            lastOthersSig = sig;
            if (cfg.onSync) cfg.onSync(data);
        } catch (err) {
            // Put unsent moves back at the head of the queue so nothing is dropped.
            outMoves = moves.concat(outMoves);
            // Requeue hints too so a transient error doesn't lose the user's toggle.
            if (hints && !pendingHints) pendingHints = hints;
            if (reset && !pendingReset) pendingReset = reset;
            if (vote && !pendingVote) pendingVote = vote;
            errStreak++;
            if (cfg.onStatus) cfg.onStatus('disconnected');
            if (cfg.onError) cfg.onError(err);
            log('sync error', err);
        } finally {
            inflight = false;
            if (running) {
                const delay = errStreak > 0
                    ? BACKOFF_STEPS_MS[Math.min(errStreak - 1, BACKOFF_STEPS_MS.length - 1)]
                    : flushWanted ? sendGap()
                    : (isIdle() ? POLL_IDLE_MS : POLL_ACTIVE_MS);
                if (errStreak > 0 && cfg.onBackoff) cfg.onBackoff({retryInMs: delay, errStreak});
                schedule(delay);
            }
        }
    }

    window.Net = {
        start(config){
            if (running) this.stop();
            cfg = Object.assign({endpoint: './php/sync.php'}, config);
            running = true;
            sinceVersion = 0;
            moveIndex = 0;
            logRevision = 0;
            outMoves = [];
            pendingCursor = null;
            pendingHints = null;
            currentView = null;
            round = null;
            pendingReset = null;
            pendingVote = null;
            lastActivityAt = Date.now(); // start at the fast rate while the room loads in
            lastOthersSig = '';
            flushWanted = false;
            errStreak = 0;
            // First tick fires immediately so the client gets initial state without a 300ms wait.
            tick();
        },
        stop(){
            running = false;
            if (timer) { clearTimeout(timer); timer = null; }
            cfg = null;
        },
        sendMove(entry){
            // entry: ['r'|'f'|'u', x, y]
            if (!running || !entry || entry.length < 3) return;
            outMoves.push(entry);
            markActive();
            flushSoon();
        },
        pendingMoves(){
            // Our moves the server hasn't taken yet, with our owner id like the server's newMoves.
            // The board lays these over the server's log so a sync never briefly undoes a click.
            if (!running) return [];
            const owner = cfg.playerId.slice(0, 8);
            return outMoves.map(m => [m[0], m[1], m[2], owner]);
        },
        sendCursor(x, y, cellSize){
            if (!running) return;
            pendingCursor = {x, y, cellSize};
            markActive();
        },
        sendHints(hints){
            // Shared gameplay hints only — UI settings never round-trip through here.
            if (!running || !hints) return;
            pendingHints = hints;
            markActive();
            flushSoon();
        },
        requestReset(kind, seed, needsVote, moveLog){
            // kind: 'restart' keeps the seed, 'new' switches to seed (server picks one if empty),
            // 'load' replaces the board with a save file's seed + encoded moveLog.
            // needsVote: there's progress at stake, so a non-founder's request goes to a room vote.
            if (!running) return;
            pendingReset = {kind, seed: seed || null, needsVote: !!needsVote, moveLog: kind === 'load' ? moveLog : undefined};
            markActive();
            flushSoon();
        },
        vote(id, yes){
            if (!running) return;
            pendingVote = {id, yes: !!yes};
            markActive();
            flushSoon();
        },
        setView(x, y){
            // Viewport center in world coords. Sent every tick so other players can "go to" us.
            if (!running) return;
            currentView = {x, y};
            markActive();
        },
        updateName(name){
            if (cfg) cfg.name = name;
        },
        isRunning(){ return running; },
        // Exposed for the UI so it can show "syncing…" state or force an immediate tick.
        flushNow(){ if (running && !inflight) { if (timer) clearTimeout(timer); tick(); } },
    };
})();
