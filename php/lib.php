<?php
// lib.php – shared helpers for the multiplayer endpoints. Plain PHP, so any shared host can run it.

const PLAYER_STALE_SEC     = 30;      // players unheard from for this long are dropped
const ROOM_TTL_SEC         = 86400;   // rooms untouched for this long are deleted
const MAX_NAME_LEN         = 24;
const MAX_MOVES_PER_REQ    = 50;
const RATE_TOKENS_CAP      = 20;      // burst allowance per player
const RATE_TOKENS_PER_SEC  = 12;      // above the client's maximum of 10 requests a second
const VOTE_PASS_PCT        = 51;      // share of the room that must agree to start over
const VOTE_TTL_SEC         = 30;      // an unresolved vote expires after this long
const VOTE_RESULT_SEC      = 4;       // a resolved vote stays visible this long, so every client can show it
const EVENTS_KEPT          = 40;      // recent events for clients to announce ("Alex used an undo"), pings included
const EVENT_SEND_SEC       = 10;      // only events this recent are sent
const PING_MIN_GAP_SEC     = 0.3;     // a player's pings closer together than this are dropped
const MAX_LOADED_LOG_CHARS = 2000000; // a save file's move log loaded into a room
const FULL_LOG_GAP         = 5000;    // a client further behind than this gets the whole log instead of newMoves
const OWNER_BYTES          = 9;       // a moveOwners entry: 8 hex chars and ';'
const MAX_COORD            = 999999999; // moves past this are dropped, so a room's log stays loadable as a save
const MAX_ENTRY_BYTES      = 23;      // the longest log entry, "r-999999999,-999999999;"
const GZIP_MIN_BYTES       = 1024;    // smaller responses aren't worth compressing

