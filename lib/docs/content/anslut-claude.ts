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

**[→ Anslut Accounted till Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Accounted&connectorUrl=https%3A%2F%2Fapp.accounted.se%2Fapi%2Fextensions%2Fext%2Fmcp-server%2Fmcp%3Ftool_namespace%3Daccounted%26client%3Dclaude-connector%26auth%3Drequired)**

Länken öppnar claude.ai med namn och adress ifyllda. Du granskar värdena och godkänner; länken fyller bara i formuläret och ger ingenting i sig. Ingen API-nyckel att hålla reda på.

**Du behöver inget Accounted-konto ännu.** Inloggningen öppnas direkt när du lägger till anslutningen, och där skapar du som ny kontot på plats (BankID eller e-post + 2FA).

**Alla behörigheter förvalda, varje skrivning stannar ändå.** Godkännandesidan ger hela behörighetslistan med ett klick. Fäll ut **Behörigheter** och välj **Endast läs** för en läsande anslutning (lista fakturor, läsa rapporter, räkna moms): så kan en granskare ansluta läsande medan du själv har en anslutning med skrivrättigheter för det dagliga arbetet. Oavsett behörigheter lägger skrivverktygen (skapa faktura, kontera, bokföra verifikat, köra bokslut) bara upp en pending operation som du bekräftar innan något bokförs, och åtkomsten går att återkalla under Inställningar → API & MCP.

#### Vad som händer efter klicket

Resten av inställningarna görs på Claudes sida, i den här ordningen:

1. **Connector-dialogen.** claude.ai öppnar **Add custom connector** med namn och adress ifyllda. Kontrollera adressen och gå vidare: dialogen känner av att servern kräver inloggning (**Always required**) och att Claude kan registrera sig själv automatiskt. Behåll de valen och klicka **Add**. Claude Desktop visar samma dialog under Inställningar → Connectors.
2. **Inloggningen öppnas.** claude.ai ber dig ansluta och öppnar Accounteds inloggning (BankID eller e-post + 2FA) följd av godkännandesidan. Den visar bolaget som just nu är aktivt i appen (byt bolag i appen först om du har flera) med alla behörigheter förvalda; fäll ut **Behörigheter** och välj **Endast läs** för en läsande anslutning. Godkänn, så visas anslutningen som ansluten med Accounteds verktyg listade.
3. **Ställ din första fråga.** Till exempel *"Vilket bolag är jag ansluten till?"*. Härifrån går varje fråga mot det bolaget, och skrivningar stannar under **/pending** tills du bekräftar.

Inloggad, men Claude säger fortfarande att servern inte går att nå? Fråga igen i samma chatt först. Hjälper inte det: öppna Inställningar → Connectors, ta bort anslutningen och lägg till den igen via länken ovan, med autentisering kvar på **Always required**.

#### Lägga till manuellt i stället

I **claude.ai** (Inställningar → Connectors) eller **Claude Desktop** (Inställningar → Connectors → Add custom connector), välj **Add custom connector** och klistra in:

\`\`\`
https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=claude-connector&auth=required
\`\`\`

Behåll alla tre parametrarna. \`tool_namespace=accounted\` väljer verktygsnamnen som guiden utgår från. \`auth=required\` gör att dialogen känner av inloggningen (**Always required**): utan den accepterar servern en anonym handskakning, dialogen föreslår **None**, och en anslutning som läggs till med det förvalet öppnar aldrig inloggningen. Lägger du ändå till adressen utan parametern, välj **Required when the server asks** själv. \`client=claude-connector\` är bara statistik.

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
claude mcp add --transport http accounted \\
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

Alla tre går mot den deterministiska sandlådan (använd en \`gnubok_sk_test_*\`-nyckel, eller gör sandlådebolaget aktivt i appen innan du loggar in från Claude). De går igenom hela läsvägen utan att bokföra något.

1. **"Visa mina okonterade banktransaktioner och föreslå konteringar."**
   Claude kallar \`accounted_list_uncategorized_transactions\` och sedan \`accounted_suggest_categories\` och går igenom förslagen med dig. Godkänner du ett förslag läggs en \`accounted_categorize_transaction\` upp som pending operation. Ingenting bokförs förrän du bekräftar.
2. **"Vilka fakturor är förfallna?"**
   Claude kallar \`accounted_get_ar_ledger\` (kundreskontra) och listar utestående kundfakturor med åldersfördelning.
3. **"Räkna fram momsen för det här kvartalet och säg om jag kan stänga."**
   Claude kallar \`accounted_get_vat_report\` för momsdeklarationens rutor och sedan \`accounted_vat_close_check\` som letar efter stopp (okonterade rader, ej godkända leverantörsfakturor, saknade kvitton på utgifter över 4 000 kr, vilket är verktygets tröskel för väsentliga belopp; BFL kräver underlag för varje affärshändelse oavsett belopp) och rapporterar \`ready_to_close\`.

## Tiominuterstestet

En snabb genomgång som visar att anslutningen fungerar innan du släpper in den på skarp data. Kör stegen i ordning. Varje steg säger vad du gör och vad du ska se.

1. **Anslut.** Väg A med **Endast läs** valt på godkännandesidan, väg B, eller väg C med en \`gnubok_sk_test_*\`-nyckel. → Claude listar Accounteds verktyg (rubriker som *List Uncategorized Transactions* och *VAT Declaration (Momsdeklaration)*).
2. **Kontrollera bolaget.** Fråga *"Vilket bolag är jag ansluten till?"* → Claude namnger sandlådebolaget (till exempel **Sandlådan Konsult**).
3. **Kör fråga 1** (okonterade och konteringsförslag). → En lista med okonterade rader plus förslag. Ingen bokföring sker.
4. **Kör fråga 2** (förfallna fakturor). → Minst en förfallen kundfaktura med åldersfördelning.
5. **Kör fråga 3** (moms och kan jag stänga). → Momsdeklarationens rutor plus en **icke-tom lista med stopp** från \`accounted_vat_close_check\` (okonterade transaktioner, en ej godkänd leverantörsfaktura och en större utgift utan kvitto).
6. **Testa en skrivning.** Be Claude kontera en transaktion. → Claude lägger upp en pending operation och ber dig bekräfta. Bokföringen sker **inte** förrän du godkänner i chatten eller på **/pending**.

Stämmer varje steg är anslutningen rätt kopplad och godkännandemodellen på plats.

## Support

Fastnar du, eller ser ett stopp du inte förstår? Använd supportformuläret i appen under **/help**. Det går direkt till produktteamet med ditt bolag som kontext. Skriv med vilken klient du använder (claude.ai, Desktop eller Code), vilken väg du tog (A, B eller C) och verktygsnamnet från eventuellt felmeddelande.
`
