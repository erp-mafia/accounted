#!/usr/bin/env bash
# Demo preflight for the Kleer / Meritmind meetings.
# Read-only. Touches nothing, changes nothing. Run it the morning of.
#
#   bash scripts/demo-preflight.sh
#
# Anything RED must be fixed before you walk in.

set -uo pipefail
BASE="${DEMO_BASE_URL:-https://app.gnubok.se}"
ok=0; fail=0
green() { printf '  \033[32mOK\033[0m   %s\n' "$1"; ok=$((ok+1)); }
red()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
warn()  { printf '  \033[33m??\033[0m   %s\n' "$1"; }
sec()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

sec "1. Appen svarar"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/" || echo 000)
[ "$code" = "307" ] || [ "$code" = "200" ] && green "app svarar ($code)" || red "app svarar inte ($code)"

ver=$(curl -s --max-time 10 "$BASE/api/version" | head -c 120)
[ -n "$ver" ] && green "version: $ver" || red "version-endpoint svarar inte"

sec "2. Agentytan (det Kleer inte har)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/extensions/ext/mcp-server/mcp" || echo 000)
if [ "$code" = "405" ] || [ "$code" = "401" ] || [ "$code" = "400" ]; then
  green "MCP-endpoint lever ($code, GET avvisas som väntat)"
else
  red "MCP-endpoint oväntat svar ($code)"
fi

res=$(curl -s --max-time 10 "$BASE/.well-known/oauth-protected-resource")
echo "$res" | grep -q "mcp-server" && green "OAuth-discovery pekar på MCP" || red "OAuth-discovery trasig"

skills=$(curl -s --max-time 10 "$BASE/.well-known/skills/index.json")
n=$(echo "$skills" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('skills',[])))" 2>/dev/null || echo 0)
[ "$n" -ge 5 ] && green "$n publicerade agentskills (Kleer har 0)" || red "skills-katalogen tom eller trasig"

sec "3. Jämförelsen du påstår i rummet"
kcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://mcp.kleer.se/mcp || echo 000)
[ "$kcode" = "401" ] && green "Kleers MCP lever och kräver auth ($kcode) — läs-only enligt deras egen dok" \
  || warn "Kleers MCP svarade $kcode (kontrollera påståendet innan du säger det högt)"
kskills=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://mcp.kleer.se/.well-known/skills/index.json || echo 000)
[ "$kskills" = "404" ] && green "Kleer publicerar ingen skills-katalog (404) — påståendet håller" \
  || warn "Kleer svarade $kskills på skills-index, kontrollera innan du säger det"

sec "4. Lokalt: spärrarna som är hela poängen"
root="$(cd "$(dirname "$0")/.." && pwd)"
trg="$root/supabase/migrations/20240101000017_enforcement_triggers.sql"
if [ -f "$trg" ]; then
  grep -q "immutable per Bokf" "$trg" && green "immutabilitetstriggern citerar bokföringslagen" || red "triggertexten hittades inte"
  grep -q "locked/closed fiscal period" "$trg" && green "periodlåstriggern på plats" || red "periodlåstriggern saknas"
else
  red "hittar inte enforcement_triggers.sql"
fi

t=$(grep -oE "name: '[a-z_]+'" "$root/extensions/general/mcp-server/server.ts" 2>/dev/null | sort -u | wc -l | tr -d ' ')
[ "$t" -ge 100 ] && green "$t MCP-verktyg registrerade" || red "oväntat få verktyg ($t)"
s=$(grep -c "stagePendingOperation" "$root/extensions/general/mcp-server/server.ts" 2>/dev/null || echo 0)
[ "$s" -ge 30 ] && green "$s skrivvägar stagar istället för att bokföra direkt" || red "staging ser fel ut ($s)"

sec "5. Demomiljön"
[ -f "$root/scripts/seed-demo-account.ts" ] && green "seed-demo-account.ts finns" || red "seedern saknas"
warn "Seedern kör mot .env.local = PRODUKTION. Kör den bara mot ett testkonto, aldrig mot kunddata."
warn "Manuellt: logga in som demoanvändaren och bekräfta Konsult AB, bokfört 2025, obokförda transaktioner 2026."

printf '\n\033[1mSummering:\033[0m %s ok, %s fel\n' "$ok" "$fail"
[ "$fail" -eq 0 ] && printf 'Klart att demo.\n' || printf 'Fixa felen ovan först.\n'
exit 0
