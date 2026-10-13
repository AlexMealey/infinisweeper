<?php
// sync.php – one poll from a client (see net.js): applies what it sends, then returns the room and the moves the
// client hasn't seen, or the whole log after an undo rewrote it.

require __DIR__ . '/lib.php';

handle_preflight();
require_post();
ignore_user_abort(true); // a dropped connection mustn't stop a request between its file writes

$body = read_json_body();

$roomId          = $body['roomId']   ?? '';
$playerId        = $body['playerId'] ?? '';
$name            = isset($body['name']) ? sanitize_name((string)$body['name']) : 'Player';
$color           = (isset($body['color']) && is_string($body['color']) && preg_match('/^#[0-9a-fA-F]{6}$/', $body['color']))
                   ? strtolower($body['color']) : null; // the player's pick; null takes one from the name
$cursor          = $body['cursor'] ?? null;
$view            = $body['view']   ?? null;
$ping            = (isset($body['ping']) && is_array($body['ping'])) ? $body['ping'] : null;
$moves           = is_array($body['moves'] ?? null) ? $body['moves'] : [];
$clientRevision  = isset($body['logRevision']) ? (int)$body['logRevision'] : 0;
$clientHints     = (isset($body['hints']) && is_array($body['hints'])) ? $body['hints'] : null;
$resetRequest    = (isset($body['reset']) && is_array($body['reset'])) ? $body['reset'] : null;
$voteReply       = (isset($body['vote'])  && is_array($body['vote']))  ? $body['vote']  : null;
$clientRound     = (isset($body['round']) && is_numeric($body['round'])) ? (int)$body['round'] : null;

if (!is_valid_id($roomId))   error_response('bad roomId');
if (!is_valid_id($playerId)) error_response('bad playerId');

if (count($moves) > MAX_MOVES_PER_REQ) $moves = array_slice($moves, 0, MAX_MOVES_PER_REQ);

[$room, $lock] = open_room($roomId);
if (!$room) error_response('room not found', 404);

// --- This player's presence ---
if (!isset($room['players']) || !is_array($room['players'])) $room['players'] = [];
$player = $room['players'][$playerId] ?? [];

// Checked before any other change. A rejected request saves nothing: under 1 token the bucket refills to the same
// level whether or not this attempt is recorded. The client backs off on 429.
if (!take_rate_token($player)) {
    close_room($lock);
    error_response('rate limited', 429);
}

$player['name']     = $name;
$player['color']    = $color ?? color_from_name($name);
$player['lastSeen'] = time();
// {hidden: true}: the mouse left the board or the player stopped sharing it.
if (is_array($cursor) && !empty($cursor['hidden'])) {
    $player['cursor'] = null;
} elseif (is_array($cursor) && coord($cursor['x'] ?? null) !== null && coord($cursor['y'] ?? null) !== null) {
    $player['cursor'] = [
        'x'        => coord($cursor['x']),
        'y'        => coord($cursor['y']),
        'cellSize' => isset($cursor['cellSize']) ? (int)$cursor['cellSize'] : 36,
    ];
}
// The viewport centre, for other players' "go to" (whole cells).
if (is_array($view) && coord($view['x'] ?? null) !== null && coord($view['y'] ?? null) !== null) {
    $player['view'] = [
        'x' => (int)$view['x'],
        'y' => (int)$view['y'],
    ];
}
// A middle-click ping on a cell, announced to the others as an event. Bad or too-frequent pings are dropped.
$pinged = false;
if ($ping !== null && coord($ping['x'] ?? null) !== null && coord($ping['y'] ?? null) !== null) {
    $px = coord($ping['x']);
    $py = coord($ping['y']);
    $now = microtime(true);
    if ($now - (float)($player['lastPingAt'] ?? 0) >= PING_MIN_GAP_SEC) {
        $player['lastPingAt'] = $now;
        add_event($room, 'ping', $playerId, $name, ['x' => (int)floor($px), 'y' => (int)floor($py)]);
        $pinged = true;
    }
}
$room['players'][$playerId] = $player;

// --- Shared gameplay hints (UI settings never reach the server) ---
if ($clientHints !== null) {
    $allowed = ['wrongFlags', 'pulseNeighbors', 'undoEnabled', 'undoMode', 'chordFlag'];
    $current = $room['hints'] ?? [];
    $changed = false;
    foreach ($allowed as $k) {
        if (!array_key_exists($k, $clientHints)) continue;
        $v = $clientHints[$k];
        if ($k === 'undoMode') {
            if ($v !== 'refill' && $v !== 'infinite' && $v !== 'stack') continue;
        } else {
            if (!is_bool($v)) $v = (bool)$v;
        }
        if (!array_key_exists($k, $current) || $current[$k] !== $v) {
            $current[$k] = $v;
            $changed = true;
        }
    }
    if ($changed) $room['hints'] = $current;
}

