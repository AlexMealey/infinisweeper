// net.js – the multiplayer sync loop, exposed as window.Net. Each request sends our queued moves and cursor and
// brings back whatever we're behind on; the server owns move order. Clicks go out at once instead of waiting a poll.
(function(){
    const POLL_ACTIVE_MS = 250;  // while anyone in the room is doing something
    const POLL_IDLE_MS = 500;    // once the room has been quiet for IDLE_AFTER_MS
    const IDLE_AFTER_MS = 5000;
    const MIN_SEND_GAP_MS = 100; // clicks closer than this share a request (keeps under the server's rate limit)
    const CURSOR_MIN_INTERVAL_MS = 100;
    const BACKOFF_STEPS_MS = [500, 1500, 4000, 10000];

    let config = null;           // {roomId, playerId, name, onSync, onError, onStatus, onBackoff, endpoint}
    let running = false;
    let timer = null;
    let requestInFlight = false;
    let sinceVersion = 0;
    let moveIndex = 0;           // server log entries we've applied
    let logRevision = 0;         // bumps when an undo rewrites the server's log
    let round = null;            // bumps when the room starts over; null until the first sync
    let queuedMoves = [];
    let pendingCursor = null;
    let pendingHints = null;
    let pendingReset = null;
    let pendingVote = null;
    let viewCenter = null;       // sent with every request once set
    let lastActivityAt = 0;      // last local input or remote change; picks the poll rate
    let lastOthersPositions = '';
    let nextSyncAt = 0;
    let lastSentAt = 0;
    let resendWhenDone = false;  // a click came in mid-request
    let lastCursorSentAt = 0;
    let failedSyncs = 0;

    function debugLog(...args){ if (window.NET_DEBUG) console.log('[net]', ...args); }

    function scheduleSync(delay){
        nextSyncAt = Date.now() + delay;
        timer = setTimeout(sync, delay);
    }

    function isIdle(){ return Date.now() - lastActivityAt >= IDLE_AFTER_MS; }

    function markActive(){
        const wasIdle = isIdle();
        lastActivityAt = Date.now();
        // Waking up: bring the pending idle-rate sync forward to the active rate (unless backing off after errors).
        if (wasIdle && running && timer && !requestInFlight && failedSyncs === 0) {
            const activeDueAt = nextSyncAt - POLL_IDLE_MS + POLL_ACTIVE_MS;
            if (activeDueAt < nextSyncAt) { clearTimeout(timer); scheduleSync(Math.max(0, activeDueAt - Date.now())); }
        }
    }

    function msUntilSendAllowed(){ return Math.max(0, lastSentAt + MIN_SEND_GAP_MS - Date.now()); }

    // Sends queued clicks now rather than at the next poll. Calls from one event (a chord flag queues several
    // moves) share a request. Error backoff is left alone.
    function sendSoon(){
        if (!running || failedSyncs > 0) return;
        if (requestInFlight) { resendWhenDone = true; return; }
        const wait = msUntilSendAllowed();
        if (timer && nextSyncAt - Date.now() <= wait) return;
        clearTimeout(timer);
        scheduleSync(wait);
    }

    function otherPlayersPositions(players){
        let s = '';
        for (const pid in players || {}) {
            if (pid === config.playerId) continue;
            const p = players[pid] || {};
            s += pid + ':' + (p.cursor ? p.cursor.x + ',' + p.cursor.y : '') + '|' + (p.view ? p.view.x + ',' + p.view.y : '') + ';';
        }
        return s;
    }

    async function sync(){
        if (!running || requestInFlight) return;
        requestInFlight = true;
        lastSentAt = Date.now();
        resendWhenDone = false;
        // Take what's queued now; anything arriving mid-request goes in the next one.
        const moves = queuedMoves;
        queuedMoves = [];
        // Leave the cursor out if one went very recently and nothing else is going.
        const cursor = (moves.length > 0 || Date.now() - lastCursorSentAt >= CURSOR_MIN_INTERVAL_MS) ? pendingCursor : null;
        if (cursor) lastCursorSentAt = Date.now();
        const hints = pendingHints;
        pendingHints = null;
        const reset = pendingReset;
        pendingReset = null;
        const vote = pendingVote;
        pendingVote = null;

        try {
            const res = await fetch(config.endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    roomId: config.roomId,
                    playerId: config.playerId,
                    name: config.name,
                    sinceVersion,
                    moveIndex,
                    logRevision,
                    cursor,
                    view: viewCenter,
                    moves,
                    hints,
                    round, // the server drops moves and resets from an older round
                    reset,
                    vote,
                }),
                cache: 'no-store', // never from the service worker's cache
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            failedSyncs = 0;
            if (config.onStatus) config.onStatus('connected');

            if (typeof data.version === 'number') sinceVersion = data.version;
            if (typeof data.moveIndex === 'number') moveIndex = data.moveIndex;
            if (typeof data.logRevision === 'number') logRevision = data.logRevision;
            if (typeof data.round === 'number') round = data.round;
            // Others' activity keeps the active rate too, so watching someone play stays smooth.
            const positions = otherPlayersPositions(data.players);
            if (positions !== lastOthersPositions || (data.newMoves && data.newMoves.length) || typeof data.moveLog === 'string'
                    || (data.resetVote && data.resetVote.status === 'open')) markActive();
            lastOthersPositions = positions;
            if (config.onSync) config.onSync(data);
        } catch (err) {
            // Requeue everything unsent, so a failed request loses nothing.
            queuedMoves = moves.concat(queuedMoves);
            if (hints && !pendingHints) pendingHints = hints;
            if (reset && !pendingReset) pendingReset = reset;
            if (vote && !pendingVote) pendingVote = vote;
            failedSyncs++;
            if (config.onStatus) config.onStatus('disconnected');
            if (config.onError) config.onError(err);
            debugLog('sync error', err);
        } finally {
            requestInFlight = false;
            if (running) {
                const delay = failedSyncs > 0
                    ? BACKOFF_STEPS_MS[Math.min(failedSyncs - 1, BACKOFF_STEPS_MS.length - 1)]
                    : resendWhenDone ? msUntilSendAllowed()
                    : (isIdle() ? POLL_IDLE_MS : POLL_ACTIVE_MS);
                if (failedSyncs > 0 && config.onBackoff) config.onBackoff({retryInMs: delay, errStreak: failedSyncs});
                scheduleSync(delay);
            }
        }
    }

    window.Net = {
        start(options){
            if (running) this.stop();
            config = Object.assign({endpoint: './php/sync.php'}, options);
            running = true;
            sinceVersion = 0;
            moveIndex = 0;
            logRevision = 0;
            round = null;
            queuedMoves = [];
            pendingCursor = null;
            pendingHints = null;
            pendingReset = null;
            pendingVote = null;
            viewCenter = null;
            lastActivityAt = Date.now(); // at the active rate while the room loads in
            lastOthersPositions = '';
            resendWhenDone = false;
            failedSyncs = 0;
            sync();
        },
        stop(){
            running = false;
            if (timer) { clearTimeout(timer); timer = null; }
            config = null;
        },
        // entry: ['r'|'f'|'u', x, y]
        sendMove(entry){
            if (!running || !entry || entry.length < 3) return;
            queuedMoves.push(entry);
            markActive();
            sendSoon();
        },
        // Our moves the server hasn't taken yet, tagged with our owner id like the server's newMoves. The board
        // lays these over the server's log, so a sync never briefly undoes a click.
        pendingMoves(){
            if (!running) return [];
            const owner = config.playerId.slice(0, 8);
            return queuedMoves.map(m => [m[0], m[1], m[2], owner]);
        },
        sendCursor(x, y, cellSize){
            if (!running) return;
            pendingCursor = {x, y, cellSize};
            markActive();
        },
        // Shared gameplay hints only; UI settings stay local.
        sendHints(hints){
            if (!running || !hints) return;
            pendingHints = hints;
            markActive();
            sendSoon();
        },
        // kind: 'restart' keeps the seed, 'new' switches to seed (or the server picks), 'load' takes a save file's
        // seed and encoded moveLog. needsVote: progress is at stake, so a non-founder's request goes to a vote.
        requestReset(kind, seed, needsVote, moveLog){
            if (!running) return;
            pendingReset = {kind, seed: seed || null, needsVote: !!needsVote, moveLog: kind === 'load' ? moveLog : undefined};
            markActive();
            sendSoon();
        },
        vote(id, yes){
            if (!running) return;
            pendingVote = {id, yes: !!yes};
            markActive();
            sendSoon();
        },
        // Our viewport centre in world coords, so other players can jump to it.
        setView(x, y){
            if (!running) return;
            viewCenter = {x, y};
            markActive();
        },
        updateName(name){
            if (config) config.name = name;
        },
        isRunning(){ return running; },
        flushNow(){ if (running && !requestInFlight) { if (timer) clearTimeout(timer); sync(); } },
    };
})();
