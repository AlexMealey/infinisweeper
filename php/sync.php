<?php
// sync.php — the workhorse endpoint. POST body:
// {
//   roomId, playerId, name,
//   sinceVersion,       -- highest version the client has seen
//   moveIndex,          -- count of moveLog entries the client has already applied
//   logRevision,        -- last logRevision the client saw (undo-rewrite counter)
//   cursor: {x, y, cellSize} | null,
//   moves: [ ["r"|"f"|"u", x, y], ... ]   -- moves the client made locally since last sync
//                                            'u' is an undo request; server rewrites the last matching 'r' entry.
//   hints: {...} | null   -- if present, merge into shared room hints (subset of allowed keys)
// }
// Returns:
// {
//   version,                                       -- current room version
//   logRevision,                                   -- current log revision
//   moveIndex,                                     -- current tail index of moveLog (in entries)
//   newMoves: [ ["r"|"f"|"u", x, y, ownerShort], ... ],  -- entries appended since client's moveIndex
//   moveLog?, moveOwners?,                         -- present ONLY when logRevision jumped: rebuild from these
//   players: { <pid>: {name, color, cursor, lastSeen} },
//   hints,                                         -- included on every response for simplicity
//   seed
// }

require __DIR__ . '/lib.php';

handle_preflight();
require_post();

$body = read_json_body();

$roomId       = $body['roomId']   ?? '';
$playerId     = $body['playerId'] ?? '';
$name         = isset($body['name']) ? sanitize_name((string)$body['name']) : 'Player';
$cursor       = $body['cursor'] ?? null;
$view         = $body['view']   ?? null;  // viewport center in world coords — used by "go to player" navigation
$moves        = is_array($body['moves'] ?? null) ? $body['moves'] : [];
$clientLogRev = isset($body['logRevision']) ? (int)$body['logRevision'] : 0;
$clientHints  = (isset($body['hints']) && is_array($body['hints'])) ? $body['hints'] : null;

if (!valid_id($roomId))   error_response('bad roomId');
if (!valid_id($playerId)) error_response('bad playerId');

if (count($moves) > MAX_MOVES_PER_REQ) $moves = array_slice($moves, 0, MAX_MOVES_PER_REQ);

[$room, $fh] = load_room_locked($roomId);
if (!$room) error_response('room not found', 404);

// --- Update this player's presence ---
if (!isset($room['players']) || !is_array($room['players'])) $room['players'] = [];
$player = $room['players'][$playerId] ?? [];

// Rate limit BEFORE we do any writes. On rejection we still persist the token bucket
// state (so the refill clock keeps ticking) plus lastSeen — no other mutations.
if (!check_and_consume_rate($player)) {
    $player['lastSeen'] = time();
    $room['players'][$playerId] = $player;
    save_room_and_unlock($room, $fh);
    // 429 tells the client to back off; Net.js already handles it via the error path.
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
// Track each player's viewport center so other clients can "go to" that spot.
// Stored as integers because we snap to whole world coordinates when jumping to a player.
if (is_array($view) && isset($view['x'], $view['y'])) {
    $player['view'] = [
        'x' => (int)$view['x'],
        'y' => (int)$view['y'],
    ];
}
$room['players'][$playerId] = $player;

// --- Merge shared hints (Phase 2) ---
// Only whitelisted gameplay hints are shared. UI-only settings never touch the server.
if ($clientHints !== null) {
    $allowed = ['wrongFlags', 'pulseNeighbors', 'undoEnabled', 'undoMode', 'chordFlag'];
    $current = $room['hints'] ?? [];
    $changed = false;
    foreach ($allowed as $k) {
        if (!array_key_exists($k, $clientHints)) continue;
        $v = $clientHints[$k];
        // basic type sanity
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

// --- Apply moves ---
// moveLog is stored in the same compact form as the client's encodeMoveLog output
// (e.g. "r5,3;r6,3;f5,4;") with a parallel moveOwners string holding the first 8 hex
// chars of each move's owner playerId. 'u' is not appended — instead it rewrites the
// last matching 'r' entry in-place and bumps logRevision, since past entries changing
// requires all other clients to re-fetch the full log.

$moveOwners = $room['moveOwners'] ?? '';
$moveLog    = $room['moveLog'] ?? '';
$logRev     = (int)($room['logRevision'] ?? 0);

$appended = 0;
foreach ($moves as $m) {
    if (!is_array($m) || count($m) < 3) continue;
    $t = (string)$m[0];
    if ($t !== 'r' && $t !== 'f' && $t !== 'u') continue;
    $x = (int)$m[1];
    $y = (int)$m[2];

    if ($t === 'u') {
        // Find and rewrite the last 'r' entry at (x,y). If no match, silently drop —
        // probably a duplicate undo from a client that missed our echo.
        $entries = $moveLog === '' ? [] : explode(';', rtrim($moveLog, ';'));
        $found = false;
        for ($j = count($entries) - 1; $j >= 0; $j--) {
            $e = $entries[$j];
            if ($e === '' || $e[0] !== 'r') continue;
            $comma = strpos($e, ',', 1);
            if ($comma === false) continue;
            $ex = (int)substr($e, 1, $comma - 1);
            $ey = (int)substr($e, $comma + 1);
            if ($ex === $x && $ey === $y) {
                $entries[$j] = 'u' . $x . ',' . $y;
                // owners stay unchanged — the undo is credited to whoever made the reveal.
                $moveLog = implode(';', $entries) . ';';
                $found = true;
                break;
            }
        }
        if ($found) {
            $logRev++;
            $appended++;
        }
    } else {
        $moveLog    .= $t . $x . ',' . $y . ';';
        $moveOwners .= substr($playerId, 0, 8) . ';';
        $appended++;
    }
}

// --- Bump version and persist ---
if ($appended > 0 || $cursor !== null || $view !== null || $clientHints !== null || !isset($room['version'])) {
    $room['version']      = ($room['version'] ?? 0) + 1;
    $room['moveLog']      = $moveLog;
    $room['moveOwners']   = $moveOwners;
    $room['logRevision']  = $logRev;
    $room['lastActivity'] = time();
}
prune_stale_players($room);

save_room_and_unlock($room, $fh);

// --- Build response ---
$moveIndex = $moveLog === '' ? 0 : substr_count($moveLog, ';');
$clientMoveIndex = isset($body['moveIndex']) ? (int)$body['moveIndex'] : 0;
if ($clientMoveIndex < 0) $clientMoveIndex = 0;

$response = [
    'version'     => $room['version'],
    'logRevision' => $logRev,
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
];

if ($clientLogRev < $logRev) {
    // Undo rewrote past entries — the client's tail cache is invalid. Send the whole log.
    $response['moveLog']    = $moveLog;
    $response['moveOwners'] = $moveOwners;
    $response['newMoves']   = []; // client will do a full rebuild instead
} else {
    // Normal tail delta — send only entries the client hasn't seen.
    $newMoves = [];
    if ($clientMoveIndex < $moveIndex) {
        $entries = explode(';', rtrim($moveLog, ';'));
        $owners  = explode(';', rtrim($moveOwners, ';'));
        for ($i = $clientMoveIndex; $i < count($entries); $i++) {
            $e = $entries[$i];
            if ($e === '') continue;
            $comma = strpos($e, ',', 1);
            if ($comma === false) continue;
            $t = $e[0];
            $x = (int)substr($e, 1, $comma - 1);
            $y = (int)substr($e, $comma + 1);
            $ownerShort = $owners[$i] ?? '';
            $newMoves[] = [$t, $x, $y, $ownerShort];
        }
    }
    $response['newMoves'] = $newMoves;
}

json_response($response);
