#!/bin/sh
set -e

echo "Accounted setup"
echo "============"
echo ""

# ─── Check prerequisites ───
ok=true
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed. Install it from https://docs.docker.com/get-docker/"
  ok=false
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose is not available. Install Docker Compose v2+."
  ok=false
fi
if [ "$ok" = false ]; then
  exit 1
fi

# ─── Create .env file ───
if [ -f .env ]; then
  printf ".env already exists. Overwrite? [y/N] "
  read -r answer
  case "$answer" in
    [yY]*) ;;
    *) echo "Keeping existing .env. Exiting."; exit 0 ;;
  esac
fi

if [ ! -f .env.docker.example ]; then
  echo "ERROR: .env.docker.example not found. Are you in the Accounted directory?"
  exit 1
fi

cp .env.docker.example .env

# ─── Auto-generate CRON_SECRET ───
if command -v openssl >/dev/null 2>&1; then
  cron_secret=$(openssl rand -hex 32)
else
  cron_secret=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi
sed -i.bak "s|generate-a-random-secret|${cron_secret}|" .env && rm -f .env.bak

# ─── Prompt for Supabase values ───
echo ""
echo "Enter your Supabase project values (from Settings > API in the Supabase dashboard):"
echo ""

printf "NEXT_PUBLIC_SUPABASE_URL (e.g. https://abcdefgh.supabase.co): "
read -r supabase_url
if [ -n "$supabase_url" ]; then
  sed -i.bak "s|https://your-project.supabase.co|${supabase_url}|" .env && rm -f .env.bak
fi

printf "NEXT_PUBLIC_SUPABASE_ANON_KEY: "
read -r anon_key
if [ -n "$anon_key" ]; then
  sed -i.bak "s|your-anon-key|${anon_key}|" .env && rm -f .env.bak
fi

printf "SUPABASE_SERVICE_ROLE_KEY: "
read -r service_key
if [ -n "$service_key" ]; then
  sed -i.bak "s|your-service-role-key|${service_key}|" .env && rm -f .env.bak
fi

printf "NEXT_PUBLIC_APP_URL [http://localhost:3000]: "
read -r app_url
app_url="${app_url:-http://localhost:3000}"
sed -i.bak "s|https://your-domain.com|${app_url}|" .env && rm -f .env.bak

echo ""
echo "Done! .env has been configured."
echo ""
echo "Next steps:"
echo "  1. Apply database migrations (see docs/SELF-HOSTING.md section 3)"
echo "  2. Run: docker compose up -d"
echo ""
