<?php
// lib.php — shared helpers for the multiplayer endpoints.
// Kept tiny on purpose: any shared hosting with plain PHP-FPM can run this.

const PLAYER_STALE_SEC = 30;   // drop a player's cursor if we haven't heard from them in this many seconds
const ROOM_TTL_SEC     = 86400; // delete rooms untouched for 24 hours
const MAX_NAME_LEN     = 24;
const MAX_MOVES_PER_REQ = 50;
const RATE_TOKENS_CAP  = 20;   // burst allowance per player
const RATE_TOKENS_PER_SEC = 12; // refill rate — well above the 4/sec polling cadence

function data_dir(): string {
    $dir = __DIR__ . '/../data/rooms';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

function room_path(string $roomId): string {
    // room IDs are validated to hex chars only before reaching here
    return data_dir() . '/' . $roomId . '.json';
}

function gen_id(int $bytes = 16): string {
    return bin2hex(random_bytes($bytes));
}

function sanitize_name(string $n): string {
    $n = trim(strip_tags($n));
    if ($n === '') $n = 'Player';
    // Prefer mbstring so multibyte characters (accents, emoji) count as one glyph
    // and get truncated on codepoint boundaries. Falls back to plain byte truncation
    // when the extension isn't enabled — worst case the display name loses a byte
    // or two off the tail, but nothing errors out.
    if (function_exists('mb_strlen')) {
        if (mb_strlen($n, 'UTF-8') > MAX_NAME_LEN) $n = mb_substr($n, 0, MAX_NAME_LEN, 'UTF-8');
    } else {
        if (strlen($n) > MAX_NAME_LEN) {
            $n = substr($n, 0, MAX_NAME_LEN);
            // Trim any dangling UTF-8 continuation byte so we don't produce broken JSON.
            while (strlen($n) > 0 && (ord($n[strlen($n) - 1]) & 0xC0) === 0x80) {
                $n = substr($n, 0, -1);
            }
        }
    }
    return $n;
}

// Deterministic color from name so a returning player keeps the same badge color.
function color_from_name(string $name): string {
    $palette = ['#5b9bd5','#6bab42','#ef4444','#a855f7','#06b6d4','#f59e0b','#ec4899','#10b981'];
    $h = 0;
    for ($i = 0; $i < strlen($name); $i++) $h = ($h * 31 + ord($name[$i])) & 0xffffffff;
    return $palette[$h % count($palette)];
}

function valid_id(string $id): bool {
    return (bool) preg_match('/^[a-f0-9]{16,64}$/', $id);
}

// Load a room with an exclusive lock held for the duration of the caller's scope.
// Returns [data, lockHandle]. Caller must call save_room_and_unlock or unlock_room.
function load_room_locked(string $roomId) {
    if (!valid_id($roomId)) return [null, null];
    $path = room_path($roomId);
    if (!file_exists($path)) return [null, null];
    $fh = fopen($path, 'c+');
    if (!$fh) return [null, null];
    flock($fh, LOCK_EX);
    $raw = stream_get_contents($fh);
    $data = json_decode($raw, true);
    if (!is_array($data)) { flock($fh, LOCK_UN); fclose($fh); return [null, null]; }
    return [$data, $fh];
}

function save_room_and_unlock(array $data, $fh): void {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($data, JSON_UNESCAPED_SLASHES));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
}

function unlock_room($fh): void {
    if ($fh) { flock($fh, LOCK_UN); fclose($fh); }
}

// Fresh room skeleton. hints defaults match the client's migrateHints().
function new_room_state(string $seed, ?array $hints): array {
    $defaultHints = [
        'wrongFlags'      => false,
        'pulseNeighbors'  => false,
        'undoEnabled'     => false,
        'undoMode'        => 'refill',
        'chordFlag'       => false,
    ];
    return [
        'version'      => 0,
        'logRevision'  => 0,           // bumped whenever a past moveLog entry is rewritten (undo).
                                       // Clients compare against their last-seen value to know when
                                       // an incremental tail-delta is insufficient and they must
                                       // rebuild from the full moveLog instead.
        'seed'         => $seed,
        'hints'        => array_merge($defaultHints, $hints ?? []),
        'moveLog'      => '',
        'moveOwners'   => '',
        'players'      => new stdClass(),
        'createdAt'    => time(),
        'lastActivity' => time(),
    ];
}

// Token-bucket rate limit per player. State lives inside the player record so it
// costs no extra I/O — it's already loaded and saved by the sync flow.
// Returns true if allowed, false if the player has spent their burst allowance.
function check_and_consume_rate(array &$player): bool {
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

// Kick players we haven't heard from recently, so ghost cursors don't linger.
function prune_stale_players(array &$room): void {
    $cutoff = time() - PLAYER_STALE_SEC;
    if (!isset($room['players']) || !is_array($room['players'])) return;
    foreach ($room['players'] as $pid => $p) {
        if (!isset($p['lastSeen']) || $p['lastSeen'] < $cutoff) {
            unset($room['players'][$pid]);
        }
    }
}

// Best-effort room GC. Called opportunistically from create-room.php; not on the hot path.
function gc_rooms(): void {
    $dir = data_dir();
    $cutoff = time() - ROOM_TTL_SEC;
    foreach (glob($dir . '/*.json') as $f) {
        if (filemtime($f) < $cutoff) @unlink($f);
    }
}

function read_json_body(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function json_response(array $data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json');
    // The client is served from the same origin as this PHP, so CORS is not
    // strictly required. Emit it anyway so testing from a dev server on a
    // different port doesn't hit CORS errors.
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
