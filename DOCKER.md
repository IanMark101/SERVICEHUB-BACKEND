# ServiceHub Backend Docker Guide

The backend follows the Docker layout in
[portfolio-backend-api](https://github.com/arielmaestrodev/portfolio-backend-api):
a two-stage Alpine image, a root Compose file for local builds, and a separate
`docker/docker-compose.yaml` for a server that pulls a Docker Hub image.

## Environment

Keep the backend's existing `.env`, or copy `.env.example` and fill in real
values. The environment file is excluded from the image and supplied at runtime
by Compose. Required values include `DATABASE_URL`, `JWT_ACCESS_SECRET`, and
`JWT_REFRESH_SECRET`. Set `FRONTEND_URL` to your frontend origin.

The backend allows `https://servicehubcordova.tech`,
`https://www.servicehubcordova.tech`, and
`https://servicehub-frontend-umber.vercel.app`, plus the configured `FRONTEND_URL`,
for HTTP CORS, Socket.IO CORS, and production session/refresh/logout requests.
Use `FRONTEND_URL=https://servicehubcordova.tech` on the server for canonical
email and payment-return links. Additional frontend origins can be supplied in
the comma-separated `FRONTEND_ORIGINS` setting.

For `NODE_ENV=production`, also provide `PAYMONGO_PUBLIC_KEY`,
`PAYMONGO_SECRET_KEY`, and `PAYMONGO_WEBHOOK_SECRET`.

`DATABASE_URL` is the application's pooled Neon connection. `DIRECT_URL` is
the direct connection copied from Neon for Prisma migration commands.

## Local build and start

Run these commands from `SERVICEHUB-BACKEND`:

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose logs -f app
```

The API listens on port 8000 inside the container and is available at
`http://localhost:8000`. Check `http://localhost:8000/health`.
For a separately running frontend, configure its public API URL as
`http://localhost:8000/api`.

Stop the backend with `docker compose down`.

## Build and publish the server image

The server Compose file uses the existing `ianmark123/servicehub-backend` image:

```powershell
docker build -t ianmark123/servicehub-backend:latest .
docker push ianmark123/servicehub-backend:latest
```

If using another Docker Hub account, change the image name in
`docker/docker-compose.yaml` and both commands to match.

## Server deployment

Place the server's environment file at `/root/env/servicehub-backend/.env` and
copy `docker/docker-compose.yaml` to `/root/docker/docker-compose.yaml`.
The server Compose file sets `NODE_ENV=production` and `PORT=8000` and restarts
the API unless it was explicitly stopped.

Run on the server:

```sh
cd /root/docker
docker compose config --quiet
docker compose pull app
docker compose up -d app
docker compose logs -f app
```

## Nginx and WebSocket connections

For the existing host configuration at
`/etc/nginx/sites-enabled/api.servicehubcordova.tech`, run the repair helper on
the backend server:

```sh
sudo python3 scripts/fix-nginx-websocket.py
```

It backs up the resolved configuration file under `/root`, adds the required
upgrade headers and timeouts to the existing API proxy location, validates with
`nginx -t`, and reloads Nginx. A validation or reload failure restores the saved
configuration. Existing certificate settings and site symlinks are preserved.

The frontend starts Socket.IO with HTTP polling and then attempts a WebSocket
upgrade. Both transports use `/socket.io/` on the backend origin. The API's
existing HTTPS Nginx server block must forward WebSocket upgrade headers to
the backend on port 8000.

Copy `docker/nginx-socket.io.conf` to
`/etc/nginx/snippets/servicehub-socket.io.conf` on the server. Include it inside
the existing `server` block serving HTTPS for `api.servicehubcordova.tech`:

```nginx
include /etc/nginx/snippets/servicehub-socket.io.conf;
```

If that server block already has a `location /socket.io/` block, replace that
location with the supplied block instead of adding a second one. The upstream
assumes Nginx runs on the Docker host; a containerized Nginx needs the backend's
container hostname and shared Docker network instead of `127.0.0.1`.

Validate and reload the host's Nginx configuration:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

The repository's root `nginx.config` is the reference project's static SPA
configuration; use the Socket.IO snippet with the server's existing HTTPS
configuration. A container rebuild does not update that host configuration.

HTTP polling returning an Engine.IO handshake while WebSocket returns HTTP 400
with `code: 3` indicates an upgrade/proxy problem. Keep the frontend's polling
fallback enabled, and verify the WebSocket handshake returns HTTP 101 after the
Nginx change. See the [Socket.IO reverse proxy guide](https://socket.io/docs/v4/reverse-proxy/).

## GitHub Actions deployment

`.github/workflows/deploy.yaml` builds and pushes the backend image when `main`
changes, then copies the server Compose file and `scripts/deploy.sh` to `/root`
over SSH and runs the script. Pushes changing only `Docs/**` are skipped.

Configure one repository secret named `SERVICEHUBSECRETKEY` in GitHub Settings >
Secrets and variables > Actions. Its value must be a valid JSON object containing
these fields; the workflow reads them with `fromJSON(secrets.SERVICEHUBSECRETKEY)`:

- `DOCKERHUB_USERNAME`: `ianmark123`, matching the image in the server Compose file.
- `DOCKERHUB_TOKEN`: a Docker Hub access token with push permission for that image.
- `SSH_HOST`: the backend server's hostname or IP address.
- `SSH_USER`: the SSH account with access to `/root` and permission to run Docker.
- `SSH_PRIVATE_KEY`: the private key authorized for that SSH account.

Store the private key as a JSON string with its line breaks encoded as `\n`.
Keep the actual secret value in GitHub's secret store.

The server needs Docker with the Compose plugin and the environment file at
`/root/env/servicehub-backend/.env` before the first deployment. If using another
Docker Hub account, also update the image in `docker/docker-compose.yaml`.

The deployment script validates Compose, pulls the image, and updates only the
`app` service. A failed pull leaves the running container in place. Database
migrations remain a separate release step as described below.

## Database migrations

Building or starting the API does not apply database migrations. Run the pinned
Prisma CLI from the backend checkout before a planned release:

```powershell
npm ci
npx prisma migrate status
# Apply committed migrations during a planned release:
npx prisma migrate deploy
```

The runtime image copies the Prisma Client generated in the builder stage and
does not install an unpinned Prisma CLI. It starts with the backend's existing
`npm start` command (`node ./dist/src/server.js`).
