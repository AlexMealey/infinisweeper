<?php
// create-room.php – POST {seed?, hints?, moveLog?}, returns {roomId, playerId}; the client then opens ?room=<roomId>.
// moveLog (in encodeMoveLog() form) starts the room from an existing game, credited to the creator.

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
    if (!is_valid_move_log($moveLog)) error_response('bad moveLog');
}

$seed = isset($body['seed']) && is_string($body['seed']) && $body['seed'] !== ''
    ? sanitize_seed($body['seed'])
    : bin2hex(random_bytes(4));

$hints = isset($body['hints']) && is_array($body['hints']) ? $body['hints'] : null;

$roomId   = random_hex_id(16);
$playerId = random_hex_id(8);

delete_expired_rooms(); // cheap enough to run on every room creation, so no cron job is needed

$state = new_room_state($seed, $hints, $playerId); // the creator is the room's founder
if ($moveLog !== '') {
    $state['moveLog']    = $moveLog;
    $state['moveOwners'] = str_repeat(substr($playerId, 0, 8) . ';', substr_count($moveLog, ';'));
}
$file = fopen(room_path($roomId), 'x'); // 'x' fails if the file exists
if (!$file) error_response('room id collision, please retry', 500);
flock($file, LOCK_EX);
fwrite($file, json_encode($state, JSON_UNESCAPED_SLASHES));
fflush($file);
flock($file, LOCK_UN);
fclose($file);

json_response(['roomId' => $roomId, 'playerId' => $playerId]);
