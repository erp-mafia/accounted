# Systemdokumentation

**Mall för användare av Accounted**
Upprättad i enlighet med 5 kap. 11 § BFL och BFNAR 2013:2

---

## Instruktioner

Varje bokföringsskyldig ska upprätta en systemdokumentation som beskriver bokföringssystemets organisation och uppbyggnad. Dokumentationen ska göra det möjligt att utan svårighet överblicka systemet och förstå hur bokföringen är organiserad.

Denna mall är förifylld med uppgifter som gäller för Accounted. Avsnitt markerade med hakparenteser ska anpassas till ditt företags förhållanden. Radera denna instruktionssektion innan du arkiverar dokumentet.

Systemdokumentationen ska förvaras tillsammans med övrig räkenskapsinformation under hela arkiveringsperioden (7 år).

---

## 1. Företagsuppgifter

| Fält | Uppgift |
|---|---|
| Företagsnamn | [FÖRETAGSNAMN] |
| Organisationsnummer | [ORG-NR] |
| Företagsform | [ ] Enskild firma  [ ] Aktiebolag |
| Räkenskapsår | [STARTMÅNAD] - [SLUTMÅNAD] |
| Tillämpat K-regelverk | [ ] K1 (förenklat årsbokslut, EF under 3 MSEK)  [ ] K2 (årsredovisning, mindre AB)  [ ] K3 (årsredovisning, huvudregelverk) |

## 2. Bokföringsprogram

| Fält | Uppgift |
|---|---|
| Programnamn | Accounted |
| Version | [ANGE VERSION ELLER DATUM FÖR SENASTE KONTROLL] |
| Leverantör | [BOLAGSNAMN], org.nr [ORG-NR] |
| Webbplats | [DOMÄN, för den molnbaserade tjänsten app.accounted.se] |
| Typ | [ ] Molnbaserad SaaS-tjänst (webbläsarbaserad)  [ ] Egen drift (självhostad) |
| Databasplattform | PostgreSQL via Supabase (EU-region) |
| Autentisering | E-post och lösenord. Tvåfaktorsautentisering (TOTP) krävs i den molnbaserade tjänsten. BankID kan kopplas som inloggningsmetod. |

*Vid egen drift: ange var databasen driftas och vem som ansvarar för drift och säkerhetskopiering.*

## 3. Kontoplan

3.1. Kontoplanen bygger på BAS-kontoplanen (BAS 2026) utgiven av BAS-intressenternas Förening.

3.2. Kontona är indelade i klasser enligt BAS-standard:

| Klass | Beskrivning | Exempel på konton |
|---|---|---|
| 1 | Tillgångar | 1510 Kundfordringar, 1930 Företagskonto |
| 2 | Eget kapital och skulder | 2013 Egna uttag (EF), 2440 Leverantörsskulder, 2611-2631 Utgående moms, 2641 Ingående moms |
| 3 | Intäkter | 3001 Försäljning 25%, 3002 Försäljning 12%, 3003 Försäljning 6%, 3305 Exportförsäljning |
| 4-7 | Kostnader | Konfigureras efter verksamhet |
| 8 | Finansiella poster och skatt | Konfigureras efter verksamhet |

3.3. Kontoplanen kan ses och exporteras under **Data > Kontoplan**.

3.4. Företagsspecifika anpassningar av kontoplanen:
[BESKRIV EVENTUELLA TILLAGDA ELLER BORTTAGNA KONTON, t.ex. "Konto 4010 Inköp varor, 5010 Lokalhyra har lagts till. Inga standardkonton har tagits bort."]

## 4. Samlingsplan

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
- Verifikationsnummer (sekventiellt, tilldelat automatiskt vid bokföring)
- Registreringsdatum (datum då posten skapades i systemet)
- Bokföringsdatum (datum för affärshändelsen)
- Beskrivning
- Konteringsrader med konto, debet, kredit

Grundbokföringen kan visas under **Bokföring** och exporteras under **Rapporter > Grundbok**.

### 4.3 Huvudbokföring (systematisk ordning)

Huvudbokföringen presenterar affärshändelserna sorterade per konto. Varje konto visar ingående saldo, periodens transaktioner och utgående saldo.

Huvudbokföringen kan visas och exporteras under **Rapporter > Huvudbok**.

### 4.4 Delsystem

Följande delsystem matar journalen:

