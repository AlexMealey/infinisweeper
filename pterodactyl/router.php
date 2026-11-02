<?php
// router.php – front controller for PHP's built-in web server, which the Pterodactyl egg runs in place of Apache.
// The built-in server ignores .htaccess and serves every file under the server folder, so this lets through only what
// the Docker image serves (the Dockerfile's COPY lines) and 404s the rest: room saves, .git, the PHP binary.

$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/');

if ($path === '/' || preg_match('#^/(?:index\.html|manifest\.json|sw\.js|(?:css|icons|js|lib|php)/[^/.][^/]*)$#D', $path)) {
    return false; // the built-in server serves the file, or runs it if it's PHP
}

http_response_code(404);
header('Content-Type: text/plain');
echo "Not found\n";
