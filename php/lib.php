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
const EVENTS_KEPT          = 20;      // recent events for clients to announce ("Alex used an undo")
const EVENT_SEND_SEC       = 10;      // only events this recent are sent
const MAX_LOADED_LOG_CHARS = 2000000; // a save file's move log loaded into a room

function rooms_dir(): string {
    $dir = __DIR__ . '/../data/rooms';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

// $roomId must already have passed is_valid_id().
function room_path(string $roomId): string {
    return rooms_dir() . '/' . $roomId . '.json';
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

// Returns [room, lock], with the room file locked until save_room_and_unlock() or unlock_room().
function load_room_locked(string $roomId) {
    if (!is_valid_id($roomId)) return [null, null];
    $path = room_path($roomId);
    if (!file_exists($path)) return [null, null];
    $lock = fopen($path, 'c+');
    if (!$lock) return [null, null];
    flock($lock, LOCK_EX);
    $room = json_decode(stream_get_contents($lock), true);
    if (!is_array($room)) { flock($lock, LOCK_UN); fclose($lock); return [null, null]; }
    return [$room, $lock];
}

function save_room_and_unlock(array $room, $lock): void {
    ftruncate($lock, 0);
    rewind($lock);
    fwrite($lock, json_encode($room, JSON_UNESCAPED_SLASHES));
    fflush($lock);
    flock($lock, LOCK_UN);
    fclose($lock);
}

function unlock_room($lock): void {
    if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
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
        'moveLog'      => '',
        'moveOwners'   => '',
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

// Move logs use the client's encodeMoveLog() form: "r5,3;f5,4;u6,3;". The possessive quantifier keeps PCRE from
// holding backtracking state on long logs.
function is_valid_move_log(string $log): bool {
    return strlen($log) <= MAX_LOADED_LOG_CHARS && preg_match('/^(?:[rfu]-?\d{1,9},-?\d{1,9};)*+$/D', $log) === 1;
}

// One move log entry as [type, x, y], or null if it's malformed.
function parse_move(string $entry): ?array {
    if ($entry === '') return null;
    $comma = strpos($entry, ',', 1);
    if ($comma === false) return null;
    return [$entry[0], (int)substr($entry, 1, $comma - 1), (int)substr($entry, $comma + 1)];
}

// Marks the latest reveal of (x, y), the one that hit a mine, as undone ('u'). Returns false if that reveal is
// already undone: two players pressed Undo at once, and an older, safe reveal of the cell must not be undone too.
function undo_reveal(string &$moveLog, int $x, int $y): bool {
    $entries = $moveLog === '' ? [] : explode(';', rtrim($moveLog, ';'));
    for ($j = count($entries) - 1; $j >= 0; $j--) {
        $move = parse_move($entries[$j]);
        if ($move === null || ($move[0] !== 'r' && $move[0] !== 'u')) continue;
        if ($move[1] !== $x || $move[2] !== $y) continue;
        if ($move[0] === 'u') return false;
        $entries[$j] = 'u' . $x . ',' . $y; // its owner stays the player who made the reveal
        $moveLog = implode(';', $entries) . ';';
        return true;
    }
    return false;
}

// Starts a fresh round. 'restart' keeps the seed, 'new' switches to $seed (or a random one), and 'load' takes a
// save file's $seed and $loadLog, credited to $owner (a short playerId).
function start_new_round(array &$room, string &$moveLog, string &$moveOwners, int &$logRevision, string $kind, ?string $seed,
                         string $loadLog = '', string $owner = ''): void {
    if ($kind === 'new' || $kind === 'load') $room['seed'] = ($seed !== null && $seed !== '') ? $seed : bin2hex(random_bytes(4));
    $moveLog    = $kind === 'load' ? $loadLog : '';
    $moveOwners = $kind === 'load' ? str_repeat($owner . ';', substr_count($loadLog, ';')) : '';
    $logRevision++;             // every client rebuilds from the new log
    $room['round']     = (int)($room['round'] ?? 0) + 1;
    $room['resetVote'] = null;  // a reset settles any open vote
}

// Records something other players should be told about: 'undo', 'restart', 'new' or 'load'.
function add_event(array &$room, string $type, string $playerId, string $name): void {
    $seq = (int)($room['eventSeq'] ?? 0) + 1;
    $room['eventSeq'] = $seq;
    $events   = $room['events'] ?? [];
    $events[] = ['seq' => $seq, 'type' => $type, 'by' => $playerId, 'byName' => $name, 'at' => time()];
    $room['events'] = array_slice($events, -EVENTS_KEPT);
}

function recent_events(array $room): array {
    $cutoff = time() - EVENT_SEND_SEC;
    $out = [];
    foreach ($room['events'] ?? [] as $e) {
        if ($e['at'] >= $cutoff) $out[] = ['seq' => $e['seq'], 'type' => $e['type'], 'by' => $e['by'], 'byName' => $e['byName']];
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
        'loadMoves'   => substr_count($vote['moveLog'] ?? '', ';'),
        'status'      => $vote['status'],
        'yes'         => $yes,
        'no'          => $no,
        'total'       => $total,
        'needed'      => votes_needed($total),
        'myVote'      => $vote['votes'][$playerId] ?? null,
        'secondsLeft' => max(0, VOTE_TTL_SEC - (time() - $vote['createdAt'])),
    ];
}

function delete_expired_rooms(): void {
    $cutoff = time() - ROOM_TTL_SEC;
    foreach (glob(rooms_dir() . '/*.json') as $f) {
        if (filemtime($f) < $cutoff) @unlink($f);
    }
}

function read_json_body(): array {
    $data = json_decode(file_get_contents('php://input'), true);
    return is_array($data) ? $data : [];
}

function json_response(array $data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json');
    // The client is same-origin; CORS headers let a dev server on another port call it too.
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
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
