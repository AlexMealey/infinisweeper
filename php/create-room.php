<?php
// create-room.php — POST body: {seed?, hints?}
// Returns: {roomId, playerId}
// The caller then navigates to index.html?room=<roomId> and joins via sync.php.

require __DIR__ . '/lib.php';

handle_preflight();
require_post();

$body = read_json_body();

$seed = isset($body['seed']) && is_string($body['seed']) && $body['seed'] !== ''
    ? preg_replace('/[^A-Za-z0-9_-]/', '', substr($body['seed'], 0, 32))
    : bin2hex(random_bytes(4));

$hints = isset($body['hints']) && is_array($body['hints']) ? $body['hints'] : null;

$roomId   = gen_id(16);
$playerId = gen_id(8);

// Opportunistic GC: piggy-backs on room creation so we don't need a cron.
// It's cheap (a glob() + filemtime() scan) and only runs at room-creation cadence.
gc_rooms();

$state = new_room_state($seed, $hints);
$path = room_path($roomId);
$fh = fopen($path, 'x'); // 'x' fails if the file exists — collisions on 16-byte IDs are ~impossible but let's be safe
if (!$fh) error_response('room id collision, please retry', 500);
flock($fh, LOCK_EX);
fwrite($fh, json_encode($state, JSON_UNESCAPED_SLASHES));
fflush($fh);
flock($fh, LOCK_UN);
fclose($fh);

json_response(['roomId' => $roomId, 'playerId' => $playerId]);
