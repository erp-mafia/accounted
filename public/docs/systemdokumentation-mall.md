# Systemdokumentation

**Mall för användare av Accounted**
Upprättad i enlighet med 5 kap. 11 § BFL och BFNAR 2013:2

---

## Instruktioner

Varje bokföringsskyldig ska upprätta en systemdokumentation som beskriver bokföringssystemets organisation och uppbyggnad. Dokumentationen ska göra det möjligt att utan svårighet överblicka systemet och förstå hur bokföringen är organiserad.

Denna mall är förifylld med uppgifter som gäller för Accounted. Avsnitt markerade med hakparenteser ska anpassas till ditt företags förhållanden. Radera denna instruktionssektion innan du arkiverar dokumentet.

Accounted tar också fram en systemdokumentation för just ditt företag, med aktuell kontoplan, verifikationsserier, detaljerade behandlingsregler och programversion. Den finns i filen `revision/systemdokumentation.json` i **Importera/Exportera > Exportera > Komplett arkiv**. Denna mall kompletterar den med företagets egna rutiner.

Systemdokumentationen ska bevaras lika länge som den räkenskapsinformation den avser: till och med det sjunde året efter utgången av det kalenderår då räkenskapsåret avslutades (7 kap. 2 § BFL).

---

## 1. Företagsuppgifter

| Fält | Uppgift |
|---|---|
| Företagsnamn | [FÖRETAGSNAMN] |
| Organisationsnummer | [ORG-NR] |
| Företagsform | [ ] Enskild firma  [ ] Aktiebolag |
| Räkenskapsår | [STARTMÅNAD] - [SLUTMÅNAD] |
| Tillämpat regelverk | [ ] K1, förenklat årsbokslut (BFNAR 2006:1; enskild firma med nettoomsättning normalt högst 3 miljoner kronor)  [ ] K2 årsbokslut (BFNAR 2017:3)  [ ] K2 årsredovisning (BFNAR 2016:10)  [ ] K3 (BFNAR 2012:1) |

## 2. Bokföringsprogram

| Fält | Uppgift |
|---|---|
| Programnamn | Accounted |
| Version | [ANGE VERSION ELLER DATUM FÖR SENASTE KONTROLL] |
| Leverantör | [BOLAGSNAMN], org.nr [ORG-NR] |
| Webbplats | [DOMÄN, för den molnbaserade tjänsten app.accounted.se] |
| Typ | [ ] Molnbaserad SaaS-tjänst (webbläsarbaserad)  [ ] Egen drift (självhostad) |
| Databasplattform | PostgreSQL via Supabase (den molnbaserade tjänsten: AWS, Stockholm) |
| Autentisering | E-post och lösenord. I den molnbaserade tjänsten krävs dessutom en andra faktor vid inloggning: engångskod från en autentiseringsapp (TOTP) eller BankID. Leverantören kan i undantagsfall ge ett tidsbegränsat undantag. Åtkomst via API-nyckel beskrivs i avsnitt 12. |

*Vid egen drift: ange var databasen driftas och vem som ansvarar för drift och säkerhetskopiering.*

## 3. Kontoplan (BFNAR 2013:2 punkt 9.2 a, 9.3)

3.1. Kontoplanen bygger på BAS-kontoplanen (BAS 2026) utgiven av BAS-intressenternas Förening.

3.2. Kontona är indelade i klasser enligt BAS-standard:

| Klass | Beskrivning | Exempel på konton |
|---|---|---|
| 1 | Tillgångar | 1510 Kundfordringar, 1930 Företagskonto |
| 2 | Eget kapital och skulder | 2013 Egna uttag (EF), 2440 Leverantörsskulder, 2611-2631 Utgående moms, 2641 Ingående moms |
| 3 | Intäkter | 3001 Försäljning 25%, 3002 Försäljning 12%, 3003 Försäljning 6%, 3305 Försäljning tjänster utanför EU |
| 4-7 | Kostnader | Konfigureras efter verksamhet |
| 8 | Finansiella poster och skatt | Konfigureras efter verksamhet |