// --- Moves ---
// The owners file runs parallel to the log, with the first 8 hex chars of each move's playerId. An undo isn't
// appended: it rewrites the reveal it undoes and bumps logRevision, so every client refetches the whole log.
$logRevision = (int)($room['logRevision'] ?? 0);
$owner       = substr($playerId, 0, 8);
$log         = null; // the saved log, read only if an undo needs it
$added       = '';   // entries this request appends
$addedOwners = '';
$undone      = [];   // offsets of saved reveals this request undoes, rewritten in place
$newRound    = null; // [log, owners] when this request starts a round

// Moves and resets made before someone else's reset belong to the old board, so they're dropped.
if ($clientRound !== null && $clientRound !== (int)($room['round'] ?? 0)) {
    $moves        = [];
    $resetRequest = null;
}

$logChanges = 0;
foreach ($moves as $m) {
    if (!is_array($m) || count($m) < 3) continue;
    $type = (string)$m[0];
    if (($type !== 'r' && $type !== 'f' && $type !== 'u') || coord($m[1]) === null || coord($m[2]) === null) continue;
    $x = (int)$m[1];
    $y = (int)$m[2];

    if ($type !== 'u') {
        $added       .= $type . $x . ',' . $y . ';';
        $addedOwners .= $owner . ';';
        $logChanges++;
        continue;
    }
    if ($log === null && ($log = read_log($roomId, $room, 'log')) === null) { close_room($lock); error_response('room log damaged', 500); }
    $all = $log . $added; // the reveal can be one sent earlier in this request
    $at  = undo_reveal($all, $x, $y);
    if ($at < 0) continue;
    if ($at < strlen($log)) { $log[$at] = 'u'; $undone[] = $at; }
    else $added = substr($all, strlen($log));
    $logRevision++;
    $logChanges++;
    add_event($room, 'undo', $playerId, $name);
}

// --- Start over ---
// A loaded save's seed must survive sanitizing unchanged, or its moves would land on a different board. Bad loads
// are dropped rather than rejected, since Net would retry an error forever.
if ($resetRequest !== null && ($resetRequest['kind'] ?? '') === 'load') {
    $rawSeed = $resetRequest['seed'] ?? null;
    if (!is_string($rawSeed) || $rawSeed === '' || sanitize_seed($rawSeed) !== $rawSeed
            || !is_string($resetRequest['moveLog'] ?? null) || !is_valid_move_log($resetRequest['moveLog'])) {
        $resetRequest = null;
    }
}
$voteBefore = $room['resetVote'] ?? null;
if ($resetRequest !== null) {
    $kind      = in_array($resetRequest['kind'] ?? '', ['new', 'load'], true) ? $resetRequest['kind'] : 'restart';
    $seed      = (isset($resetRequest['seed']) && is_string($resetRequest['seed'])) ? sanitize_seed($resetRequest['seed']) : null;
    $loadLog   = $kind === 'load' ? $resetRequest['moveLog'] : '';
    $isFounder = isset($room['founderId']) && $room['founderId'] === $playerId;
    if ($isFounder || empty($resetRequest['needsVote'])) { // needsVote: the client has progress at stake
        $newRound = start_new_round($room, $logRevision, $kind, $seed, $loadLog, $owner);
        add_event($room, $kind, $playerId, $name);
    } elseif (($voteBefore['status'] ?? null) !== 'open'
            && ($kind !== 'load' || file_put_contents(room_file($roomId, 'vote'), $loadLog) === strlen($loadLog))) {
        $room['resetVote'] = [ // the requester's vote counts as yes; a save to load waits in <id>.vote
            'id'        => random_hex_id(4),
            'by'        => $playerId,
            'byName'    => $name,
            'kind'      => $kind,
            'seed'      => $seed,
            'loadMoves' => substr_count($loadLog, ';'),
            'votes'     => [$playerId => true],
            'createdAt' => time(),
            'status'    => 'open',
        ];
    }
}
if ($voteReply !== null && ($room['resetVote']['status'] ?? null) === 'open'
        && ($voteReply['id'] ?? null) === $room['resetVote']['id']) {
    $room['resetVote']['votes'][$playerId] = !empty($voteReply['yes']);
}

