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

Browsers only enable the service worker (offline play, "Install app") on HTTPS or `localhost`. The game itself works over plain HTTP. For a public server, put a reverse proxy with TLS (Caddy, Traefik, nginx) in front and point it at port 8080.

## Update

```sh
git pull
docker compose up -d --build
```

Save files are not touched. Players pick up new front-end files once `CACHE_NAME` in `sw.js` has been bumped, because the service worker serves cached files first.

## Manage

```sh
docker compose logs -f     # follow logs
docker compose ps          # status and health
docker compose down        # stop and remove the container (saves stay in ./data/rooms)
```