3.3. Kontoplanen visas under **Bokföring > Kontoplan**. Den exporteras som en del av SIE-filen (**Importera/Exportera > Exportera > SIE 4**) och av **Komplett arkiv**.

3.4. Företagsspecifika anpassningar av kontoplanen:
[BESKRIV EVENTUELLA TILLAGDA ELLER BORTTAGNA KONTON, t.ex. "Konto 4010 Inköp varor, 5010 Lokalhyra har lagts till. Inga standardkonton har tagits bort."]

3.5. Vid SIE-import bevaras oanvända kontodefinitioner i klass 9. Oanvända konton under 1000 är det tidigare programmets interna konton och tas inte med. Konton med belopp måste mappas till konton 1000-8999 innan importen startas, eftersom Accounteds rapporter bara omfattar klass 1-8; för konton i klass 9 med belopp föreslås 2999 OBS-konto. Källfil och kontomappningar bevaras i importarkivet.

## 4. Samlingsplan (BFNAR 2013:2 punkt 9.2 c, 9.4, 9.11)

Samlingsplanen beskriver hur bokföringen är organiserad i form av delsystem, grundbokföring och huvudbokföring.

### 4.1 Översikt

```
Affärshändelse
    |
    v
Verifikation skapas (manuellt eller automatiskt)
    |
    v
Journalpost registreras (grundbokföring, registreringsordning)
    |
    v
Konteras på BAS-konton (huvudbokföring, systematisk ordning)
    |
    v
Status: Utkast (draft)
    |
    v
Bekräftas av användaren
    |
    v
Status: Bokförd (posted), verifikationsnummer tilldelas
```

### 4.2 Grundbokföring (registreringsordning)

Samtliga affärshändelser registreras kronologiskt i journalen. Varje post innehåller:
- Verifikationsnummer (i löpande följd, tilldelat automatiskt vid bokföring)
- Registreringsdatum (datum då posten skapades i systemet)
- Bokföringsdatum (datum för affärshändelsen)
- Beskrivning
- Konteringsrader med konto, debet, kredit

Grundbokföringen visas under **Bokföring > Verifikationer** och tas ut under **Rapporter > Huvudböcker > Grundbok** (skärm och Excel).

### 4.3 Huvudbokföring (systematisk ordning)

Huvudbokföringen presenterar affärshändelserna sorterade per konto. Varje konto visar ingående saldo, periodens transaktioner och utgående saldo.

Huvudbokföringen tas ut under **Rapporter > Huvudböcker > Huvudbok** (skärm och Excel).

### 4.4 Delsystem

Följande delsystem matar journalen:

| Delsystem | Beskrivning | Automatisk kontering |
|---|---|---|
| Kundfakturering | Utgående fakturor med momssats per rad, även e-faktura via Peppol | Debet 1510, kredit 30xx + 26xx |
| Kundbetalningar | Inbetalningar mot fakturor | Debet 1930 (eller annat likvidkonto), kredit 1510 |
| Leverantörsfakturor | Inkommande fakturor, även e-faktura via Peppol, registrering och betalning | Debet kostnadskonto + 2641, kredit 2440 |
| Leverantörsbetalningar | Utbetalningar mot leverantörsfakturor | Debet 2440, kredit 1930 |
| Banktransaktioner | Synkroniserade via PSD2 (Enable Banking) eller importerade bankfiler | Kontering via kategoriseringsregler och konteringsmallar |
| Kvitto- och underlagshantering | Uppladdade, inmejlade eller via WhatsApp inskickade underlag, maskinellt avlästa | Kontering efter granskning |
| Kreditnotor | Kreditering av utgående och inkommande fakturor | Omvänd kontering av originalfaktura |
| Löner | Lönekörningar, arbetsgivardeklaration (AGI) | Debet 7xxx + 7510, kredit 2710/2731/1930; semesterlöneskuld 2920/2940 |
| Anläggningstillgångar | Anläggningsregister med årliga avskrivningar | Debet 78xx, kredit ackumulerade avskrivningar (t.ex. 1219, 1229) |
| Periodiseringar | Periodiseringsscheman över flera perioder | Debet/kredit 17xx respektive 29xx |
| Kortbetalningar (Stripe) | Betalning av kundfaktura via betallänk och utbetalning till bankkontot | Betalning: debet 1686, kredit 1510. Utbetalning: debet 1930 och 6570 (avgift), kredit 1686, samt omvänd moms på avgiften |
| Webbutiker (Shopify, WooCommerce, Zettle) | Order och återbetalningar hämtas som underlag | Kontering när användaren bokför ordern |

