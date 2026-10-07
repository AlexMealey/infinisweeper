# InfiniSweeper

An infinite, procedurally generated minesweeper. Installable as a PWA, with co-op multiplayer rooms served by a small PHP backend.

## Deploy with Docker

Needs `git` and Docker with the Compose plugin.

```sh
git clone https://github.com/AlexMealey/infinisweeper.git
cd infinisweeper
docker compose up -d --build
```

Open `http://<server-ip>:8080`.

## Save files

Multiplayer rooms are saved as one JSON file per room. They are volume-mapped to the host:

| Host | Container |
|---|---|
| `./data/rooms/` | `/var/www/html/data/rooms/` |

- They survive container restarts, rebuilds and `docker compose down`.
- The container gives the folder to `www-data` (uid 33) on start, so the files are owned by uid 33 on the host. You can read them freely; deleting them needs `sudo`.
- Rooms with no activity for 24 hours are deleted automatically (`ROOM_TTL_SEC` in `php/lib.php`).
- Single-player progress is kept in each player's browser, not on the server.

Back up:

```sh
tar czf infinisweeper-rooms-$(date +%F).tgz data/rooms
```

## Without Compose (`docker run`)

```sh
git clone https://github.com/AlexMealey/infinisweeper.git
cd infinisweeper
docker build -t infinisweeper .
docker run -d --name infinisweeper --restart unless-stopped \
  -p 8080:80 \
  -v "$(pwd)/data/rooms:/var/www/html/data/rooms" \
  infinisweeper
```

## Change the port

```sh
PORT=9000 docker compose up -d
```

Or put `PORT=9000` in a `.env` file next to `docker-compose.yml`.

## HTTPS

Browsers only enable the service worker (offline play, "Install app") on HTTPS or `localhost`. The game itself works over plain HTTP. Timelapse export works over plain HTTP too, but browsers hide their own video encoder there, so it uses a built-in WebAssembly one that is about 15× slower. For a public server, put a reverse proxy with TLS (Caddy, Traefik, nginx) in front and point it at port 8080.

## Update

1. On your dev machine, commit and push the changes:

   ```sh
   git add -A
   git commit -m "Describe the change"
   git push
   ```

2. On the server, pull and rebuild:

   ```sh
   cd infinisweeper
   git pull
   docker compose up -d --build
   ```

   The site is down for a few seconds while the container restarts. Save files in `./data/rooms` are not touched.

3. Check that it came back healthy:

   ```sh
   docker compose ps        # STATUS shows "healthy" after ~10 seconds
   docker compose logs -f   # watch for errors, Ctrl+C to exit
   ```

4. Tell players to refresh the page.

If you changed any front-end file (`index.html`, `css/`, `js/`), bump `CACHE_NAME` in `sw.js` before committing. The service worker serves cached files first, so without the bump, HTTPS players keep the old version.

Each rebuild leaves an old image behind. Clear them now and then with `docker image prune -f`.

## Manage

```sh
docker compose logs -f     # follow logs
docker compose ps          # status and health
docker compose down        # stop and remove the container (saves stay in ./data/rooms)
```
