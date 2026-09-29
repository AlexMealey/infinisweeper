<?php
// create-room.php — POST body: {seed?, hints?, moveLog?}
// moveLog starts the room from an existing game (a singleplayer board taken into multiplayer),
// in the client's encoded form ("r5,3;f5,4;"). Its moves are credited to the creator.
// Returns: {roomId, playerId}
// The caller then navigates to index.html?room=<roomId> and joins via sync.php.

require __DIR__ . '/lib.php';

handle_preflight();
require_post();

$body = read_json_body();

$moveLog = isset($body['moveLog']) && is_string($body['moveLog']) ? $body['moveLog'] : '';
if ($moveLog !== '') {
    // The moves only replay onto the same board if the seed survives sanitizing unchanged.
    $rawSeed = $body['seed'] ?? null;
    if (!is_string($rawSeed) || $rawSeed === '' || sanitize_seed($rawSeed) !== $rawSeed) {
        error_response("this game's seed can't be used in a room");
    }
    if (!valid_move_log($moveLog)) error_response('bad moveLog');
}

$seed = isset($body['seed']) && is_string($body['seed']) && $body['seed'] !== ''
    ? sanitize_seed($body['seed'])
    : bin2hex(random_bytes(4));

$hints = isset($body['hints']) && is_array($body['hints']) ? $body['hints'] : null;

$roomId   = gen_id(16);
$playerId = gen_id(8);

// Opportunistic GC: piggy-backs on room creation so we don't need a cron.
// It's cheap (a glob() + filemtime() scan) and only runs at room-creation cadence.
gc_rooms();

$state = new_room_state($seed, $hints, $playerId); // the creator is the room's founder
if ($moveLog !== '') {
    $state['moveLog']    = $moveLog;
    $state['moveOwners'] = str_repeat(substr($playerId, 0, 8) . ';', substr_count($moveLog, ';'));
}
$path = room_path($roomId);
$fh = fopen($path, 'x'); // 'x' fails if the file exists — collisions on 16-byte IDs are ~impossible but let's be safe
if (!$fh) error_response('room id collision, please retry', 500);
flock($fh, LOCK_EX);
fwrite($fh, json_encode($state, JSON_UNESCAPED_SLASHES));
fflush($fh);
flock($fh, LOCK_UN);
fclose($fh);

json_response(['roomId' => $roomId, 'playerId' => $playerId]);