[STRYK DE DELSYSTEM SOM INTE ANVÄNDS I DITT FÖRETAG]

**Öresavrundning på leverantörsfakturor.** Användaren väljer avrundning när den finns på leverantörens faktura. Avrundningen bokförs som en egen rad på konto 3740 utan moms och ändrar inte momsbeloppet. Vid betalning enligt kontantmetoden bokförs en skillnad under 1 krona mellan fakturabeloppet och det belopp som lämnade banken på 3740; en avvikelse på 1 krona eller mer godtas inte som slutbetalning.

De fullständiga behandlingsreglerna finns i den genererade systemdokumentationen (`revision/systemdokumentation.json` i **Komplett arkiv**). Ändringar av behandlingsregler och nya programversioner registreras med datum i behandlingshistoriken (avsnitt 9).

### 4.5 Dimensioner

[OM KOSTNADSSTÄLLEN ELLER PROJEKT ANVÄNDS: konteringsrader kan märkas med dimensionsvärden för uppföljning per kostnadsställe eller projekt. Dimensionerna påverkar inte huvudbokföringens saldon. Visas under **Bokföring > Kostnadsställen & projekt** när dimensioner har slagits på under **Inställningar > Bokföring > Allmänt**. STRYK DETTA AVSNITT OM DIMENSIONER INTE ANVÄNDS.]

### 4.6 Avstämningsordning

Bankkonton stäms av under **Konton > Avstämning** (matchning på belopp och datum, referens, datumintervall och sannolikhet). Förslag med mycket hög säkerhet kopplas automatiskt mot redan bokförda verifikationer; inga nya verifikationer skapas då.

## 5. Verifikationer

### 5.1 Verifikationsnumrering (BFNAR 2013:2 punkt 9.6)

Verifikationsnummer tilldelas i löpande följd av systemet vid bokföring. Numreringen är unik per företag, räkenskapsår och verifikationsserie. Numren tilldelas av en databasfunktion som är säker vid samtidiga anrop och kan inte sättas manuellt.

Systemet stödjer flera verifikationsserier. Företag som skapats från och med den 6 september 2026 får standarduppsättningen: A manuella verifikationer, banktransaktioner och övrigt, B kundfakturor, C inbetalningar från kunder, D leverantörsfakturor, E utbetalningar till leverantörer, H periodiseringar, I bokslut, K lön, L kontantfakturor och webbutiksorder samt M momsredovisning. Äldre företag har alla verifikationer i serie A om inget annat valts.

Standardserie per verifikattyp ställs in under **Inställningar > Bokföring > Allmänt**, där standarduppsättningen också kan väljas i efterhand. Ett bankkonto kan ha en egen serie för verifikationer som skapas från dess transaktioner, och serien kan ändras för ett enskilt verifikat när det bokförs. Ett byte gäller nya verifikationer, görs lämpligen vid ett räkenskapsårs början och registreras i behandlingshistoriken.

Verifikationsserier som används i detta företag och från vilket datum de gäller: [ANGE, t.ex. "Serie A för all bokföring från 2025-01-01" eller "Standarduppsättningen från 2027-01-01, dessförinnan endast serie A"]

Om ett verifikationsnummer saknas i en serie ska luckan förklaras. Systemet har en funktion för att registrera förklaringar till nummerluckor, och förklaringarna bevaras som en del av räkenskapsinformationen.

### 5.2 Verifikationens innehåll

