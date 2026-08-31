# Arkivplan

**Mall för användare av Accounted**
Upprättad i enlighet med BFNAR 2013:2 punkt 8.3

---

## Instruktioner

Denna mall ska fyllas i av dig som kund och sparas som del av din systemdokumentation. Bokföringsnämndens allmänna råd (BFNAR 2013:2) kräver att varje bokföringsskyldig upprättar en arkivplan som beskriver vilken räkenskapsinformation som finns, var den förvaras, och vem som ansvarar för arkiveringen.

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
| Lagringsplats | Molnbaserad tjänst, data lagrad inom EU (Supabase på AWS, region eu-north-1, Stockholm) |
| Åtkomst | Via webbläsare. Inloggning med e-post och lösenord; tvåfaktorsautentisering (TOTP) krävs i den molnbaserade tjänsten. BankID kan kopplas som inloggningsmetod. |
| Kontoplan | BAS 2026 (konfigurerad i Accounted) |

## 3. Förteckning över räkenskapsinformation

Tabellen nedan anger vilken räkenskapsinformation som finns, i vilken form den förvaras, var, och arkiveringstid.

### 3.1 Löpande bokföring

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Grundbokföring (registreringsordning) | Elektronisk | Accounted databas | 7 år efter räkenskapsårets utgång |
| Huvudbokföring (systematisk ordning) | Elektronisk | Accounted databas | 7 år efter räkenskapsårets utgång |
| Verifikationer (journalposter) | Elektronisk | Accounted databas | 7 år efter räkenskapsårets utgång |
| Rättelselogg (rättelser i samma verifikat: ursprungsvärde, nytt värde, tidpunkt, utförare) | Elektronisk | Accounted databas (oföränderlig logg) | 7 år efter räkenskapsårets utgång |

### 3.2 Verifikationsunderlag

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid | Anmärkning |
|---|---|---|---|---|
| Kundfakturor (utgående) | Elektronisk (PDF) | Accounted dokumentarkiv | 7 år | Genereras i Accounted |
| Leverantörsfakturor (inkommande) | Elektronisk (PDF/bild) | Accounted dokumentarkiv | 7 år | Uppladdade/skannade |
| Kvitton | Elektronisk (foto/PDF) | Accounted dokumentarkiv | 7 år | Fotograferade via appen |
| Bankutdrag/kontoutdrag | Elektronisk | Accounted via PSD2-koppling | 7 år | Synkroniserade via Enable Banking |
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
| Säkerhetsbackup (ZIP-arkiv med SIE-filer, rapporter, underlag, register och behandlingshistorik) | Elektronisk | [Ange var exporterade arkiv sparas] | 7 år |

### 3.4 Skattedeklarationer och momsrapporter

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Momsdeklarationer | Elektronisk | Accounted rapportmodul + Skatteverket | 7 år |
| SRU-filer | Elektronisk | Accounted rapportmodul | 7 år |
| Inkomstdeklaration | [Elektronisk/Papper] | [Skatteverket / Egen kopia] | 7 år |

### 3.5 Systemdokumentation

| Dokument | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Systemdokumentation | Elektronisk | [Accounted / Egen lagring] | Samma som den räkenskapsinformation den avser |
| Behandlingshistorik | Elektronisk | Accounted (automatiskt genererad) | Samma som den räkenskapsinformation den avser |
| Denna arkivplan | [Elektronisk/Papper] | [Ange lagringsplats] | Samma som den räkenskapsinformation den avser |

## 4. Pappersoriginal

4.1. Räkenskapsinformation som tagits emot i pappersform (kvitton, fakturor) och som har överförts till elektronisk form genom skanning eller fotografering ska bevaras i sin ursprungliga pappersform i minst tre (3) år efter utgången av det kalenderår då räkenskapsåret avslutades, i enlighet med 7 kap. 6 § BFL.

*Notering: Lagändring trädde i kraft 1 juli 2024 som möjliggör omedelbar förstöring av pappersoriginal efter överföring till elektronisk form, under förutsättning att överföringen sker på ett betryggande sätt och att inga uppgifter går förlorade. Se BFNAR 2024:1 och uppdaterad vägledning (2024-09-16) for detaljer om vilka krav som gäller vid sådan överföring.*

4.2. Dokument som tas emot elektroniskt (e-fakturor, digitala kvitton) arkiveras i elektronisk form. Inget pappersoriginal finns.

4.3. Förvaring av pappersoriginal:
- Plats: [ANGE PLATS, t.ex. kontor, bankfack]
- Ansvarig: [NAMN]

## 5. Säkerhetskopiering och redundans

5.1. Accounted sköter automatisk daglig säkerhetskopiering av databasen via Supabase-infrastrukturen.

5.2. Kunden rekommenderas att regelbundet ta ut säkerhetsbackupen (ZIP-arkiv under **Importera/Exportera > Exportera > Säkerhetsbackup**, innehåller SIE-filer, rapporter, underlag, register och behandlingshistorik) och spara den på en separat lagringsplats som kompletterande säkerhetskopia.

Kundens kompletterande säkerhetskopiering:
- Frekvens: [t.ex. månadsvis, kvartalsvis]
- Lagringsplats: [t.ex. extern hårddisk, molnlagring]
- Ansvarig: [NAMN]

## 6. Åtkomst efter avslutad prenumeration

6.1. Vid uppsägning av Accounted-kontot har Kunden nittio (90) dagar att exportera all räkenskapsinformation i enlighet med Användarvillkoren avsnitt 8.

6.2. Räkenskapsinformation som omfattas av sjuårig arkiveringsskyldighet bevaras i skrivskyddat läge av Accounted, alternativt tillhandahålls som fullständig dataexport.

6.3. Det är Kundens ansvar att planera för dataportabilitet och säkerställa tillgång till räkenskapsinformation under hela arkiveringsperioden, oavsett om Tjänsten fortfarande används.

## 7. Geografisk lagring

7.1. All data i Accounted lagras inom EU/EES via Supabase (AWS-infrastruktur, region eu-north-1, Stockholm).

7.2. Maskinell behandling (kategorisering samt avläsning av underlag) sker inom EU via Amazon Bedrock (eu-north-1, Stockholm); datan lämnar inte EU. Underbiträden enligt integritetspolicyn: Supabase (EU, eu-north-1), Vercel (applikationshosting, globalt CDN med EU Data Residency), Enable Banking (EU), Amazon Web Services (AI-inferens, EU, eu-north-1), Resend (e-postleverans, USA) och PostHog (EU, Frankfurt). Det enda underbiträdet som behandlar uppgifter i USA är Resend, med stöd av standardavtalsklausuler (se Personuppgiftsbiträdesavtalet, avsnitt 6.2).

7.3. I enlighet med 7 kap. 3a § BFL får räkenskapsinformation i elektronisk form förvaras i annat EU-land under förutsättning att detta har anmälts till Skatteverket.

**Anmälan till Skatteverket:** [ ] Har gjorts  [ ] Behöver göras  [ ] Ej tillämpligt (data lagras i Sverige)

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
