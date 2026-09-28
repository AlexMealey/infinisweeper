// net.js — polling loop for the multiplayer sync endpoint.
// Regular JS (no JSX), synchronous load, exposed on window.Net.
//
// Usage from the React layer:
//   Net.start({roomId, playerId, name, onSync: ({newMoves, players, hints, seed}) => {...}})
//   Net.sendMove(['r', 5, 3])   // called after a local move is applied
//   Net.sendCursor(worldX, worldY, cellSize)  // called on mousemove
//   Net.stop()
//
// One sync request per tick carries both directions: outgoing (queued moves +
// latest cursor) and incoming (whatever the client is behind on). Server owns
// canonical move ordering.
(function(){
    const POLL_INTERVAL_MS = 250;
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
    let lastCursorSent = 0;
    let errStreak = 0;

    function log(...a){ if (window.NET_DEBUG) console.log('[net]', ...a); }

    async function tick(){
        if (!running || inflight) return;
        inflight = true;
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
            if (cfg.onSync) cfg.onSync(data);
        } catch (err) {
            // Put unsent moves back at the head of the queue so nothing is dropped.
            outMoves = moves.concat(outMoves);
            // Requeue hints too so a transient error doesn't lose the user's toggle.
            if (hints && !pendingHints) pendingHints = hints;
            errStreak++;
            if (cfg.onStatus) cfg.onStatus('disconnected');
            if (cfg.onError) cfg.onError(err);
            log('sync error', err);
        } finally {
            inflight = false;
            if (running) {
                const delay = errStreak === 0
                    ? POLL_INTERVAL_MS
                    : BACKOFF_STEPS_MS[Math.min(errStreak - 1, BACKOFF_STEPS_MS.length - 1)];
                if (errStreak > 0 && cfg.onBackoff) cfg.onBackoff({retryInMs: delay, errStreak});
                timer = setTimeout(tick, delay);
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
        },
        sendCursor(x, y, cellSize){
            if (!running) return;
            pendingCursor = {x, y, cellSize};
        },
        sendHints(hints){
            // Shared gameplay hints only — UI settings never round-trip through here.
            if (!running || !hints) return;
            pendingHints = hints;
        },
        setView(x, y){
            // Viewport center in world coords. Sent every tick so other players can "go to" us.
            if (!running) return;
            currentView = {x, y};
        },
        updateName(name){
            if (cfg) cfg.name = name;
        },
        isRunning(){ return running; },
        // Exposed for the UI so it can show "syncing…" state or force an immediate tick.
        flushNow(){ if (running && !inflight) { if (timer) clearTimeout(timer); tick(); } },
    };
})();