Varje verifikation innehåller:
- Verifikationsnummer
- Bokföringsdatum (affärshändelsens datum)
- Registreringsdatum (datum då posten skapades)
- Beskrivning av affärshändelsen
- Konteringsrader (konto, debet, kredit)
- Referens till underlag (bifogat dokument, fakturanummer, etc.)
- Status (utkast, bokförd eller omförd; ett utkast som inte bokförs makuleras men raderas aldrig)
- Vid rättelse: referens till omförd eller omförande verifikation, alternativt rättelselogg för rättelse i samma verifikat

### 5.3 Underlag

Underlag kopplas till verifikationer som bifogade dokument (PDF, bild, e-faktura). Dokumenten lagras i dokumentarkivet med SHA-256 checksumma för integritetskontroll.

Typer av underlag:
- Kundfakturor (genererade i systemet)
- Leverantörsfakturor (uppladdade, inmejlade eller mottagna via Peppol)
- Kvitton (fotograferade/skannade)
- Bankbekräftelser (synkroniserade)
- Löneunderlag och lönespecifikationer
- Övriga avtal och dokument (uppladdade)

Dokument som är kopplade till bokförda eller omförda verifikationer kan inte raderas, eftersom de omfattas av arkiveringsskyldigheten.

## 6. Rättelser (BFL 5 kap. 5 §)

6.1. Bokförda verifikationer kan inte tyst ändras eller raderas. Detta upprätthålls av databastriggrar i enlighet med bokföringslagens krav på varaktighet.

6.2. Systemet stödjer två rättelsevägar, båda med bevarad ursprungsinformation:

**a) Stornobokning (särskild rättelsepost).** En ny verifikation skapas som omför den felaktiga posten (byter debet och kredit). Den nya verifikationen länkas till originalet, och originalet visar vilken rättelsepost som har omfört det. Därefter skapas en ny korrekt verifikation vid behov. Denna väg är alltid tillåten.

**b) Rättelse i samma verifikat.** Felaktiga uppgifter eller konteringsrader stryks och ersätts inom samma verifikat. Den ursprungliga uppgiften förblir läsbar, och vem som gjorde rättelsen och när loggas oföränderligt i en separat rättelselogg. Denna väg är endast tillåten så länge perioden är öppen och olåst.

6.3. Rättelse i samma verifikat spärras av systemet när räkenskapsåret är stängt eller låst och för verifikationer daterade till och med företagets låsdatum; där är stornobokning den enda vägen. Samma spärr gäller stornoposter, rader i utländsk valuta, rader med kopplat underlag och rader som hör till en banktransaktion eller betalning. Systemet kontrollerar inte om en deklaration har lämnats för perioden. Sätt därför låsdatum när en period har deklarerats (avsnitt 7.2), så att endast stornobokning återstår.

6.4. Rättelsen innehåller alltid uppgift om vilken verifikation som rättats, när rättelsen gjordes, och vem som utförde den.

## 7. Periodavstängning och låsning

7.1. Räkenskapsår kan stängas och låsas. I ett låst räkenskapsår kan inga nya bokföringsposter göras. Låsningen upprätthålls av databastriggrar, inte enbart av gränssnittet.

7.2. Utöver låsning av hela räkenskapsår kan ett låsdatum sättas för företaget, t.ex. efter varje momsperiod. Ingen bokföring kan ske på datum till och med låsdatumet. Ställs in under **Inställningar > Bokföring > Allmänt** (Periodlåsning).

7.3. Årsbokslut registreras som bokföringsposter i systemet.

7.4. Ansvarig för att stänga och låsa perioder: [NAMN]

## 8. Momshantering

8.1. Följande momssatser hanteras:

| Momssats | Beskrivning | Utgående moms-konto | Ingående moms-konto |
|---|---|---|---|
| 25 % | Standardsats | 2611 | 2641 |
| 12 % | Reducerad (restaurang och servering, hotell m.m.) | 2621 | 2641 |
| 6 % | Reducerad (livsmedel tillfälligt, böcker, tidningar, persontransport, kultur m.m.) | 2631 | 2641 |
| 0 % | Export av varor utanför EU (3105) och försäljning av tjänster till företag i andra länder när tjänsten enligt reglerna om beskattningsland beskattas utomlands (3305 utanför EU, 3308 inom EU) | - | - |
| Omvänd skattskyldighet vid inköp | Tjänster från EU och från länder utanför EU, inrikes omvänd skattskyldighet (t.ex. byggtjänster) | 2614 / 2624 / 2634 (beräknad utgående moms 25 / 12 / 6 %) | 2645 (utland), 2647 (inrikes) |
| Momsfri | Undantagna transaktioner | - | - |

