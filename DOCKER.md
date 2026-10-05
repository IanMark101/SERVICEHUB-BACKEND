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
