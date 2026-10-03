/**
 * Swedish version of CLI_MD (lib/docs/content/cli.ts).
 *
 * The docs site has no locale routing, so the two languages live at two URLs
 * and cross-link to each other. Keep them in sync: an edit to one is only half
 * an edit. Commands, code and CLI output stay identical in both.
 */
export const KOMMANDORAD_MD = `# Kommandoraden

> Använd Accounted från terminalen. Kommandot \`accounted\` når samma verktyg som Claude- och ChatGPT-anslutningarna, med samma behörigheter och samma godkännanden: ingenting bokförs förrän du har godkänt det.

_This page in English: [Command line (CLI)](/docs/api/cli)._

\`accounted\` är en liten kommandoradsklient till Accounteds [MCP](https://modelcontextprotocol.io)-server. Den är gjord för utvecklare, skript och AI-agenter som arbetar i en terminal: Claude Code, Codex, Cursor eller vad som helst annat som kan köra ett kommando. Alla verktyg på servern nås med \`accounted call\`, även de specialverktyg som en chattklient bara hittar genom att söka, och svaret kommer tillbaka som JSON.

Arbetar du hellre i claude.ai, Claude Desktop eller ChatGPT? Lägg då till en anslutning, se [Anslut Claude](/docs/api/anslut-claude).

## Installera

\`\`\`bash
npm install -g accounted
accounted --version
\`\`\`

Kräver Node.js 20 eller senare. \`npx accounted\` fungerar också utan installation, men då tar varje anrop tid att starta. Installera hellre när en agent ska göra många anrop.

## Logga in

\`\`\`bash
accounted login
\`\`\`

Webbläsaren öppnar Accounteds inloggning, och adressen skrivs också ut i terminalen ifall ingen webbläsare öppnas. Logga in med BankID eller e-post, så kommer godkännandesidan. Det är samma sida som Claude- och ChatGPT-anslutningarna visar: alla behörigheter är förvalda, och du kan bocka ur rader under **Behörigheter** eller välja **Endast läs** för att bara ge läsrätt. Har du flera bolag väljer du dessutom för varje bolag **Läsa och skriva**, **Bara läsa** eller **Ingen åtkomst**. Godkänn, så skriver terminalen \`Signed in\`.

**Logga in själv, i din egen terminal.** En agent ska aldrig logga in åt dig. I Claude Code kan du skriva \`! accounted login\` i prompten när webbläsaren körs på samma dator.

Över SSH eller i en container når webbläsaren inte datorn där kommandot körs. Öppna den utskrivna adressen i valfri webbläsare och godkänn. Webbläsaren hamnar då på en sida som inte går att ladda: kopiera hela adressen till den sidan, klistra in den i terminalen och tryck Enter. \`accounted login --no-browser\` hoppar över webbläsaren och går direkt till inklistringen. Inloggningen väntar i 5 minuter.

Inloggningen sparas i \`~/.config/accounted/credentials.json\` (under \`$XDG_CONFIG_HOME\` om den är satt, i \`%APPDATA%\\accounted\` på Windows), och bara din användare kan läsa filen. Den syns som en anslutning under **Inställningar › API och MCP** (\`/settings/api\`).

- \`accounted status\` visar servern, inloggningen och vilka bolag den når. Kommandot avslutas med kod 3 om du inte är inloggad.
- \`accounted logout\` tar bort inloggningen från den här datorn, men bara här. Nyckeln fungerar tills du kopplar från den under Inställningar › API och MCP, och logout skriver ut nyckelns prefix så att du hittar rätt rad.
- \`accounted login --force\` byter ut inloggningen, till exempel för att ge andra behörigheter. Koppla sedan från den gamla nyckeln i inställningarna.

## Hitta och kör verktyg

- \`accounted guide\` förklarar hur du arbetar med Accounted: arbetsflöden, godkännanden och bolag.
- \`accounted tools\` listar de vanligaste verktygen, och \`accounted tools supplier invoice\` söker bland alla.
- \`accounted describe create_customer\` visar ett verktygs definition och vilka argument det tar.
- \`accounted call list_invoices '{"limit": 5}'\` kör ett verktyg.

Verktygsnamn fungerar med eller utan prefixet \`accounted_\` och med \`-\` eller \`_\`: \`list-invoices\`, \`list_invoices\` och \`accounted_list_invoices\` är samma verktyg. \`accounted call\` når alla verktyg, även de som bara hittas genom sökning. Nämner ett sökresultat eller guiden \`callable_via\`, \`call_tool\` eller \`stage_tool\` kan du bortse från det: de omvägarna finns för chattklienter som inte kan anropa ett olistat verktyg, och kommandoraden behöver dem inte. Är du utloggad söker \`accounted tools\` bara bland de verktyg som fungerar utan konto; inloggad söker den bland alla.

Argumenten är ett JSON-objekt, direkt på raden, från en fil eller från stdin med \`-\`:

\`\`\`bash
accounted call get_general_ledger '{"account_from": "1930", "account_to": "1930"}'
accounted call create_customer '@customer.json'
accounted call create_customer - <<'EOF'
{"name": "Exempel AB", "customer_type": "swedish_business", "email": "billing@example.com"}
EOF
\`\`\`

Det finns med flit inga \`--flag\`-argument: att gissa typer på kommandoraden skulle göra kontonumret \`"1930"\` till ett tal. Kontonummer är strängar, belopp anges i kronor och datum skrivs \`YYYY-MM-DD\`. \`accounted describe\` visar exakt vad ett verktyg tar.

Resultatet skrivs till stdout som JSON: indraget i en terminal och på en rad i en pipe, så att det fungerar ihop med verktyg som \`jq\`. Meddelanden till dig eller agenten (vilket bolag som svarade, vad som är nästa steg) går till stderr. Ett fel från ett verktyg skrivs som \`{"error": {...}}\` på stderr, och kommandot avslutas med kod 1.

## Skrivningar väntar på ditt godkännande

Skrivningar fungerar precis som via MCP. Ett verktyg som ändrar i bokföringen (kontera, skapa en faktura, bokföra ett verifikat, stänga en period) ändrar ingenting direkt. Det lägger upp en åtgärd för godkännande, med en förhandsvisning av vad som skulle bokföras, och kommandoraden skriver ut hur du godkänner den:

\`\`\`text
Staged for approval: operation 9a44..., risk medium. Nothing is booked yet.
When the user approves it, run: accounted call approve_pending_operation '{"operation_id":"9a44...","company_id":"..."}'
Or approve it in the browser: https://app.accounted.se/pending
\`\`\`

Läs förhandsvisningen och godkänn sedan med kommandot eller under **/pending** i appen. En agent ska visa dig förhandsvisningen och fråga dig innan den kör godkännandet.

Åtgärder med hög risk (till exempel manuella verifikat, rättelser, periodlåsning och bokslut) går inte att ta tillbaka när de väl är godkända (BFL 5 kap 5 §). För dem saknar det utskrivna kommandot \`"confirmed": true\` med flit, och kommandoraden säger det: agenten visar dig förhandsvisningen, får ditt uttryckliga klartecken och lägger först därefter till \`"confirmed": true\` i argumenten.

Saknar inloggningen behörighet att godkänna, godkänner du under **/pending** i stället.

## Långa anrop

Några verktyg, som \`audit_package\`, tar längre tid än man vill vänta på ett enskilt kommando. De körs som en uppgift på servern: kommandoraden skriver ut uppgiftens id och väntar på resultatet. Avbryts kommandot (en tidsgräns i agenten, en terminal som stängs) tar du upp det igen med:

\`\`\`bash
accounted task <id>
\`\`\`

Uppgifter sparas i en timme.

## Bolag

En inloggning når alla bolag du gav den åtkomst till. \`accounted status\` listar dem med deras id. Ett anrop som inte anger \`company_id\` går mot standardbolaget, och når inloggningen flera bolag säger ett meddelande på stderr vilket bolag som svarade.

Vill du hålla alla anrop i ett och samma bolag låser du det med \`--company\` eller \`ACCOUNTED_COMPANY\`:

\`\`\`bash
accounted call list_invoices --company <company-id>
export ACCOUNTED_COMPANY=<company-id>
\`\`\`

Värdet måste vara bolagets id (ett UUID). Ett namn eller ett felskrivet id avvisas i stället för att anslutningen faller tillbaka på alla bolag, och så länge låset gäller avvisas anrop som anger ett annat bolag.

## Skript och avslutningskoder

Varje kommando avslutas med en kod som ett skript kan testa:

- \`0\`: klart.
- \`1\`: verktyget svarade med ett fel (\`{"error": {...}}\` på stderr).
- \`2\`: felaktig användning: okänt kommando eller verktyg, eller argument som inte är ett JSON-objekt.
- \`3\`: inte inloggad, eller inloggningen har upphört.
- \`4\`: problem med servern eller nätverket, även när servern begränsar antalet anrop (\`retry after N s\`).

\`\`\`bash
accounted status > /dev/null || exit $?
accounted call list_invoices '{"status": "overdue"}' | jq -r '.invoices[].invoice_number'
\`\`\`

En nyckel får som standard göra 100 anrop i minuten. Vid gränsen avslutas kommandot med kod 4 och talar om hur länge du ska vänta: vänta så länge i stället för att försöka igen i en loop.

## API-nyckel för CI och servrar

Där ingen kan öppna en webbläsare använder du en API-nyckel i stället för en inloggning. Skapa den under **Inställningar › API och MCP** (\`/settings/api\`), spara den bland CI-tjänstens hemligheter och sätt den som \`ACCOUNTED_API_KEY\`:

\`\`\`bash
export ACCOUNTED_API_KEY=gnubok_sk_...
accounted call get_trial_balance > trial-balance.json
\`\`\`

Nyckelns behörigheter avgör vilka verktyg som fungerar, och ingenting sparas på disk. När variabeln är satt går den före en sparad inloggning. En testnyckel (\`gnubok_sk_test_...\`) läser dina riktiga data, men dess skrivningar körs bara som provkörningar, och en skrivning som inte går att provköra nekas, så med den kan du experimentera tryggt.

## Egen server

Kör du Accounted i egen drift? Peka kommandoraden mot din server med \`--url\` eller \`ACCOUNTED_URL\`. Båda tar appens adress eller hela MCP-adressen, samma variabel som bryggan \`accounted-mcp\` använder. Varje server har sin egen inloggning.

## Windows

I PowerShell skickar du JSON från en fil. JSON direkt på raden kan tappa sina citattecken på vägen till kommandot, och i Windows PowerShell 5.1 blir å, ä och ö till \`?\` när JSON skickas in via \`-\`. Spara JSON som UTF-8 och sätt citattecken runt filargumentet, eftersom \`@\` betyder något annat i PowerShell:

\`\`\`powershell
accounted call create_customer '@customer.json'
\`\`\`

## Felsökning

- **Kod 3, "Not signed in".** Kör \`accounted login\` i din egen terminal.
- **En agent i en sandlåda får kod 3.** En agent i en sandlåda kan varken spara eller förnya en inloggning ("Cannot save the sign-in", "cannot be written here"). Kör \`accounted login\`, eller \`accounted status\` som förnyar en inloggning som behöver det, i din egen terminal och låt sedan agenten fortsätta.
- **"Already signed in".** Kör \`accounted login --force\` för att byta inloggning, eller \`accounted logout\` först.
- **"The sign-in has ended".** Anslutningen har kopplats från i inställningarna eller gäller inte längre. Kör \`accounted login\` igen.
- **Kod 4, "Rate limited".** Vänta det antal sekunder som visas och fortsätt sedan.
- **"The server redirected to ...".** Ange den adressen med \`--url\`.
- **Bakom en proxy.** \`HTTPS_PROXY\` och andra proxyinställningar stöds inte i version 0.1: kommandoraden ansluter direkt till servern.

Fastnar du ändå? Använd supportformuläret i appen under **/help** och skriv med kommandot, avslutningskoden och felmeddelandet.
`
