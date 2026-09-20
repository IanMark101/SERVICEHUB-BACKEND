# ServiceHub Cordova Docker Guide

This setup runs the production builds of the ServiceHub frontend and backend in Docker. The existing Neon PostgreSQL database and other hosted services remain external.

## Repository layout

The Compose file expects both repositories to remain beside each other:

```text
fullstack/
  SERVICEHUB-BACKEND/
  SERVICEHUB-FRONTEND/
```

Run all Compose commands from `SERVICEHUB-BACKEND`.

## 1. Prepare the backend environment

Create `SERVICEHUB-BACKEND/.env` from `.env.example` if it does not already exist. Do not commit this file.

At minimum, confirm the following values:

```env
DATABASE_URL=your_neon_postgresql_connection_string
DIRECT_URL=your_neon_direct_connection_string
JWT_ACCESS_SECRET=use_a_long_random_secret
JWT_REFRESH_SECRET=use_a_different_long_random_secret
FRONTEND_URL=http://localhost:3000
GOOGLE_CLIENT_ID=your_google_oauth_client_id
PAYMONGO_PUBLIC_KEY=your_test_public_key
PAYMONGO_SECRET_KEY=your_test_secret_key
PAYMONGO_WEBHOOK_SECRET=your_webhook_secret
```

For Neon, `DATABASE_URL` is the pooled application URL whose hostname contains
`-pooler`. `DIRECT_URL` is the connection string copied from Neon with
**Connection pooling disabled**. Prisma migration and other CLI commands use
`DIRECT_URL`; the running backend continues to use `DATABASE_URL`. Do not guess
or manually edit the direct hostname.

Keep the existing Cloudinary and SMTP variables when uploads and email delivery are required.

The Google client ID is public configuration. Compose passes the same ID into the frontend build. Passwords, database URLs, PayMongo secret keys, Cloudinary secrets, and SMTP credentials are supplied only to the backend container.

## 2. Validate the Compose configuration

```powershell
docker compose config --quiet
```

## 3. Build and start ServiceHub

```powershell
docker compose up --build -d
```

Compose performs these operations in order:

1. Builds the backend image and generates Prisma Client.
2. Applies committed Prisma migrations to Neon with `prisma migrate deploy`.
3. Starts the backend and waits for `/health` to pass.
4. Builds and starts the Next.js frontend.

Open:

- Application: `http://localhost:3000`
- API health check: `http://localhost:3001/health`

## 4. Inspect status and logs

```powershell
docker compose ps
docker compose logs -f backend frontend
```

To inspect the migration service:

```powershell
docker compose logs migrate
```

## 5. Stop the application

```powershell
docker compose down
```

This does not delete Neon data because the database is not stored in a Docker volume.

## Port conflicts

If local development servers already use ports 3000 and 3001, choose different host ports before building:

```powershell
$env:FRONTEND_PORT = "3100"
$env:BACKEND_PORT = "3101"
$env:FRONTEND_URL = "http://localhost:3100"
$env:NEXT_PUBLIC_API_URL = "http://localhost:3101/api"
docker compose up --build -d
```

The browser-facing `NEXT_PUBLIC_API_URL` is embedded during the frontend image build. Rebuild the frontend whenever that public URL changes.

## Rebuild after source changes

```powershell
docker compose up --build -d
```

## Run a fresh migration check manually

The default startup already rebuilds the migration image and runs
`prisma migrate deploy`. To rerun it explicitly after migration changes:

```powershell
docker compose build migrate
docker compose run --rm migrate
```

For a non-mutating connectivity and migration-history check, override the
service command:

```powershell
docker compose build migrate
docker compose run --rm migrate npx prisma migrate status
```

## PayMongo webhooks during local testing

Docker exposes the backend on the selected host port, but it does not make localhost reachable from PayMongo. Continue using the temporary Cloudflare tunnel for local webhook testing. Point the tunnel at the published backend port.

After deployment, configure PayMongo to call the deployed backend webhook URL directly. A tunnel is no longer required.

## Production deployment notes

- Set `FRONTEND_URL` to the deployed frontend origin.
- Set `NEXT_PUBLIC_API_URL` to the publicly reachable deployed backend URL ending in `/api`.
- Configure Google OAuth authorized origins for the deployed frontend.
- Configure PayMongo webhooks with the deployed backend endpoint.
- Use the platform's secret manager instead of committing an `.env` file.