| Delsystem | Beskrivning | Automatisk kontering |
|---|---|---|
| Kundfakturering | Utgående fakturor med per-rad momssats | Debet 1510, kredit 30xx + 26xx |
| Kundbetalningar | Inbetalningar mot fakturor | Debet 1930, kredit 1510 |
| Leverantörsfakturor | Inkommande fakturor, registrering och betalning | Debet kostnadskonto + 2641, kredit 2440 |
| Leverantörsbetalningar | Utbetalningar mot leverantörsfakturor | Debet 2440, kredit 1930 |
| Banktransaktioner | Synkroniserade via PSD2 (Enable Banking) eller importerade bankfiler | Kontering via kategoriseringsregler och konteringsmallar |
| Kvitto- och underlagshantering | Uppladdade eller inmejlade underlag, maskinellt avlästa | Kontering efter granskning |
| Kreditnotor | Kreditering av utgående och inkommande fakturor | Omvänd kontering av originalfaktura |
| Löner | Lönekörningar, arbetsgivardeklaration (AGI) | Debet 7xxx + 7510, kredit 2710/2730/1930 |
| Anläggningstillgångar | Anläggningsregister med årliga avskrivningar | Debet 78xx, kredit 12xx |
| Periodiseringar | Periodiseringsscheman över flera perioder | Debet/kredit 17xx respektive 29xx |

[STRYK DE DELSYSTEM SOM INTE ANVÄNDS I DITT FÖRETAG]

### 4.5 Dimensioner

[OM KOSTNADSSTÄLLEN ELLER PROJEKT ANVÄNDS: konteringsrader kan märkas med dimensionsvärden för uppföljning per kostnadsställe eller projekt. Dimensionerna påverkar inte huvudbokföringens saldon. Ses under **Data > Kostnadsställen & projekt**. STRYK DETTA AVSNITT OM DIMENSIONER INTE ANVÄNDS.]

### 4.6 Avstämningsordning

Bankkonto 1930 avstäms via bankavstämningsmodulen (flerstegs matchning: exakt belopp och datum, referensmatchning, datumintervall, sannolikhetsmatchning). Avstämningsstatus visas under **Rapporter > Bankavstämning**.

## 5. Verifikationer

### 5.1 Verifikationsnumrering

Verifikationsnummer tilldelas sekventiellt av systemet vid bokföring. Numreringen är unik per företag, räkenskapsår och verifikationsserie. Numren tilldelas via en databasfunktion som är säker vid samtidiga anrop och kan inte sättas manuellt.

Systemet stödjer flera verifikationsserier. Standardserien är A. Vilken serie som används kan styras per underlagstyp (t.ex. egen serie för löner) under **Inställningar > Bokföring**.

Verifikationsserier som används i detta företag: [ANGE, t.ex. "Endast serie A" eller "A för löpande bokföring, L för löner"]

Om ett verifikationsnummer saknas i en serie ska luckan förklaras. Systemet har en funktion för att registrera förklaringar till nummerluckor, och förklaringarna bevaras som en del av räkenskapsinformationen.

### 5.2 Verifikationens innehåll

Varje verifikation innehåller:
- Verifikationsnummer
- Bokföringsdatum (affärshändelsens datum)
- Registreringsdatum (datum då posten skapades)
- Beskrivning av affärshändelsen
- Konteringsrader (konto, debet, kredit)
- Referens till underlag (bifogat dokument, fakturanummer, etc.)
- Status (utkast / bokförd / reverserad)
- Vid rättelse: referens till reverserad eller reverserande verifikation, alternativt rättelselogg för rättelse i samma verifikat

### 5.3 Underlag

Underlag kopplas till verifikationer som bifogade dokument (PDF, bild). Dokumenten lagras i dokumentarkivet med SHA-256 checksumma för integritetskontroll.

Typer av underlag:
- Kundfakturor (genererade i systemet)
- Leverantörsfakturor (uppladdade eller inmejlade)
- Kvitton (fotograferade/skannade)
- Bankbekräftelser (synkroniserade)
- Löneunderlag och lönespecifikationer
- Övriga avtal och dokument (uppladdade)

Dokument som är kopplade till bokförda verifikationer kan inte raderas, eftersom de omfattas av arkiveringsskyldigheten.

## 6. Rättelser (BFL 5 kap. 5 §)

