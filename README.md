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

## Deploy on Pterodactyl

`pterodactyl/egg-infinisweeper.json` is an egg for Pterodactyl (or Pelican). It serves the game on the port you allocate to the server. It runs PHP's built-in web server instead of Apache: the install script downloads a static PHP build from static-php.dev, and `pterodactyl/router.php` serves only the files the Docker image does.

1. Admin panel → **Nests** → pick or create a nest → **Import Egg**, and upload `pterodactyl/egg-infinisweeper.json`.
2. Make sure the node has the port you want: **Nodes** → your node → **Allocation**.
3. **Servers** → **Create New**. Pick that IP and port as the **Default Allocation** and choose the InfiniSweeper egg; the variable defaults work. 256 MB of memory and 1 GB of disk are plenty.
4. When the install finishes, start the server. It's up when the console shows `Development Server (http://0.0.0.0:<port>) started`.
5. Open `http://<server-ip>:<port>`.

| Variable | Default | |
|---|---|---|
| Git Repository | this repo | Where the game is downloaded from |
| Git Branch | `main` | |
| Auto Update | `1` | Pull the latest commit from the branch on every start |
| PHP Workers | `4` | Requests handled at once |
| PHP Version | `8.4` | Static PHP version to install |

To update, push to the branch and restart the server. With Auto Update off, or after changing the repository or PHP version, use **Settings** → **Reinstall Server** instead. Either way, files you changed in the server folder are overwritten. Room saves in `data/rooms` are kept and expire after 24 hours, as with Docker.

To change the port later, add the new port to the node, set it as the server's primary allocation under **Build Configuration**, and restart.

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

Players get the new version on their next load or refresh. The service worker asks the server first and only uses its cached copy when the server is unreachable or takes over 4 seconds. If you add a front-end file, also list it in `PRE_CACHE` in `sw.js` so it works offline from the first visit.

Each rebuild leaves an old image behind. Clear them now and then with `docker image prune -f`.

## Manage

```sh
docker compose logs -f     # follow logs
docker compose ps          # status and health
docker compose down        # stop and remove the container (saves stay in ./data/rooms)
```