// Pruned first, so players who left neither block the vote nor count toward the room's size.
prune_stale_players($room);
if (resolve_reset_vote($room) === 'passed') {
    $passed = $room['resetVote'];
    $loadLog = $passed['kind'] === 'load' ? (string)@file_get_contents(room_file($roomId, 'vote')) : '';
    $newRound = start_new_round($room, $logRevision, $passed['kind'], $passed['seed'], $loadLog, substr((string)$passed['by'], 0, 8));
    $room['resetVote'] = $passed; // keeps the result visible for a moment
}
$voteChanged = $resetRequest !== null || $voteReply !== null || ($room['resetVote'] ?? null) !== $voteBefore;

if ($logChanges > 0 || $cursor !== null || $view !== null || $clientHints !== null || $voteChanged || $pinged || !isset($room['version'])) {
    $room['version']      = ($room['version'] ?? 0) + 1;
    $room['lastActivity'] = time();
}
$room['logRevision'] = $logRevision;

// --- Commit ---
// Log files first, then the state, whose save is the commit: until then the state still records the old ends, so a
// failure here leaves the room as it was.
$oldGen = (int)($room['logGen'] ?? 0);
if ($newRound !== null) {
    $undone = []; // the old round's log is dropped, not edited
    $ok = write_log_files($roomId, $room, $newRound[0], $newRound[1]);
} else {
    $ok = append_log($roomId, $room, $added, $addedOwners);
    foreach ($undone as $at) $ok = $ok && write_at(log_file($roomId, $room, 'log'), $at, 'u');
}
if (!$ok || !save_room($roomId, $room)) {
    foreach ($undone as $at) write_at(log_file($roomId, $room, 'log'), $at, 'r'); // the saved state still has them as reveals
    close_room($lock);
    error_response('could not save the room', 500);
}
if ($newRound !== null) {
    @unlink(room_file($roomId, "$oldGen.log"));
    @unlink(room_file($roomId, "$oldGen.own"));
}
// A save waiting on a load vote is needed only while that vote is open.
if (($voteBefore['kind'] ?? null) === 'load' || ($room['resetVote']['kind'] ?? null) === 'load') {
    if (($room['resetVote']['status'] ?? null) !== 'open') @unlink(room_file($roomId, 'vote'));
}

// --- Response ---
$moveIndex = (int)$room['moveCount'];
$clientMoveIndex = isset($body['moveIndex']) ? (int)$body['moveIndex'] : 0;
if ($clientMoveIndex < 0) $clientMoveIndex = 0;

$response = [
    'version'     => $room['version'],
    'logRevision' => $logRevision,
    'moveIndex'   => $moveIndex,
    'players'     => (object)array_map(function($p){
        return [
            'name'     => $p['name']     ?? 'Player',
            'color'    => $p['color']    ?? '#5b9bd5',
            'cursor'   => $p['cursor']   ?? null,
            'view'     => $p['view']     ?? null,
            'lastSeen' => $p['lastSeen'] ?? 0,
        ];
    }, $room['players']),
    'hints'       => $room['hints'] ?? new stdClass(),
    'seed'        => $room['seed'] ?? '',
    'founderId'   => $room['founderId'] ?? null,
    'round'       => (int)($room['round'] ?? 0),
    'resetVote'   => vote_for_client($room, $playerId),
    'events'      => recent_events($room),
];

// The whole log when past entries changed (an undo or a new round), when the client is ahead of the server (it last
// talked to another deploy), or when it's far behind (a join): one string is far smaller than an array of moves.
// Every client version treats the string as a fresh copy.
$newMoves = ($clientRevision !== $logRevision || $clientMoveIndex > $moveIndex || $moveIndex - $clientMoveIndex > FULL_LOG_GAP)
    ? null : read_new_moves($roomId, $room, $clientMoveIndex);
if ($newMoves === null) {
    $response['moveLog']    = read_log($roomId, $room, 'log');
    $response['moveOwners'] = read_log($roomId, $room, 'own');
    $response['newMoves']   = [];
    if ($response['moveLog'] === null || $response['moveOwners'] === null) { close_room($lock); error_response('room log damaged', 500); }
} else {
    $response['newMoves'] = $newMoves;
}
close_room($lock); // before encoding and sending, so a slow client never holds up the room

json_response($response);