6.1. Bokförda verifikationer (status: bokförd) kan inte tyst ändras eller raderas. Detta upprätthålls av databastriggrar i enlighet med bokföringslagens krav på oföränderlighet.

6.2. Systemet stödjer två rättelsevägar, båda med bevarad ursprungsinformation:

**a) Stornobokning (särskild rättelsepost).** En ny verifikation skapas som reverserar den felaktiga posten (byter debet och kredit). Den nya verifikationen länkas till originalet via referens. Därefter skapas en ny korrekt verifikation vid behov. Denna väg är alltid tillåten.

**b) Rättelse i samma verifikat.** Felaktiga uppgifter eller konteringsrader stryks och ersätts inom samma verifikat. Den ursprungliga uppgiften förblir läsbar, och vem som gjorde rättelsen och när loggas oföränderligt i en separat rättelselogg. Denna väg är endast tillåten så länge perioden är öppen och olåst.

6.3. När en period är låst eller stängd, eller när bokföringen redan legat till grund för en inlämnad deklaration eller ett bokslut, är stornobokning den enda tillåtna vägen.

6.4. Rättelsen innehåller alltid uppgift om vilken verifikation som rättats, när rättelsen gjordes, och vem som utförde den.

## 7. Periodavstängning och låsning

7.1. Räkenskapsperioder kan stängas och låsas. En låst period tillåter inte nya bokföringsposter. Periodlåsning upprätthålls av databastriggrar, inte enbart av gränssnittet.

7.2. Utöver periodlåsning kan ett företagsgemensamt låsdatum sättas. Ingen bokföring kan ske före detta datum. Ställs in under **Inställningar > Bokföring**.

7.3. Årsbokslut registreras som bokföringsposter i systemet.

7.4. Ansvarig för att stänga och låsa perioder: [NAMN]

## 8. Momshantering

8.1. Följande momssatser hanteras:

| Momssats | Beskrivning | Utgående moms-konto | Ingående moms-konto |
|---|---|---|---|
| 25 % | Standardsats | 2611 | 2641 |
| 12 % | Reducerad (restaurang och servering, hotell m.m.) | 2621 | 2641 |
| 6 % | Reducerad (böcker, tidningar, persontransport, kultur m.m.) | 2631 | 2641 |
| 0 % (export) | Varuexport utanför EU | - | 2641 |
| Omvänd skattskyldighet | Byggtjänster, EU-förvärv, vissa varor | 2614 (beräknad utgående) | 2645 / 2647 |
| Momsfri | Undantagna transaktioner | - | - |

*Notering: Livsmedel sänks tillfälligt från 12 % till 6 % under perioden 1 april 2026 till och med 31 december 2027. Restaurang- och serveringstjänster berörs inte av sänkningen utan ligger kvar på 12 %.*

8.2. Fakturor stödjer blandade momssatser (per fakturarad).

8.3. Momsdeklarationsunderlag genereras under **Skatt > Moms** och mappas till Skatteverkets rutor.

8.4. Redovisningsmetod: [ ] Faktureringsmetod  [ ] Kontantmetod
Momsperiod: [ ] Månad  [ ] Kvartal  [ ] Helår

## 9. Behandlingshistorik

9.1. Systemet registrerar automatiskt en behandlingshistorik som inkluderar:
- Registreringsdatum och tidpunkt för varje journalpost
- Tidpunkt för statusändring (utkast till bokförd)
- Vem som utförde bokningen (användar-ID kopplat till e-postadress, eller API-nyckel vid maskinell bokföring)
- Stornobokningar med referens till originalverifikation
- Rättelser i samma verifikat, med ursprungsvärde, nytt värde, tidpunkt och utförare
- Tidpunkt och utförare av periodlåsning
- Importer och maskinella körningar

9.2. Behandlingshistoriken genereras automatiskt av systemet och kan inte ändras av användaren.

9.3. Behandlingshistoriken tas fram under **Rapporter > Behandlingshistorik** per räkenskapsår eller datumintervall och kan laddas ner som PDF, CSV eller Excel. Rapporten visar registreringstidpunkt, utförare och detaljer för varje bokföringspost samt ändringar i bokföringssystemet (kontoplan, inställningar, räkenskapsår, importer, åtkomst) och anger programversionen. Behandlingshistoriken ingår även i säkerhetsbackupen under **Importera/Exportera > Exportera > Säkerhetsbackup**: ZIP-filen innehåller `revision/behandlingshistorik.json` (alla ändringar) och `revision/systemdokumentation.json` (kontoplan, verifikationsserier, arkiveringsprinciper, programversion), utöver SIE-filer, rapporter och underlag.