*Notering: Livsmedel har tillfälligt 6 % moms under perioden 1 april 2026 till och med 31 december 2027. Restaurang- och serveringstjänster ligger kvar på 12 %. Momssatsen väljs per rad och byts inte automatiskt efter datum.*

8.2. Fakturor stödjer blandade momssatser (per fakturarad). Förvärv av varor från andra EU-länder och importmoms skapas inte automatiskt från leverantörsfakturor; de bokförs med manuell verifikation på respektive konto (t.ex. 4515-4517, 2615) och tas med i momsdeklarationen.

8.3. Momsdeklarationen tas fram under **Skatt > Moms** och mappas till Skatteverkets rutor.

8.4. Redovisningsmetod: [ ] Faktureringsmetod  [ ] Kontantmetod
Momsperiod: [ ] Månad  [ ] Kvartal  [ ] Helår

## 9. Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 punkt 9.15-9.16)

9.1. Systemet registrerar automatiskt en behandlingshistorik som inkluderar:
- Registreringsdatum och tidpunkt för varje journalpost
- Tidpunkt för statusändring (utkast till bokförd)
- Vem som utförde bokningen och på vilket sätt (användare, eller API-nyckel vid maskinell bokföring)
- Stornobokningar med referens till originalverifikation
- Rättelser i samma verifikat, med ursprungsvärde, nytt värde, tidpunkt och utförare
- Tidpunkt och utförare av låsning och upplåsning
- Ändringar i kontoplan, inställningar som styr bokföringen, räkenskapsår, API-nycklar och åtkomst
- Importer och maskinella körningar
- Programversioner med datum

9.2. Behandlingshistoriken genereras automatiskt av systemet och kan inte ändras av användaren.

9.3. Behandlingshistoriken tas fram under **Rapporter > Export & arkiv > Behandlingshistorik** per räkenskapsår eller datumintervall och kan laddas ner som PDF, CSV eller Excel. Den ingår även i **Importera/Exportera > Exportera > Komplett arkiv**: ZIP-filen innehåller `revision/behandlingshistorik.json` (alla ändringar) och `revision/systemdokumentation.json` (kontoplan, verifikationsserier, behandlingsregler, arkiveringsprinciper, programversion), utöver SIE-filer, rapporter och underlag.

## 10. Import och export

| Funktion | Format | Beskrivning |
|---|---|---|
| SIE-import | SIE typ 1-4 | Import av bokföringsdata från annat system |
| Bankfil-import | CSV, camt.053 (ISO 20022) och format från flera svenska banker | Import av banktransaktioner |
| SIE-export | SIE 4 | Export av komplett bokföring per räkenskapsår |
| Komplett arkiv | ZIP | SIE-filer, rapporter, underlag och behandlingshistorik; med omfattningen Hela historiken även register och originalfiler från SIE-importer |
| Grundbok och huvudbok | Skärm, Excel | Grund- och huvudbokföring |
| Resultat- och balansräkning | Skärm, PDF, Excel | Resultat- och balansräkning |
| Momsdeklaration | Skärm, Excel, PDF och XML för manuell inlämning | Underlag för momsdeklaration |
| Periodisk sammanställning | Skärm, CSV (SKV 5740) | EU-försäljning av varor och tjänster |
| INK2 och NE-bilaga | Skärm, SRU | Inkomstdeklaration för aktiebolag (INK2) och enskild firma (NE) |
| Årsredovisning | Skärm, PDF, iXBRL | Årsredovisning för aktiebolag, iXBRL för digital inlämning |
| Verifikationsunderlag | Originalfil (PDF, bild, e-faktura) | Nedladdning av bifogade dokument |

## 11. Integrationer

