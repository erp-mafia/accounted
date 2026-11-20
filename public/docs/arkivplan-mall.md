# Arkivplan

**Mall för användare av Accounted**
Upprättad i enlighet med BFNAR 2013:2 punkt 8.3

---

## Instruktioner

Denna mall ska fyllas i av dig som kund och sparas som del av din systemdokumentation. Enligt Bokföringsnämndens allmänna råd (BFNAR 2013:2 punkt 8.3) ska det finnas en arkivplan när det behövs för att överblicka den arkiverade räkenskapsinformationen. Arkivplanen ska visa vad som arkiverats och var det förvaras, och vid behov hur arkivet är uppbyggt.

Fyll i de markerade fälten. Radera denna instruktionssektion innan du arkiverar dokumentet.

---

## 1. Företagsuppgifter

| Fält | Uppgift |
|---|---|
| Företagsnamn | [FÖRETAGSNAMN] |
| Organisationsnummer | [ORG-NR] |
| Företagsform | [ ] Enskild firma  [ ] Aktiebolag |
| Räkenskapsår | [STARTMÅNAD] - [SLUTMÅNAD] |
| Bokföringsmetod | [ ] Faktureringsmetoden  [ ] Kontantmetoden |
| Momsredovisningsperiod | [ ] Månadsvis  [ ] Kvartalsvis  [ ] Årsvis |
| Ansvarig för bokföringen | [NAMN, ROLL] |

## 2. Bokföringssystem

| Fält | Uppgift |
|---|---|
| Programvara | Accounted ([DOMÄN, för den molnbaserade tjänsten app.accounted.se]) |
| Leverantör | [BOLAGSNAMN], org.nr [ORG-NR] |
| Lagringsplats | Molnbaserad tjänst, databas och filer lagrade i Sverige (Supabase på AWS, region eu-north-1, Stockholm) |
| Åtkomst | Via webbläsare. Inloggning med e-post och lösenord; i den molnbaserade tjänsten krävs dessutom en andra faktor (engångskod från autentiseringsapp eller BankID). |
| Kontoplan | BAS 2026 (konfigurerad i Accounted) |

## 3. Förteckning över räkenskapsinformation

Tabellen nedan anger vilken räkenskapsinformation som finns, i vilken form den förvaras, var, och arkiveringstid.

Med arkiveringstid 7 år avses till och med det sjunde året efter utgången av det kalenderår då räkenskapsåret avslutades (7 kap. 2 § BFL). Exempel: för ett räkenskapsår som slutar 2026-06-30 ska räkenskapsinformationen bevaras till och med 2033-12-31.

### 3.1 Löpande bokföring

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Grundbokföring (registreringsordning) | Elektronisk | Accounted databas | 7 år |
| Huvudbokföring (systematisk ordning) | Elektronisk | Accounted databas | 7 år |
| Verifikationer (journalposter) | Elektronisk | Accounted databas | 7 år |
| Rättelselogg (rättelser i samma verifikat: ursprungsvärde, nytt värde, tidpunkt, utförare) | Elektronisk | Accounted databas (oföränderlig logg) | 7 år |

### 3.2 Verifikationsunderlag

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid | Anmärkning |
|---|---|---|---|---|
| Kundfakturor (utgående) | Elektronisk (PDF) | Accounted dokumentarkiv | 7 år | Genereras i Accounted |
| Leverantörsfakturor (inkommande) | Elektronisk (PDF/bild) | Accounted dokumentarkiv | 7 år | Uppladdade, skannade eller inmejlade |
| Kvitton | Elektronisk (foto/PDF) | Accounted dokumentarkiv | 7 år | Fotograferade via appen eller skickade via WhatsApp |
| Bankutdrag/kontoutdrag | Elektronisk | Accounted databas | 7 år | Synkroniserade via Enable Banking (PSD2) eller importerade bankfiler |
| E-fakturor via Peppol (inkommande) | Elektronisk (UBL-XML, eventuell bifogad PDF) | Accounted dokumentarkiv | 7 år | Mottagna via Peppol-nätverket (accesspunkt Qvalia); originalfilen bevaras oförändrad |
| Skattekontoutdrag (importerade filer) | Elektronisk (CSV/SKV-fil från Skatteverket) | Accounted databas (transaktionerna samt importlogg med filnamn och kontrollsumma) | 7 år | Importerade under Importera/Exportera, alternativt hämtade via Skatteverket-kopplingen |
| Avtal och övriga underlag | [Elektronisk/Papper] | [Accounted / Fysisk pärm] | 7 år | [Ange var dessa förvaras] |

### 3.3 Årsbokslut och årsredovisning

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Resultaträkning | Elektronisk | Accounted rapportmodul | 7 år |
| Balansräkning | Elektronisk | Accounted rapportmodul | 7 år |
| Årsredovisning (AB) / Årsbokslut (EF) | [Elektronisk/Papper] | [Accounted / Bolagsverket / Fysisk pärm] | 7 år (10 år rekommenderat) |
| NE-bilaga (EF) | Elektronisk | Accounted rapportmodul | 7 år |
| SIE-filer (export) | Elektronisk | [Ange var exporterade filer sparas] | 7 år |
| Komplett arkiv (ZIP-arkiv med SIE-filer, rapporter, underlag och behandlingshistorik) | Elektronisk | [Ange var exporterade arkiv sparas, t.ex. extern disk eller Google Drive/Dropbox via Molnsynkronisering] | 7 år |

### 3.4 Skattedeklarationer och momsrapporter

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Momsdeklarationer | Elektronisk | Accounted rapportmodul + Skatteverket | 7 år |
| SRU-filer | Elektronisk | Accounted rapportmodul | 7 år |
| Inkomstdeklaration | [Elektronisk/Papper] | [Skatteverket / Egen kopia] | 7 år |