## 10. Import och export

| Funktion | Format | Beskrivning |
|---|---|---|
| SIE-import | SIE4 | Import av bokföringsdata från annat system |
| Bankfil-import | CSV och flera svenska bankformat | Import av banktransaktioner |
| SIE-export | SIE4 | Export av komplett bokföring per räkenskapsår |
| Säkerhetsbackup | ZIP | Komplett arkiv: SIE, rapporter, underlag, register och behandlingshistorik |
| Huvudbok och grundbok | PDF/skärm/CSV | Export av grund- och huvudbokföring |
| Resultat- och balansräkning | PDF/skärm | Export av resultat- och balansräkning |
| Momsdeklaration | PDF/skärm | Underlag för momsdeklaration |
| Periodisk sammanställning | PDF/skärm | EU-försäljning av varor och tjänster |
| SRU-export | SRU | Export för inkomstdeklaration (AB) |
| NE-bilaga | PDF/skärm | Bilaga till inkomstdeklaration (EF) |
| Årsredovisning | PDF/skärm | Årsredovisning för aktiebolag |
| Verifikationsunderlag | PDF/bild | Nedladdning av bifogade dokument |

## 11. Integrationer

| Integration | Beskrivning | Dataflöde |
|---|---|---|
| Enable Banking (PSD2) | Bankkontosynkronisering | Bank -> Accounted (läsning av transaktioner och saldon) |
| Skatteverket | Momsdeklaration, arbetsgivardeklaration (AGI), skattekonto | Accounted -> Skatteverket (inlämning signeras med BankID) |
| Anthropic (Claude) | Maskinell kategorisering av transaktioner och avläsning av underlag | Accounted -> Anthropic -> Accounted (transaktions- och dokumentdata skickas, förslag returneras) |
| Resend | E-postutskick | Accounted -> Resend -> mottagare (fakturor, påminnelser) |
| BankID (via identitetsleverantör) | Inloggning och signering | Accounted -> leverantör -> Accounted |
| PostHog | Användningsstatistik för tjänsten | Accounted -> PostHog |

[ANGE YTTERLIGARE INTEGRATIONER OM TILLÄMPLIGT, t.ex. import från Fortnox, Visma, Bokio, Björn Lundén eller Briox]

**Notering om maskinell behandling:** förslag från maskinella hjälpmedel bokförs aldrig automatiskt utan att en användare har granskat och godkänt dem. Godkännandet loggas i behandlingshistoriken.

## 12. API-nycklar och maskinell åtkomst

12.1. Externa system och AI-assistenter kan ges åtkomst till bokföringen via API-nycklar. Nycklarna skapas och återkallas under **Inställningar > API**.

12.2. Varje nyckel har avgränsade behörigheter (scopes), t.ex. enbart läsning av rapporter eller skrivning av transaktioner. En nyckel kan aldrig göra mer än sina tilldelade behörigheter.

12.3. Åtgärder som utförs via API-nyckel loggas i behandlingshistoriken med nyckeln som utförare.

12.4. Utfärdade API-nycklar och deras behörigheter:

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

13.4. Tvåfaktorsautentisering (TOTP) krävs för samtliga användare i den molnbaserade tjänsten.

13.5. Personer med åtkomst till bokföringen:

| Namn | Roll | Tilldelad |
|---|---|---|
| [NAMN] | [ROLL] | [DATUM] |

13.6. Ansvarig för att tilldela och granska behörigheter: [NAMN]

## 14. Säkerhetskopiering och arkivering

14.1. Räkenskapsinformationen lagras i EU och bevaras i minst 7 år enligt BFL 7 kap.

14.2. Utöver leverantörens lagring bör företaget själv ta ut en egen kopia. Detta görs under **Importera/Exportera > Exportera > Säkerhetsbackup**.

14.3. Företagets rutin för egen säkerhetskopiering: [BESKRIV HUR OFTA OCH VAR KOPIAN FÖRVARAS, t.ex. "En gång per kvartal samt vid varje bokslut. Förvaras krypterad på extern disk."]

14.4. Se även företagets arkivplan, som beskriver var räkenskapsinformationen förvaras.

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
