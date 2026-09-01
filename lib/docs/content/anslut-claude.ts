/**
 * Swedish translation of CONNECT_CLAUDE_MD (lib/docs/content/connect-claude.ts).
 *
 * The docs site has no locale routing, so the two languages live at two URLs
 * and cross-link to each other. Keep them in sync: an edit to one is only half
 * an edit.
 */
export const ANSLUT_CLAUDE_MD = `# Anslut Claude

> Prata med din bokföring. Koppla Accounted till Claude (claude.ai, Claude Desktop eller Claude Code) och ställ frågor, kontera transaktioner och förbered momsdeklarationen i vanligt språk. Varje skrivning stannar för ditt godkännande först.

_This page in English: [Connect with Claude](/docs/api/connect-claude)._

Accounted har en [MCP](https://modelcontextprotocol.io)-server som exponerar hela bokföringsmotorn (150+ verktyg) för vilken MCP-klient som helst. Adressen är:

\`\`\`
https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted
\`\`\`

Det finns tre vägar in, beroende på vilken klient du använder. Alla tre når samma verktyg och samma godkännandemodell: läsverktyg svarar direkt, medan skrivverktyg (kontera, markera betald, skapa verifikat, bokslut) **lägger upp en pending operation** som du bekräftar i chatten eller i webbgränssnittet under **/pending** innan något bokförs.

## Väg A: claude.ai eller Claude Desktop (ett klick)

**[→ Anslut Accounted till Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Accounted&connectorUrl=https%3A%2F%2Fapp.accounted.se%2Fapi%2Fextensions%2Fext%2Fmcp-server%2Fmcp%3Ftool_namespace%3Daccounted%26client%3Dclaude-connector)**

Länken öppnar claude.ai med namn och adress ifyllda. Du granskar värdena och godkänner; länken fyller bara i formuläret och ger ingenting i sig. Ingen API-nyckel att hålla reda på.

**Du behöver inget Accounted-konto ännu.** Anslutningen fungerar direkt: servern svarar på handskakningen och dokumentationsverktygen utan inloggning, och första anropet som rör ett bolag öppnar Accounteds inloggning, där du som ny skapar kontot (BankID eller e-post + 2FA).

**Läsrättigheter som standard.** På godkännandesidan väljer du bolag och ger läsrättigheter (lista fakturor, läsa rapporter, räkna moms). Skrivrättigheter (skapa faktura, kontera, bokföra verifikat, köra bokslut) listas separat och måste bockas i uttryckligen. Så kan en granskare ansluta läsande medan du själv har en anslutning med skrivrättigheter för det dagliga arbetet.

#### Lägga till manuellt i stället

I **claude.ai** (Inställningar → Connectors) eller **Claude Desktop** (Inställningar → Connectors → Add custom connector), välj **Add custom connector** och klistra in:

\`\`\`
https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=claude-connector
\`\`\`

Behåll \`tool_namespace=accounted\`: den väljer verktygsnamnen som guiden utgår från. \`client=claude-connector\` är bara statistik. Frågar dialogen om autentisering, välj **"Required when the server asks"**, inte det automatiskt föreslagna "None".

## Väg B: Claude Code (plugin)

Bäst i terminalen. Pluginet installerar både anslutningen och sju färdiga arbetsflöden som följer den svenska bokföringsrytmen.

\`\`\`text
/plugin marketplace add erp-mafia/accounted
/plugin install accounted@accounted
\`\`\`

Kör sedan \`/mcp\` och logga in med Accounted (samma OAuth-ruta som i väg A). Börja med \`/accounted:start\`.

| Kommando | Vad det gör |
|---|---|
| \`/accounted:start\` | Ansluter, orienterar och visar vad som behöver göras |
| \`/accounted:bookkeep\` | Betar av obokförda banktransaktioner och kvitton |
| \`/accounted:check\` | Läsande hälsokoll med prioriterad åtgärdslista |
| \`/accounted:month-close\` | Stänger månaden mot produktens checklista |
| \`/accounted:vat\` | Förbereder och stämmer av momsdeklarationen |
| \`/accounted:payroll\` | Månadens lönekörning och underlag för AGI |
| \`/accounted:year-end\` | Bokslut, spärrat mot readiness-kontrollen |

Vill du bara ha anslutningen utan arbetsflödena kopplar \`claude mcp add\` in samma server i Claude Code:

\`\`\`bash
claude mcp add accounted --transport http \\
  "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=claude-code"
\`\`\`

**Cursor** har inget pluginformat och läser inte \`claude mcp add\`. Lägg i stället till servern i \`~/.cursor/mcp.json\` (globalt) eller \`.cursor/mcp.json\` (per projekt):

\`\`\`json
{
  "mcpServers": {
    "accounted": {
      "url": "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=cursor"
    }
  }
}
\`\`\`

## Väg C: \`npx accounted-mcp\` med API-nyckel

Bäst när du hellre använder en långlivad API-nyckel än OAuth-flödet, eller när du skriptar.

1. Skapa en API-nyckel i Accounted under **Inställningar → API & MCP**. Använd en \`gnubok_sk_test_*\`-nyckel mot sandlådan medan du utvärderar och byt till \`gnubok_sk_live_*\` för skarp data.
2. Lägg till bryggan i din \`claude_desktop_config.json\`:
   \`\`\`json
   {
     "mcpServers": {
       "accounted": {
         "command": "npx",
         "args": ["-y", "accounted-mcp"],
         "env": {
           "ACCOUNTED_API_KEY": "gnubok_sk_test_...",
           "ACCOUNTED_CLIENT": "claude-desktop"
         }
       }
     }
   }
   \`\`\`
   Kör du Accounted i egen drift pekar du om bryggan med \`ACCOUNTED_URL\`.
3. Starta om Claude Desktop. Bryggan skickar vidare stdio-JSON-RPC till den hostade MCP-servern över HTTPS, och nyckeln bär de rättigheter du gav den när den skapades.

Nyckelns rättigheter styr exakt vilka verktyg som går att kalla: en nyckel utan skrivrättigheter kan läsa rapporter och reskontror men inte lägga upp en bokföring.

Nyckelvärdet börjar fortfarande med \`gnubok_sk_\`. Det är ett stabilt kreditformat, inte namnet på integrationen. Befintliga \`gnubok-mcp\`-konfigurationer fortsätter att fungera oförändrade.

## Testa med de här frågorna

Alla tre går mot den deterministiska sandlådan (använd en \`gnubok_sk_test_*\`-nyckel eller välj sandlådebolaget på godkännandesidan). De går igenom hela läsvägen utan att bokföra något.

1. **"Visa mina okonterade banktransaktioner och föreslå konteringar."**
   Claude kallar \`accounted_list_uncategorized_transactions\` och sedan \`accounted_suggest_categories\` och går igenom förslagen med dig. Godkänner du ett förslag läggs en \`accounted_categorize_transaction\` upp som pending operation. Ingenting bokförs förrän du bekräftar.
2. **"Vilka fakturor är förfallna?"**
   Claude kallar \`accounted_get_ar_ledger\` (kundreskontra) och listar utestående kundfakturor med åldersfördelning.
3. **"Räkna fram momsen för det här kvartalet och säg om jag kan stänga."**
   Claude kallar \`accounted_get_vat_report\` för momsdeklarationens rutor och sedan \`accounted_vat_close_check\` som letar efter stopp (okonterade rader, ej godkända leverantörsfakturor, saknade kvitton på utgifter över 4 000 kr, vilket är verktygets tröskel för väsentliga belopp; BFL kräver underlag för varje affärshändelse oavsett belopp) och rapporterar \`ready_to_close\`.

## Tiominuterstestet

En snabb genomgång som visar att anslutningen fungerar innan du släpper in den på skarp data. Kör stegen i ordning. Varje steg säger vad du gör och vad du ska se.

1. **Anslut.** Väg A med bara läsrättigheter, väg B, eller väg C med en \`gnubok_sk_test_*\`-nyckel. → Claude listar Accounteds verktyg (rubriker som *List Uncategorized Transactions* och *VAT Declaration (Momsdeklaration)*).
2. **Kontrollera bolaget.** Fråga *"Vilket bolag är jag ansluten till?"* → Claude namnger sandlådebolaget (till exempel **Sandlådan Konsult**).
3. **Kör fråga 1** (okonterade och konteringsförslag). → En lista med okonterade rader plus förslag. Ingen bokföring sker.
4. **Kör fråga 2** (förfallna fakturor). → Minst en förfallen kundfaktura med åldersfördelning.
5. **Kör fråga 3** (moms och kan jag stänga). → Momsdeklarationens rutor plus en **icke-tom lista med stopp** från \`accounted_vat_close_check\` (okonterade transaktioner, en ej godkänd leverantörsfaktura och en större utgift utan kvitto).
6. **Testa en skrivning.** Be Claude kontera en transaktion. → Claude lägger upp en pending operation och ber dig bekräfta. Bokföringen sker **inte** förrän du godkänner i chatten eller på **/pending**.

Stämmer varje steg är anslutningen rätt kopplad och godkännandemodellen på plats.

## Support

Fastnar du, eller ser ett stopp du inte förstår? Använd supportformuläret i appen under **/help**. Det går direkt till produktteamet med ditt bolag som kontext. Skriv med vilken klient du använder (claude.ai, Desktop eller Code), vilken väg du tog (A, B eller C) och verktygsnamnet från eventuellt felmeddelande.
`