| Integration | Beskrivning | Dataflöde |
|---|---|---|
| Enable Banking (PSD2) | Bankkontosynkronisering | Bank -> Accounted (läsning av transaktioner och saldon) |
| Skatteverket | Momsdeklaration, arbetsgivardeklaration (AGI), skattekonto | Accounted <-> Skatteverket (inlämning signeras med BankID) |
| Peppol (accesspunkt Qvalia) | E-fakturor in och ut | Leverantör -> Accounted, Accounted -> kund |
| Amazon Bedrock (AWS) | Maskinell kategorisering av transaktioner och avläsning av underlag, med Anthropics Claude-modeller körda inom Bedrock i EU | Accounted -> Amazon Bedrock -> Accounted (transaktions- och dokumentdata skickas, förslag returneras; datan lämnar inte EU) |
| Resend | E-post ut (fakturor, påminnelser) och in (inmejlade underlag till dokumentinkorgen) | Accounted <-> Resend (USA) |
| WhatsApp (Meta) | Kvitton och underlag som skickas via WhatsApp | Användare -> Meta -> Accounted |
| BankID och bolagsuppgifter (TIC) | Inloggning med BankID och uppslag av företagsuppgifter | Accounted <-> TIC |
| Stripe | Betallänkar på kundfakturor, betalningar och utbetalningar | Stripe -> Accounted |
| Shopify, WooCommerce, Zettle | Order och återbetalningar som underlag | Webbutik -> Accounted |
| Molnsynkronisering (Google Drive, Dropbox) | Kopia av Komplett arkiv i företagets egen molnlagring | Accounted -> företagets molnlagring |
| Migrering (Fortnox, Visma eEkonomi, Bokio, Briox, Björn Lundén, Wint) | Hämtning av bokföring från tidigare program | Tidigare program -> Accounted |
| Riksbanken | Valutakurser för belopp i utländsk valuta | Riksbanken -> Accounted |
| AI-assistenter (API och MCP) | Externa assistenter med API-nyckel, se avsnitt 12 | Assistent <-> Accounted |
| PostHog | Användningsstatistik för tjänsten | Accounted -> PostHog |

[STRYK DE INTEGRATIONER SOM INTE ANVÄNDS I DITT FÖRETAG]

[SJÄLVHOSTAD DRIFT: raden för Amazon Bedrock ovan beskriver den hostade tjänstens standardkonfiguration. Om din installation använder en annan AI-leverantör (t.ex. AI_PROVIDER=anthropic med direkt Anthropic-API, eller en egen endpoint via AI_BASE_URL) gäller inte skrivningen "datan lämnar inte EU" automatiskt; uppdatera raden så att den beskriver din faktiska leverantör, region och ditt faktiska dataflöde]

**Maskinell och automatisk bokföring.** Förslag från maskinella hjälpmedel (kategorisering av banktransaktioner, avläsning av underlag) bokförs först när en användare har godkänt dem, i granskningsdialogen eller med ett klick. Följande kan skapa bokförda verifikationer utan att en användare godkänner varje verifikation, när funktionen har slagits på:
- Stripe: betalningar via betallänk och utbetalningar som stämmer exakt
- Periodiseringar: schemalagda delposter bokförs på förfallodagen
- Återkommande fakturor med automatiskt utskick
- API-nycklar och AI-assistenter med skrivbehörighet (avsnitt 12)

Varje verifikation registreras i behandlingshistoriken med tidpunkt, sätt och utförare.

## 12. API-nycklar och maskinell åtkomst

12.1. Externa system och AI-assistenter kan ges åtkomst till bokföringen via API-nycklar. Nycklarna skapas och återkallas under **Inställningar > AI och kopplingar > API och MCP**.

12.2. Varje nyckel har avgränsade behörigheter (scopes), t.ex. enbart läsning av rapporter eller skrivning av transaktioner. En nyckel kan aldrig göra mer än sina tilldelade behörigheter.

12.3. En nyckel med skrivbehörighet för bokföring kan bokföra direkt. Om nyckeln har ett beloppstak för bokföring utan mänsklig granskning lämnas verifikationer över taket kvar som utkast för en användare att bokföra. En nyckel som både får förbereda och godkänna bokföring kan godkänna sina egna verifikationer utan mänsklig granskning; systemet varnar när en sådan nyckel skapas.

