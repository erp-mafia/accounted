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

# Run from the repository root so .env lands next to docker-compose.yml.
cd "$(dirname "$0")/.."

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# ─── PERSONNUMMER_ENCRYPTION_KEY ───
# Encrypts every stored personnummer. A key that already exists is never
# replaced, whatever the answer below: personnummer encrypted with it could
# not be read again.
existing_pnr_key=""
if [ -f .env ]; then
  existing_pnr_key=$(sed -n 's/^PERSONNUMMER_ENCRYPTION_KEY=//p' .env | tail -n 1)
fi

# Fills the PERSONNUMMER_ENCRYPTION_KEY= line in .env, or appends one. awk
# reads the value from the environment, so no character in it is interpreted.
write_pnr_key() {
  if grep -q '^PERSONNUMMER_ENCRYPTION_KEY=' .env; then
    PNR_KEY="$1" awk '/^PERSONNUMMER_ENCRYPTION_KEY=/ { print "PERSONNUMMER_ENCRYPTION_KEY=" ENVIRON["PNR_KEY"]; next } { print }' .env > .env.tmp
    cat .env.tmp > .env
    rm -f .env.tmp
  else
    if [ -n "$(tail -c 1 .env)" ]; then
      printf '\n' >> .env
    fi
    printf 'PERSONNUMMER_ENCRYPTION_KEY=%s\n' "$1" >> .env
  fi
}

# ─── Create .env file ───
if [ -f .env ]; then
  printf ".env already exists. Overwrite? [y/N] "
  read -r answer
  case "$answer" in
    [yY]*) ;;
    *)
      if [ -z "$existing_pnr_key" ]; then
        write_pnr_key "$(random_hex)"
        echo "Added a generated PERSONNUMMER_ENCRYPTION_KEY to the existing .env."
      fi
      echo "Keeping existing .env. Exiting."
      exit 0
      ;;
  esac
fi

if [ ! -f docker/.env.example ]; then
  echo "ERROR: docker/.env.example not found. Are you in the Accounted directory?"
  exit 1
fi

cp docker/.env.example .env

# ─── Auto-generate CRON_SECRET ───
cron_secret=$(random_hex)
sed -i.bak "s|generate-a-random-secret|${cron_secret}|" .env && rm -f .env.bak

# ─── Keep or generate PERSONNUMMER_ENCRYPTION_KEY ───
if [ -n "$existing_pnr_key" ]; then
  write_pnr_key "$existing_pnr_key"
  echo "Kept the existing PERSONNUMMER_ENCRYPTION_KEY."
else
  write_pnr_key "$(random_hex)"
fi

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
echo "Back up .env together with the database: stored personnummer cannot be"
echo "read without its PERSONNUMMER_ENCRYPTION_KEY."
echo ""
echo "Next steps:"
echo "  1. Apply database migrations (see docs/SELF-HOSTING.md section 3)"
echo "  2. Run: docker compose up -d"
echo ""
