<?php
// sync.php – one poll from a client (see net.js): applies what it sends, then returns the room and the moves the
// client hasn't seen, or the whole log after an undo rewrote it.

require __DIR__ . '/lib.php';

handle_preflight();
require_post();

$body = read_json_body();

$roomId          = $body['roomId']   ?? '';
$playerId        = $body['playerId'] ?? '';
$name            = isset($body['name']) ? sanitize_name((string)$body['name']) : 'Player';
$cursor          = $body['cursor'] ?? null;
$view            = $body['view']   ?? null;
$moves           = is_array($body['moves'] ?? null) ? $body['moves'] : [];
$clientRevision  = isset($body['logRevision']) ? (int)$body['logRevision'] : 0;
$clientHints     = (isset($body['hints']) && is_array($body['hints'])) ? $body['hints'] : null;
$resetRequest    = (isset($body['reset']) && is_array($body['reset'])) ? $body['reset'] : null;
$voteReply       = (isset($body['vote'])  && is_array($body['vote']))  ? $body['vote']  : null;
$clientRound     = (isset($body['round']) && is_numeric($body['round'])) ? (int)$body['round'] : null;

if (!is_valid_id($roomId))   error_response('bad roomId');
if (!is_valid_id($playerId)) error_response('bad playerId');

if (count($moves) > MAX_MOVES_PER_REQ) $moves = array_slice($moves, 0, MAX_MOVES_PER_REQ);

[$room, $lock] = load_room_locked($roomId);
if (!$room) error_response('room not found', 404);

// --- This player's presence ---
if (!isset($room['players']) || !is_array($room['players'])) $room['players'] = [];
$player = $room['players'][$playerId] ?? [];

// Checked before any other change; a rejected request still saves the bucket and lastSeen. The client backs off on 429.
if (!take_rate_token($player)) {
    $player['lastSeen'] = time();
    $room['players'][$playerId] = $player;
    save_room_and_unlock($room, $lock);
    error_response('rate limited', 429);
}

$player['name']     = $name;
$player['color']    = color_from_name($name);
$player['lastSeen'] = time();
if (is_array($cursor) && isset($cursor['x'], $cursor['y'])) {
    $player['cursor'] = [
        'x'        => (float)$cursor['x'],
        'y'        => (float)$cursor['y'],
        'cellSize' => isset($cursor['cellSize']) ? (int)$cursor['cellSize'] : 36,
    ];
}
// The viewport centre, for other players' "go to" (whole cells).
if (is_array($view) && isset($view['x'], $view['y'])) {
    $player['view'] = [
        'x' => (int)$view['x'],
        'y' => (int)$view['y'],
    ];
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
// moveOwners runs parallel to moveLog, with the first 8 hex chars of each move's playerId. An undo isn't appended:
// it rewrites the reveal it undoes and bumps logRevision, so every client refetches the whole log.
$moveOwners  = $room['moveOwners'] ?? '';
$moveLog     = $room['moveLog'] ?? '';
$logRevision = (int)($room['logRevision'] ?? 0);

// Moves and resets made before someone else's reset belong to the old board, so they're dropped.
if ($clientRound !== null && $clientRound !== (int)($room['round'] ?? 0)) {
    $moves        = [];
    $resetRequest = null;
}

$logChanges = 0;
foreach ($moves as $m) {
    if (!is_array($m) || count($m) < 3) continue;
    $type = (string)$m[0];
    if ($type !== 'r' && $type !== 'f' && $type !== 'u') continue;
    $x = (int)$m[1];
    $y = (int)$m[2];

    if ($type === 'u') {
        if (undo_reveal($moveLog, $x, $y)) {
            $logRevision++;
            $logChanges++;
            add_event($room, 'undo', $playerId, $name);
        }
    } else {
        $moveLog    .= $type . $x . ',' . $y . ';';
        $moveOwners .= substr($playerId, 0, 8) . ';';
        $logChanges++;
    }
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
        start_new_round($room, $moveLog, $moveOwners, $logRevision, $kind, $seed, $loadLog, substr($playerId, 0, 8));
        add_event($room, $kind, $playerId, $name);
    } elseif (($voteBefore['status'] ?? null) !== 'open') {
        $room['resetVote'] = [ // the requester's vote counts as yes
            'id'        => random_hex_id(4),
            'by'        => $playerId,
            'byName'    => $name,
            'kind'      => $kind,
            'seed'      => $seed,
            'moveLog'   => $loadLog,
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
    start_new_round($room, $moveLog, $moveOwners, $logRevision, $passed['kind'], $passed['seed'],
                    $passed['moveLog'] ?? '', substr((string)$passed['by'], 0, 8));
    $room['resetVote'] = $passed; // keeps the result visible for a moment
}
$voteChanged = $resetRequest !== null || $voteReply !== null || ($room['resetVote'] ?? null) !== $voteBefore;

if ($logChanges > 0 || $cursor !== null || $view !== null || $clientHints !== null || $voteChanged || !isset($room['version'])) {
    $room['version']      = ($room['version'] ?? 0) + 1;
    $room['moveLog']      = $moveLog;
    $room['moveOwners']   = $moveOwners;
    $room['logRevision']  = $logRevision;
    $room['lastActivity'] = time();
}

save_room_and_unlock($room, $lock);

// --- Response ---
$moveIndex = $moveLog === '' ? 0 : substr_count($moveLog, ';');
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

if ($clientRevision < $logRevision) {
    // Past entries changed, so the client rebuilds from the whole log.
    $response['moveLog']    = $moveLog;
    $response['moveOwners'] = $moveOwners;
    $response['newMoves']   = [];
} else {
    $newMoves = [];
    if ($clientMoveIndex < $moveIndex) {
        $entries = explode(';', rtrim($moveLog, ';'));
        $owners  = explode(';', rtrim($moveOwners, ';'));
        for ($i = $clientMoveIndex; $i < count($entries); $i++) {
            $move = parse_move($entries[$i]);
            if ($move === null) continue;
            $move[] = $owners[$i] ?? '';
            $newMoves[] = $move;
        }
    }
    $response['newMoves'] = $newMoves;
}

json_response($response);