function rooms_dir(): string {
    $dir = __DIR__ . '/../data/rooms';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

// A room is <id>.state.json (everything but the log, replaced whole on each save), <id>.<gen>.log and <id>.<gen>.own
// (the move log and its owners, written in place at the ends the state records; a new round writes the next
// generation), <id>.vote (an open load vote's save log) and <id>.lock. <id>.json is the old single-file format:
// migrated on first open, then left as it was. $roomId must already have passed is_valid_id().
function room_file(string $roomId, string $suffix): string {
    return rooms_dir() . '/' . $roomId . '.' . $suffix;
}

function log_file(string $roomId, array $room, string $ext): string {
    return room_file($roomId, (int)($room['logGen'] ?? 0) . '.' . $ext);
}

function random_hex_id(int $bytes = 16): string {
    return bin2hex(random_bytes($bytes));
}

function sanitize_name(string $n): string {
    $n = trim(strip_tags($n));
    if ($n === '') $n = 'Player';
    // mbstring truncates on character boundaries. Without it, cut bytes and drop any partial UTF-8 character.
    if (function_exists('mb_strlen')) {
        if (mb_strlen($n, 'UTF-8') > MAX_NAME_LEN) $n = mb_substr($n, 0, MAX_NAME_LEN, 'UTF-8');
    } else {
        if (strlen($n) > MAX_NAME_LEN) {
            $n = substr($n, 0, MAX_NAME_LEN);
            while (strlen($n) > 0 && (ord($n[strlen($n) - 1]) & 0xC0) === 0x80) {
                $n = substr($n, 0, -1);
            }
        }
    }
    return $n;
}

function sanitize_seed(string $s): string {
    return preg_replace('/[^A-Za-z0-9_-]/', '', substr($s, 0, 32));
}

// The same name always gets the same colour.
function color_from_name(string $name): string {
    $palette = ['#5b9bd5','#6bab42','#ef4444','#a855f7','#06b6d4','#f59e0b','#ec4899','#10b981'];
    $h = 0;
    for ($i = 0; $i < strlen($name); $i++) $h = ($h * 31 + ord($name[$i])) & 0xffffffff;
    return $palette[$h % count($palette)];
}

function is_valid_id(string $id): bool {
    return (bool) preg_match('/^[a-f0-9]{16,64}$/', $id);
}

// Returns [room, lock], the room locked until close_room(). Every room file is read and written only under this lock.
function open_room(string $roomId): array {
    if (!is_valid_id($roomId)) return [null, null];
    $statePath = room_file($roomId, 'state.json');
    if (!is_file($statePath) && !is_file(room_file($roomId, 'json'))) return [null, null]; // no lock files for unknown ids
    $lock = @fopen(room_file($roomId, 'lock'), 'c');
    if (!$lock) return [null, null];
    flock($lock, LOCK_EX);
    clearstatcache();
    $json = @file_get_contents($statePath);
    $room = $json === false ? migrate_legacy_room($roomId) : json_decode($json, true);
    if (!is_array($room)) { close_room($lock); return [null, null]; }
    if ((int)@filesize(log_file($roomId, $room, 'log')) < (int)($room['logBytes'] ?? 0)
            || (int)@filesize(log_file($roomId, $room, 'own')) < (int)($room['moveCount'] ?? 0) * OWNER_BYTES) {
        repair_log($roomId, $room);
    }
    return [$room, $lock];
}

// Temp file + rename, so a crash or a failed encode never leaves a half-written room. This is what commits a request.
function save_room(string $roomId, array $room): bool {
    $json = json_encode($room, JSON_UNESCAPED_SLASHES);
    if ($json === false) return false;
    $path = room_file($roomId, 'state.json');
    return file_put_contents("$path.tmp", $json) === strlen($json) && rename("$path.tmp", $path);
}

function close_room($lock): void {
    if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
}

// Writes the next generation of the log files; the room switches to it when its state is saved.
function write_log_files(string $roomId, array &$room, string $log, string $owners): bool {
    $room['logGen']    = (int)($room['logGen'] ?? 0) + 1;
    $room['moveCount'] = substr_count($log, ';');
    $room['logBytes']  = strlen($log);
    return file_put_contents(log_file($roomId, $room, 'log'), $log) === strlen($log)
        && file_put_contents(log_file($roomId, $room, 'own'), $owners) === strlen($owners);
}

// Appends at the ends the state records, over anything a failed or killed request left past them (so not 'a' mode).
function append_log(string $roomId, array &$room, string $entries, string $owners): bool {
    if ($entries === '') return true;
    if (!write_at(log_file($roomId, $room, 'log'), (int)$room['logBytes'], $entries)
            || !write_at(log_file($roomId, $room, 'own'), (int)$room['moveCount'] * OWNER_BYTES, $owners)) return false;
    $room['logBytes']  += strlen($entries);
    $room['moveCount'] += substr_count($entries, ';');
    return true;
}

// Never leaves a gap: fails if the file is shorter than $offset.
function write_at(string $path, int $offset, string $data): bool {
    $f = @fopen($path, 'c');
    if (!$f) return false;
    $ok = fstat($f)['size'] >= $offset && fseek($f, $offset) === 0 && fwrite($f, $data) === strlen($data);
    fclose($f);
    return $ok;
}

// The whole log ('log') or its owners ('own') as the state records them; null if the file is shorter than that.
function read_log(string $roomId, array $room, string $ext): ?string {
    $len = $ext === 'log' ? (int)$room['logBytes'] : (int)$room['moveCount'] * OWNER_BYTES;
    if ($len === 0) return '';
    $s = @file_get_contents(log_file($roomId, $room, $ext), false, null, 0, $len);
    return is_string($s) && strlen($s) === $len ? $s : null;
}

// Entries $from on as [type, x, y, owner], read from the end of the files. null when that read doesn't reach entry
// $from (entries longer than MAX_ENTRY_BYTES, from before coordinates were capped); the caller sends the whole log.
function read_new_moves(string $roomId, array $room, int $from): ?array {
    $gap = (int)$room['moveCount'] - $from;
    if ($gap <= 0) return [];
    $end   = (int)$room['logBytes'];
    $start = max(0, $end - $gap * MAX_ENTRY_BYTES - 1); // the extra byte: the ';' before entry $from at the longest
    $tail  = @file_get_contents(log_file($roomId, $room, 'log'), false, null, $start, $end - $start);
    $own   = @file_get_contents(log_file($roomId, $room, 'own'), false, null, $from * OWNER_BYTES, $gap * OWNER_BYTES);
    if (!is_string($tail) || strlen($tail) !== $end - $start || !is_string($own) || strlen($own) !== $gap * OWNER_BYTES) return null;
    $entries = explode(';', $tail);
    array_pop($entries);                   // after the final ';'
    if ($start > 0) array_shift($entries); // part of an earlier entry, or empty
    if (count($entries) < $gap) return null;
    $owners = explode(';', $own);
    $out = [];
    foreach (array_slice($entries, -$gap) as $i => $e) {
        $move = parse_move($e);
        if ($move === null) continue;
        $move[] = $owners[$i];
        $out[] = $move;
    }
    return $out;
}

// The log files are shorter than the state says: a power cut before they reached the disk, or a backup copied
// mid-write. Keeps the entries both still have; logRevision bumps so clients rebuild.
function repair_log(string $roomId, array &$room): void {
    $log = (string)@file_get_contents(log_file($roomId, $room, 'log'), false, null, 0, (int)($room['logBytes'] ?? 0));
    $n = min((int)($room['moveCount'] ?? 0), substr_count($log, ';'), intdiv((int)@filesize(log_file($roomId, $room, 'own')), OWNER_BYTES));
    $end = 0;
    for ($i = 0; $i < $n; $i++) $end = strpos($log, ';', $end) + 1;
    $room['moveCount']   = $n;
    $room['logBytes']    = $end;
    $room['logRevision'] = (int)($room['logRevision'] ?? 0) + 1;
}

// Moves an old single-file room's log into side files. The old file is left untouched, so going back to the previous
// code finds the room as it was now. logRevision bumps so every client refetches the log whole.
function migrate_legacy_room(string $roomId): ?array {
    $f = @fopen(room_file($roomId, 'json'), 'r');
    if (!$f) return null;
    flock($f, LOCK_SH); // the old code rewrote it in place under LOCK_EX
    $room = json_decode(stream_get_contents($f), true);
    fclose($f);
    if (!is_array($room)) return null;
    $log = (string)($room['moveLog'] ?? '');
    $log = substr($log, 0, (int)strrpos(';' . $log, ';')); // whole entries only
    $count = substr_count($log, ';');
    $owners = (string)($room['moveOwners'] ?? '');
    if (strlen($owners) !== $count * OWNER_BYTES || !preg_match('/^(?:[0-9a-f]{8};)*+$/D', $owners)) $owners = str_repeat('00000000;', $count);
    unset($room['moveLog'], $room['moveOwners']);
    if (isset($room['resetVote']['moveLog'])) $room['resetVote'] = null; // a load vote open at the switch-over is dropped; it can be asked again
    $room['logRevision'] = (int)($room['logRevision'] ?? 0) + 1;
    return write_log_files($roomId, $room, $log, $owners) && save_room($roomId, $room) ? $room : null;
}

// Hint defaults match the client's migrateHints(). The founder can start over without a vote.
function new_room_state(string $seed, ?array $hints, string $founderId): array {
    $defaultHints = [
        'wrongFlags'      => false,
        'pulseNeighbors'  => false,
        'undoEnabled'     => false,
        'undoMode'        => 'refill',
        'chordFlag'       => false,
    ];
    return [
        'version'      => 0,
        'logRevision'  => 0,           // bumps when an undo rewrites the log, so clients refetch it whole
        'seed'         => $seed,
        'hints'        => array_merge($defaultHints, $hints ?? []),
        'logGen'       => 0,           // which <id>.<gen>.log/.own files hold the log
        'moveCount'    => 0,
        'logBytes'     => 0,
        'players'      => new stdClass(),
        'founderId'    => $founderId,
        'round'        => 0,           // bumps when the room starts over
        'resetVote'    => null,        // see resolve_reset_vote()
        'createdAt'    => time(),
        'lastActivity' => time(),
    ];
}

// Token-bucket rate limit, kept in the player record. Returns false once the burst allowance is spent.
function take_rate_token(array &$player): bool {
    $now = microtime(true);
    $tokens = isset($player['rateTokens']) ? (float)$player['rateTokens'] : (float)RATE_TOKENS_CAP;
    $last   = isset($player['rateLastRefill']) ? (float)$player['rateLastRefill'] : $now;
    $tokens = min((float)RATE_TOKENS_CAP, $tokens + max(0.0, $now - $last) * RATE_TOKENS_PER_SEC);
    if ($tokens < 1.0) {
        $player['rateTokens']     = $tokens;
        $player['rateLastRefill'] = $now;
        return false;
    }
    $player['rateTokens']     = $tokens - 1.0;
    $player['rateLastRefill'] = $now;
    return true;
}

// Drops players we haven't heard from recently, so their cursors don't linger.
function prune_stale_players(array &$room): void {
    $cutoff = time() - PLAYER_STALE_SEC;
    if (!isset($room['players']) || !is_array($room['players'])) return;
    foreach ($room['players'] as $pid => $p) {
        if (!isset($p['lastSeen']) || $p['lastSeen'] < $cutoff) {
            unset($room['players'][$pid]);
        }
    }
}

// Move logs use the client's encodeMoveLog() form: "r5,3;f5,4;u6,3;", numbers written as JavaScript writes them (an
// undo finds its reveal by text). The possessive quantifier keeps PCRE from holding backtracking state on long logs.
function is_valid_move_log(string $log): bool {
    return strlen($log) <= MAX_LOADED_LOG_CHARS
        && preg_match('/^(?:[rfu](?:0|-?[1-9]\d{0,8}),(?:0|-?[1-9]\d{0,8});)*+$/D', $log) === 1;
}

// A board coordinate from the client, or null if it isn't a usable number (INF, NaN, huge or not numeric). Bad values
// are ignored rather than rejected, since Net would retry an error forever.
function coord($v): ?float {
    if (!is_numeric($v)) return null;
    $f = (float)$v;
    return abs($f) <= MAX_COORD ? $f : null;
}

// One move log entry as [type, x, y], or null if it's malformed.
function parse_move(string $entry): ?array {
    if ($entry === '') return null;
    $comma = strpos($entry, ',', 1);
    if ($comma === false) return null;
    return [$entry[0], (int)substr($entry, 1, $comma - 1), (int)substr($entry, $comma + 1)];
}

// Offset of the latest entry $entry ("r5,3;") in $log, or -1. Entries end in ';', so a match starts the log or follows one.
function last_entry_offset(string $log, string $entry): int {
    $p = strrpos($log, ';' . $entry);
    if ($p !== false) return $p + 1;
    return strncmp($log, $entry, strlen($entry)) === 0 ? 0 : -1;
}

// Marks the latest reveal of (x, y), the one that hit a mine, as undone: 'r' becomes 'u', the same length, so it's
// rewritten in place, and its owner stays the player who made the reveal. Returns its offset, or -1 if that reveal is
// already undone (two players pressed Undo at once, and an older, safe reveal of the cell must not be undone too).
function undo_reveal(string &$log, int $x, int $y): int {
    $r = last_entry_offset($log, "r$x,$y;");
    if ($r < 0 || last_entry_offset($log, "u$x,$y;") > $r) return -1;
    $log[$r] = 'u';
    return $r;
}

// Starts a fresh round and returns its [log, owners], which become the next generation of log files when the room is
// saved. 'restart' keeps the seed, 'new' switches to $seed (or a random one), and 'load' takes a save file's $seed and
// $loadLog, credited to $owner (a short playerId).
function start_new_round(array &$room, int &$logRevision, string $kind, ?string $seed, string $loadLog = '', string $owner = ''): array {
    if ($kind === 'new' || $kind === 'load') $room['seed'] = ($seed !== null && $seed !== '') ? $seed : bin2hex(random_bytes(4));
    $logRevision++;             // every client rebuilds from the new log
    $room['round']     = (int)($room['round'] ?? 0) + 1;
    $room['resetVote'] = null;  // a reset settles any open vote
    return $kind === 'load' ? [$loadLog, str_repeat($owner . ';', substr_count($loadLog, ';'))] : ['', ''];
}

// Records something other players should be told about: 'undo', 'restart', 'new', 'load', or 'ping' with the
// pinged cell in $extra (['x' => int, 'y' => int]).
function add_event(array &$room, string $type, string $playerId, string $name, array $extra = []): void {
    $seq = (int)($room['eventSeq'] ?? 0) + 1;
    $room['eventSeq'] = $seq;
    $events   = $room['events'] ?? [];
    $events[] = ['seq' => $seq, 'type' => $type, 'by' => $playerId, 'byName' => $name, 'at' => time()] + $extra;
    $room['events'] = array_slice($events, -EVENTS_KEPT);
}

function recent_events(array $room): array {
    $cutoff = time() - EVENT_SEND_SEC;
    $out = [];
    foreach ($room['events'] ?? [] as $e) {
        if ($e['at'] < $cutoff) continue;
        $sent = ['seq' => $e['seq'], 'type' => $e['type'], 'by' => $e['by'], 'byName' => $e['byName']];
        if (isset($e['x'], $e['y'])) { $sent['x'] = $e['x']; $sent['y'] = $e['y']; }
        $out[] = $sent;
    }
    return $out;
}

function votes_needed(int $total): int {
    return intdiv($total * VOTE_PASS_PCT + 99, 100); // ceil without floats: 2 players → 2, 3 → 2, 4 → 3
}

// Returns [yes, no, total], counting only players still in the room.
function count_votes(array $room): array {
    $players = $room['players'] ?? [];
    $yes = 0; $no = 0;
    foreach (($room['resetVote']['votes'] ?? []) as $pid => $choice) {
        if (!isset($players[$pid])) continue;
        if ($choice) $yes++; else $no++;
    }
    return [$yes, $no, max(1, count($players))];
}

// Returns 'passed', 'failed' or 'expired' when the open vote is decided, otherwise null. Clears resolved votes
// after VOTE_RESULT_SEC.
function resolve_reset_vote(array &$room): ?string {
    $vote = $room['resetVote'] ?? null;
    if (!is_array($vote)) return null;
    if ($vote['status'] !== 'open') {
        if (time() - ($vote['resolvedAt'] ?? 0) > VOTE_RESULT_SEC) $room['resetVote'] = null;
        return null;
    }
    [$yes, $no, $total] = count_votes($room);
    $needed = votes_needed($total);
    if ($yes >= $needed)                                $result = 'passed';
    elseif ($total - $no < $needed)                     $result = 'failed'; // can no longer pass
    elseif (time() - $vote['createdAt'] > VOTE_TTL_SEC) $result = 'expired';
    else return null;
    $room['resetVote']['status']     = $result;
    $room['resetVote']['resolvedAt'] = time();
    return $result;
}

// The vote as clients see it: live tallies, plus this player's own answer (true, false or null).
function vote_for_client(array $room, string $playerId): ?array {
    $vote = $room['resetVote'] ?? null;
    if (!is_array($vote)) return null;
    [$yes, $no, $total] = count_votes($room);
    return [
        'id'          => $vote['id'],
        'by'          => $vote['by'],
        'byName'      => $vote['byName'] ?? 'Player',
        'kind'        => $vote['kind'],
        'loadMoves'   => (int)($vote['loadMoves'] ?? 0),
        'status'      => $vote['status'],
        'yes'         => $yes,
        'no'          => $no,
        'total'       => $total,
        'needed'      => votes_needed($total),
        'myVote'      => $vote['votes'][$playerId] ?? null,
        'secondsLeft' => max(0, VOTE_TTL_SEC - (time() - $vote['createdAt'])),
    ];
}

// Deletes every file of rooms untouched for ROOM_TTL_SEC. A room busy right now is left for next time.
function delete_expired_rooms(): void {
    $cutoff = time() - ROOM_TTL_SEC;
    $newest = [];
    foreach (glob(rooms_dir() . '/*.*') ?: [] as $f) {
        $id = (string)strstr(basename($f), '.', true);
        if (is_valid_id($id)) $newest[$id] = max($newest[$id] ?? 0, (int)@filemtime($f));
    }
    foreach ($newest as $id => $mtime) {
        if ($mtime >= $cutoff) continue;
        $lockPath = room_file($id, 'lock');
        $lock = @fopen($lockPath, 'c');
        if (!$lock) continue;
        if (!flock($lock, LOCK_EX | LOCK_NB)) { fclose($lock); continue; }
        clearstatcache();
        $state = room_file($id, 'state.json');
        if (is_file($state) && filemtime($state) >= $cutoff) { close_room($lock); continue; }
        @unlink(room_file($id, 'json')); // first, so a crash part-way can't bring a migrated room back from it
        @unlink($state);
        foreach (glob(rooms_dir() . '/' . $id . '.*') ?: [] as $f) {
            if ($f !== $lockPath) @unlink($f);
        }
        close_room($lock);
        @unlink($lockPath); // after closing: Windows can't delete an open file
    }
}

function read_json_body(): array {
    $data = json_decode(file_get_contents('php://input'), true);
    return is_array($data) ? $data : [];
}

function json_response(array $data, int $code = 200): void {
    $out = json_encode($data, JSON_UNESCAPED_SLASHES);
    if ($out === false) { $code = 500; $out = '{"error":"could not encode the response"}'; }
    http_response_code($code);
    header('Content-Type: application/json');
    header('Vary: Accept-Encoding');
    // The client is same-origin; CORS headers let a dev server on another port call it too.
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    // A whole log is ~9 bytes a move and compresses about 7×. Level 1 gets most of that at a fifth of level 6's cost.
    // Hosts that already compress everything (zlib.output_compression) are left to it.
    if (strlen($out) >= GZIP_MIN_BYTES && function_exists('gzencode') && !ini_get('zlib.output_compression')
            && strpos($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip') !== false) {
        $gz = gzencode($out, 1);
        if ($gz !== false) { header('Content-Encoding: gzip'); $out = $gz; }
    }
    echo $out;
    exit;
}

function error_response(string $msg, int $code = 400): void {
    json_response(['error' => $msg], $code);
}

function handle_preflight(): void {
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
        http_response_code(204);
        exit;
    }
}

function require_post(): void {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') error_response('POST required', 405);
}
