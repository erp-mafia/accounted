# Self-Hosting Accounted with Docker

## Prerequisites

- Docker and Docker Compose (v2)
- A [Supabase](https://supabase.com) project (free tier works)

You do **not** need Node.js, npm, or anything else installed locally. The pre-built image has everything.

---

## Quick Start

### 1. Download the required files

```bash
mkdir Accounted && cd Accounted

# Compose file + env template
curl -fsSLO https://raw.githubusercontent.com/gnubok/gnubok/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/gnubok/gnubok/main/.env.docker.example

# Cron sidecar (Dockerfile + schedule)
mkdir -p docker
curl -fsSL -o docker/cron.Dockerfile \
  https://raw.githubusercontent.com/gnubok/gnubok/main/docker/cron.Dockerfile
curl -fsSL -o docker/crontab.self-hosted \
  https://raw.githubusercontent.com/gnubok/gnubok/main/docker/crontab.self-hosted
```

### 2. Configure your environment

```bash
cp .env.docker.example .env
```

Open `.env` and fill in the **required** values:

| Variable | Where to find it |
|----------|-----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase dashboard → Settings → API → `anon` `public` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → `service_role` key |
| `NEXT_PUBLIC_APP_URL` | The URL where you'll access Accounted (e.g. `https://gnubok.example.com`) |
| `CRON_SECRET` | Any random string: `openssl rand -hex 32` works |

Once `.env` is filled in, **restrict its permissions** so other users on the host can't read your service-role key or cron secret:

```bash
chmod 600 .env
```

### 3. Start

```bash
docker compose up -d
```

The app is now reachable on **loopback only** at `http://127.0.0.1:3000`. This is intentional: direct internet exposure over HTTP is not safe for an accounting app. The next section enables HTTPS.

### 4. Verify

```bash
# Should return {"status":"healthy",...}
curl http://localhost:3000/api/health
```

---

## Enable HTTPS (recommended)

Ship a Caddy reverse proxy alongside the app: it auto-provisions Let's Encrypt certificates and renews them forever.

### 1. Point a domain at the host

`gnubok.example.com → <your-public-ip>` (A record). Ports 80 and 443 must be reachable from the internet (Let's Encrypt's HTTP-01 challenge uses port 80).

### 2. Set `DOMAIN` in `.env`

```env
DOMAIN=gnubok.example.com
NEXT_PUBLIC_APP_URL=https://gnubok.example.com
```

### 3. Download the overlay + Caddyfile

```bash
curl -fsSLO https://raw.githubusercontent.com/gnubok/gnubok/main/docker-compose.caddy.yml
mkdir -p docker
curl -fsSL -o docker/Caddyfile \
  https://raw.githubusercontent.com/gnubok/gnubok/main/docker/Caddyfile
```

### 4. Start with the overlay

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Caddy obtains a cert on first boot (takes ~10 s). Visit `https://gnubok.example.com`.

If you already have nginx / a managed load balancer / Cloudflare in front, skip Caddy and point your existing proxy at `127.0.0.1:3000`: set `NEXT_PUBLIC_APP_URL` to match the public URL.

---

## Optional Extensions

The self-hosted image ships with all extensions enabled (except Enable Banking, which requires private PSD2 credentials). Each extension activates when you provide its env vars: without them, the app works normally and the feature is simply unavailable.

### AI Features (ai-categorization, ai-chat, receipt-ocr, invoice-inbox)

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

### Email (invoice sending, reminders)

```env
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=faktura@your-domain.com
RESEND_WEBHOOK_SECRET=whsec_...
```

### Push Notifications

```env
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Generate VAPID keys with: `npx web-push generate-vapid-keys`

### Calendar

No env vars needed: always available.

---

## Updating

The default `IMAGE_TAG=latest` follows `main` and updates on every `docker compose pull`. For production, **pin to a specific release** so updates are deliberate:

```env
# .env
IMAGE_TAG=1.2.3
```

Browse available tags at https://github.com/erp-mafia/gnubok/pkgs/container/gnubok. For maximum integrity, pin by digest:

```env
IMAGE_TAG=1.2.3@sha256:abcdef...
```

Apply updates:

```bash
docker compose pull
docker compose up -d
```

The cron sidecar is a small Alpine image built locally: it rebuilds automatically on `up --build` if you re-download `docker/cron.Dockerfile`. Base-image digests (node, alpine, caddy) are pinned in source; [Dependabot](.github/dependabot.yml) opens PRs weekly when upstream ships security updates.

---

## Building from Source

If you prefer to build locally instead of pulling the pre-built image:

```bash
# Clone the repo
git clone https://github.com/gnubok/gnubok.git
cd Accounted
cp .env.docker.example .env
# Fill in .env

# Build and start
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d
```

---

## Architecture

The compose setup runs two containers:

| Container | What it does |
|-----------|-------------|
| `app` | Next.js application server |
| `cron` | Lightweight Alpine sidecar that runs scheduled jobs (deadline checks, invoice reminders, tax deadline sync, document verification) via [supercronic](https://github.com/aptible/supercronic) |

The cron container waits for the app's healthcheck to pass before starting. It calls the app's cron API endpoints over the internal Docker network.

### How NEXT_PUBLIC_* injection works

The image is built with placeholder values (e.g. `__NEXT_PUBLIC_SUPABASE_URL__`) baked into the JavaScript bundles. At container start, `docker-entrypoint.sh` runs as `root`, `sed`-substitutes the placeholders with your runtime env vars, then runs `chmod -R a-w /app/.next/static` and drops privileges with `su-exec nextjs:nodejs` before exec'ing Node. The served JS bundle is owned by `root` and read-only by the time the application starts: a runtime RCE in the Node process cannot rewrite what other users will receive.

---

## Ports

The app listens on port 3000 inside the container. The base compose binds it to `127.0.0.1:3000` on the host: change `PORT` in `.env` to remap. To expose on all interfaces (only do this if you're putting your own reverse proxy in front), override the port binding in a local `docker-compose.override.yml`:

```yaml
services:
  app:
    ports: !override
      - "${PORT:-3000}:3000"
```

---

## Reverse Proxy

The preferred path is the bundled Caddy overlay: see [Enable HTTPS](#enable-https-recommended). If you already run nginx, Traefik, or sit behind Cloudflare, leave the app on `127.0.0.1:3000` and point your existing proxy at it. Set `NEXT_PUBLIC_APP_URL` to the public URL.

Example nginx upstream:

```nginx
server {
    server_name gnubok.example.com;
    listen 443 ssl http2;
    # ssl_certificate / ssl_certificate_key / etc.

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Troubleshooting

**Container exits immediately**
```bash
docker compose logs app
```
Most common cause: missing required env vars. Check that all 5 required values in `.env` are set.

**Health check fails**
```bash
curl -v http://localhost:3000/api/health
```
The health endpoint tests database connectivity. If it returns `unhealthy`, verify your Supabase URL and service role key are correct.

**Cron container keeps restarting**
```bash
docker compose logs cron
```
The cron container depends on the app being healthy first. If the app never becomes healthy, the cron container will wait indefinitely.

**Port already in use**
Set a different port: `PORT=8080 docker compose up -d`