12.4. Åtgärder som utförs via API-nyckel loggas i behandlingshistoriken med nyckeln som utförare.

12.5. Utfärdade API-nycklar och deras behörigheter:

| Nyckelns namn | Syfte | Behörigheter | Utfärdad |
|---|---|---|---|
| [NAMN] | [T.EX. BOKFÖRINGSBYRÅNS ASSISTENT] | [SCOPES] | [DATUM] |

[STRYK DETTA AVSNITT OM INGA API-NYCKLAR ANVÄNDS]

## 13. Behörigheter och åtkomstkontroll

13.1. All data är knuten till ett företag och isolerad via Row Level Security (RLS) i databasen. En användare kommer enbart åt data för de företag hen är medlem i.

13.2. Behörighetsstruktur:

| Roll | Beskrivning |
|---|---|
| Ägare (owner) | Full åtkomst, kan hantera medlemmar och äganderätt |
| Administratör (admin) | Full åtkomst till bokföring och inställningar, begränsad medlemshantering |
| Medlem (member) | Arbetar i bokföringen |
| Läsare (viewer) | Endast läsåtkomst |

13.3. Företag kan grupperas så att en bokföringsbyrå eller konsult får åtkomst till flera företag. [BESKRIV OM EXTERN BYRÅ HAR ÅTKOMST, OCH I SÅ FALL VILKEN.]

13.4. I den molnbaserade tjänsten krävs en andra faktor (TOTP-kod eller BankID) vid inloggning. Åtkomst via API-nyckel sker utan inloggning och begränsas av nyckelns behörigheter (avsnitt 12).

13.5. Personer med åtkomst till bokföringen:

| Namn | Roll | Tilldelad |
|---|---|---|
| [NAMN] | [ROLL] | [DATUM] |

13.6. Ansvarig för att tilldela och granska behörigheter: [NAMN]

## 14. Säkerhetskopiering och arkivering (BFNAR 2013:2 punkt 8.2, 8.3, 9.2 d, 9.12)

14.1. I den molnbaserade tjänsten lagras räkenskapsinformationen i Sverige (AWS, Stockholm). Den bevaras till och med det sjunde året efter utgången av det kalenderår då räkenskapsåret avslutades (7 kap. 2 § BFL).

14.2. Utöver leverantörens lagring bör företaget själv ta ut en egen kopia och förvara den åtskild från originalet. Detta görs under **Importera/Exportera > Exportera > Komplett arkiv** (ägare och administratörer). Med tillägget Molnsynkronisering kan kopian laddas upp till Google Drive eller Dropbox. Om kopian förvaras utanför Sverige gäller villkoren i 7 kap. 3 a § BFL, se arkivplanen.

14.3. Företagets rutin för egen säkerhetskopiering: [BESKRIV HUR OFTA OCH VAR KOPIAN FÖRVARAS, t.ex. "En gång per kvartal samt vid varje bokslut. Förvaras krypterad på extern disk."]

14.4. Räkenskapsinformationen kan tas fram i vanlig läsbar form och skrivas ut: rapporter som PDF eller Excel, verifikationer på skärm och underlag som originalfiler (avsnitt 10).

14.5. Se även företagets arkivplan, som beskriver var räkenskapsinformationen förvaras.

## 15. Uppdatering av systemdokumentationen

Systemdokumentationen ska uppdateras vid:
- Byte eller uppgradering av bokföringsprogram
- Ändringar i kontoplan
- Ändringar i momshantering
- Nya integrationer eller delsystem
- Ändrade behörigheter eller nya API-nycklar
- Minst en gång per räkenskapsår

| Datum | Ändring | Utförd av |
|---|---|---|
| [DATUM] | Första version upprättad | [NAMN] |
| | | |

---

*Denna systemdokumentation är avsedd att uppfylla kraven i 5 kap. 11 § BFL och BFNAR 2013:2. Anpassa innehållet till ditt företags specifika förhållanden.*
