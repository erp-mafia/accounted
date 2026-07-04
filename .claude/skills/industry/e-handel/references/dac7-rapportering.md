# DAC7: plattformsoperatörers rapporteringsskyldighet

## Lagstöd

- **Direktiv (EU) 2021/514** (DAC7), ikraft 2023-01-01.
- **Lag (2022:1681)** om plattformsoperatörers inhämtande av vissa uppgifter på skatteområdet (POL).
- **Lag (2022:1682)** om automatiskt utbyte av upplysningar om inkomster genom digitala plattformar.
- **Förordning (2022:1692)** och **förordning (2022:1693)**.
- **22 c kap. skatteförfarandelagen (2011:1244)**.

## Vem omfattas

**Rapporteringsskyldig plattformsoperatör**: operatör som driver eller utvecklar mjukvara som låter "säljare" ansluta sig till andra användare för att utföra "berörda aktiviteter" mot ersättning.

**Etableringskoppling**:
- Skatterättsligt hemvist i Sverige, eller
- Registrerad i Sverige, eller
- Plats för faktisk företagsledning i Sverige, eller
- Fast driftställe i Sverige (utan att vara kvalificerad i annan EU-stat).

Icke-EU-operatörer kan rapportera frivilligt till en vald EU-stat.

## Berörda aktiviteter

1. **Uthyrning av fast egendom** (boende, parkeringsplatser, kommersiella lokaler).
2. **Personliga tjänster** (tid-/uppgiftsbaserade tjänster, fysiska eller virtuella).
3. **Försäljning av varor**.
4. **Uthyrning av transportmedel**.

E-handelsrelevans: punkt 3 (varuförsäljning via marketplace).

## Vilka plattformar berörs i e-handelskontexten

- Tradera, Blocket Marketplace, Sellpy → varuförsäljning.
- Amazon, eBay, Etsy, CDON Marketplace, Fyndiq, Tictail-typ-aktörer.
- TikTok Shop, Temu, om de når DAC7-anknytning.
- Egen Shopify-butik som **endast** säljer egna varor → INTE rapporteringsskyldig (operatören är inte en plattform i DAC7:s mening).
- Shopify som tjänsteleverantör → INTE rapporteringsskyldig på den nivån (det är butiksägaren som är säljare).

## Säljarundantag: varor

Säljare av varor undantas från rapportering om **båda** villkoren är uppfyllda under kalenderåret:
- **Färre än 30 berörda transaktioner**, OCH
- **Total ersättning högst 2 000 EUR**.

Om en av tröskelvärdena passeras → hela årets transaktioner rapporteras.

## Datum

- Lagen ikraft **2023-01-01**.
- Första rapportering avseende rapporteringspliktiga aktiviteter 2023 → **2024-01-31**.
- Plattformen rapporterar årligen via Skatteverkets e-tjänst med specifika XML-schemas (motsvarar EU:s gemensamma format).

## Kundkännedom (POL 4 kap.)

Plattformen ska samla in och verifiera:
- För fysisk säljare: namn, primär adress, skatteregistreringsnummer (TIN) eller motsvarande, födelsedatum.
- För juridisk säljare: officiellt namn, primär adress, TIN, momsregistreringsnummer, registreringsnummer i bolagsregister.
- Vid uthyrning fast egendom: även adress för varje rapporterad fastighet.

Verifiering ska ske med rimliga åtgärder, t.ex. mot offentliga register, samt revideras vid förändringar.

## Rapporterade data per säljare (sammanfattning)

- Identifierande uppgifter (namn, adress, TIN, momsregnr).
- Totalt ersättningsbelopp per kvartal och per typ av aktivitet.
- Antal aktiviteter per kvartal.
- Avgifter, provisioner och skatter som plattformen tagit ut/innehållit.
- För fast egendom: adress, antal hyresdagar.
- Finansiellt konto för utbetalning.

## Sanktioner

- Plattformsavgift **2 500-12 500 kr** per säljare där rapportering är felaktig eller utebliven.
- Föreläggande och vite enligt skatteförfarandelagen kan tillkomma.

## Dokumentationsbevarande

- **7 år** efter utgången av rapporteringsperioden (POL 6 kap. 14 §).

## Konsekvenser för e-handelsklienter

### Säljare via marketplace
- **Kontrolluppgifter KU90 (varuförsäljning) finns inte i DAC7-systemet**: DAC7-rapporten är ett eget format som plattformen lämnar direkt. Säljaren får inte alltid en kopia; rekommendation är att begära den årligen från plattformen för avstämning mot egen bokföring.
- Skatteverket kan jämföra rapporterad omsättning med säljarens egen deklaration. Diskrepans triggar revision.
- DAC7-omsättning är inte automatiskt momspliktig svensk omsättning: det kan vara deemed supplier-fall där plattformen är momsskyldig. Skatteverket har båda underlagen för korsavstämning.

### Säljare som driver egen plattform
- Marketplace-operatörer (Tradera, Blocket Marketplace) → fullständig DAC7-rapportering, kräver KYC-process och teknisk integration mot Skatteverkets API.
- Egen Shopify-butik som **endast** säljer egna varor → undantagen.
- Hybrider (egen butik + tredjepartssäljare som listar via plattformen) → typiskt rapporteringsskyldig.

### GDPR-samspel
- Säljarens personuppgifter samlas in baserat på **rättslig förpliktelse** (art. 6.1 c GDPR): DAC7 är lagstadgad skyldighet.
- Rätt till radering enligt GDPR begränsas under 7-årsperioden.
- Plattformen ska informera säljarna om rapporteringen (transparenskrav GDPR art. 13-14).