### 3.5 Systemdokumentation

| Dokument | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Systemdokumentation (genererad: **Rapporter > Export & arkiv > Systemdokumentation**, samt denna mall) | Elektronisk | [Accounted / Egen lagring] | Samma som den räkenskapsinformation den avser |
| Behandlingshistorik | Elektronisk | Accounted (automatiskt genererad) | Samma som den räkenskapsinformation den avser |
| Denna arkivplan | [Elektronisk/Papper] | [Ange lagringsplats] | Samma som den räkenskapsinformation den avser |

## 4. Pappersoriginal

4.1. Räkenskapsinformation som tagits emot i pappersform och som har överförts till elektronisk form genom skanning eller fotografering får förstöras när överföringen är gjord, om överföringen med hänsyn till tekniska metoder, organisatoriska åtgärder och övriga omständigheter inte innebär risk för att räkenskapsinformationen förändras eller försvinner (7 kap. 6 § BFL, i lydelse från 1 juli 2024). Kontrollera före förstöring att alla sidor och uppgifter har kommit med och är läsbara. Se även BFNAR 2013:2 i lydelse enligt BFNAR 2024:1 och Bokföringsnämndens vägledning Bokföring.

Företagets hantering av pappersoriginal: [ ] Förstörs efter kontrollerad överföring  [ ] Sparas (ange plats nedan)

4.2. Dokument som tas emot elektroniskt (e-fakturor, digitala kvitton) arkiveras i elektronisk form. Inget pappersoriginal finns.

4.3. Förvaring av sparade pappersoriginal:
- Plats: [ANGE PLATS I SVERIGE, t.ex. kontor, bankfack]
- Ansvarig: [NAMN]

## 5. Säkerhetskopiering och redundans

5.1. Accounted sköter automatisk daglig säkerhetskopiering av databasen via Supabase-infrastrukturen.

5.2. Kunden rekommenderas att regelbundet ta ut en egen kopia under **Importera/Exportera > Exportera > Komplett arkiv** (ZIP-arkiv med SIE-filer, rapporter, underlag och behandlingshistorik) och spara den åtskild från originalet. Med tillägget Molnsynkronisering kan kopian laddas upp till Google Drive eller Dropbox. Om kopian förvaras utanför Sverige, se avsnitt 7.3.

Kundens kompletterande säkerhetskopiering:
- Frekvens: [t.ex. månadsvis, kvartalsvis]
- Lagringsplats: [t.ex. extern hårddisk, molnlagring]
- Ansvarig: [NAMN]

## 6. Åtkomst efter avslutad prenumeration

6.1. Vid uppsägning av Accounted-kontot har Kunden minst nittio (90) dagar efter uppsägningsdagens utgång att exportera all räkenskapsinformation, i enlighet med Användarvillkoren avsnitt 8.3.

6.2. Räkenskapsinformation som omfattas av sjuårig arkiveringsskyldighet bevaras i skrivskyddat läge av Accounted, alternativt tillhandahålls som fullständig dataexport.

6.3. Det är Kundens ansvar att planera för dataportabilitet och säkerställa tillgång till räkenskapsinformation under hela arkiveringsperioden, oavsett om Tjänsten fortfarande används.

## 7. Geografisk lagring

7.1. Den molnbaserade tjänstens databas och filer, och därmed räkenskapsinformationen, lagras i Sverige via Supabase (AWS-infrastruktur, region eu-north-1, Stockholm).

7.2. Maskinell behandling (kategorisering samt avläsning av underlag) sker inom EU via Amazon Bedrock; datan lämnar inte EU. Vilka underbiträden som behandlar uppgifter, och var, framgår av integritetspolicyn (avsnitt 4 och 6).

7.3. Huvudregeln är att räkenskapsinformation förvaras i Sverige (7 kap. 2 § BFL). Enligt 7 kap. 3 a § BFL får räkenskapsinformation i elektronisk form förvaras i ett annat EU-land, eller i vissa andra länder, om 1) Skatteverket har fått en anmälan om var den förvaras och om varje ändring av platsen, 2) Skatteverket eller Tullverket på begäran genast får elektronisk åtkomst till den, och 3) den genast kan skrivas ut på papper i Sverige.

Den molnbaserade tjänsten förvarar räkenskapsinformationen i Sverige. Avsnittet blir aktuellt vid egen drift utomlands eller om företaget självt förvarar räkenskapsinformation utomlands.

**Anmälan till Skatteverket:** [ ] Ej tillämpligt (förvaras i Sverige)  [ ] Har gjorts  [ ] Behöver göras

## 8. Ansvar och kontakt

| Roll | Namn | Kontakt |
|---|---|---|
| Bokföringsansvarig | [NAMN] | [E-POST / TELEFON] |
| Extern redovisningskonsult (om tillämpligt) | [NAMN / BYRÅ] | [E-POST / TELEFON] |
| Revisor (om tillämpligt) | [NAMN / BYRÅ] | [E-POST / TELEFON] |

## 9. Uppdatering av arkivplanen

Denna arkivplan ska granskas och vid behov uppdateras minst en gång per räkenskapsår, samt vid byte av bokföringsprogram, ändring av företagsform, eller ändring av lagringsrutiner.

| Datum | Ändring | Utförd av |
|---|---|---|
| [DATUM] | Första version upprättad | [NAMN] |
| | | |

---

*Denna arkivplan uppfyller kraven i BFNAR 2013:2 punkt 8.3 och Exempel 8.1 i vägledningen. Anpassa innehållet till ditt företags specifika förhållanden. Platshållare markerade med hakparenteser ska fyllas i.*
