# K1: Förenklat Årsbokslut för Enskild Näringsverksamhet

<!-- toc -->
**Contents**

- [Legal basis](#legal-basis)
- [Applicability: who may use K1?](#applicability-who-may-use-k1)
- [Räkenskapsåret](#räkenskapsåret)
- [Kontantmetoden vs faktureringsmetoden](#kontantmetoden-vs-faktureringsmetoden)
- [Förenklat årsbokslut: struktur](#förenklat-årsbokslut-struktur)
- [BAS 2018 Förenklat årsbokslut kontoplan: overview](#bas-2018-förenklat-årsbokslut-kontoplan-overview)
- [Värderingsregler: K1 skiljer sig från K2/K3](#värderingsregler-k1-skiljer-sig-från-k2k3)
- [NE-bilaga mapping (the critical bridge)](#ne-bilaga-mapping-the-critical-bridge)
- [Värderingsregler vid avveckling (vid sista räkenskapsåret)](#värderingsregler-vid-avveckling-vid-sista-räkenskapsåret)
- [Förteckning över anläggningstillgångar](#förteckning-över-anläggningstillgångar)
- [Arkivering](#arkivering)
- [Bokslutsprocess: checklista per K1-fält](#bokslutsprocess-checklista-per-k1-fält)
- [Common pitfalls (specifika för K1)](#common-pitfalls-specifika-för-k1)
- [When K1 is *not* enough: switch to fullt årsbokslut](#when-k1-is-not-enough-switch-to-fullt-årsbokslut)
- [Implementation checklist för software](#implementation-checklist-för-software)
- [Out of scope](#out-of-scope)
- [Legal sources](#legal-sources)

<!-- /toc -->

## Legal basis

- BFL (Bokföringslagen 1999:1078) 6 kap 6 §: möjlighet att upprätta förenklat årsbokslut
- BFNAR 2006:1: "Enskilda näringsidkare som upprättar förenklat årsbokslut" (K1) full vägledning
- BFL 5 kap: verifikationer
- BFL 7 kap: arkivering

## Applicability: who may use K1?

K1 (förenklat årsbokslut) is **available only** to:
- **Enskild näringsidkare** (sole trader): *not AB, HB, KB, ekonomisk förening, stiftelse, eller dödsbo som driver verksamhet*
- Whose **årlig nettoomsättning normally does not exceed 3 000 000 kr** (3 MSEK)

Above 3 MSEK or for non-sole-trader entities, **fullt årsbokslut** must be drawn up enligt BFNAR 2017:3 (K2/K3 equivalent for non-AB).

### Multiple verksamheter

If the same person runs multiple verksamheter:
- Aggregera all verksamheter when comparing to 3 MSEK threshold
- If aggregated > 3 MSEK → ALL must use fullt årsbokslut
- If aggregated ≤ 3 MSEK → may use K1 for all of them

### Enkelt bolag

If multiple personer arbetar gemensamt i ett enkelt bolag:
- Track-aggregeras per delägare → each delägare's share räknas mot 3 MSEK
- If en delägares andel > 3 MSEK, samme delägare måste lämna fullt årsbokslut: och om så är fallet, alla delägare ska lämna fullt årsbokslut för den gemensamma verksamheten. En näringsidkare som tillämpar förenklat årsbokslut i en verksamhet ska använda samma regelverk för sina övriga verksamheter, man får inte blanda förenklat och fullständigt över olika delverksamheter.

## Räkenskapsåret

Enskild näringsverksamhet får bara ha **kalenderår** (1 jan-31 dec) som räkenskapsår. Brutet räkenskapsår får INTE användas.

Vid företagets start får första räkenskapsåret förkortas eller förlängas så att det slutar 31 december: **dock max 18 månader långt**. Vid avveckling får sista räkenskapsåret förkortas (inte förlängas).

## Kontantmetoden vs faktureringsmetoden

K1 allows **either** löpande bokföringsmetod:

### Kontantmetoden

- Endast in- och utbetalningar bokförs löpande under året
- Vid årets slut bokförs alla obetalda kund- och leverantörsfakturor som bokslutstransaktioner
- Tillåten om **årlig nettoomsättning ≤ 3 MSEK** (BFL 5 kap 2 §)
- Praktisk fördel: mycket enklare löpande bokföring
- Praktisk nackdel: balansräkningen visar inte rätt under året, bara vid bokslut

### Faktureringsmetoden

- Alla affärshändelser bokförs när de inträffar (faktura skickas / mottas)
- Huvudregel i bokföringslagen (BFL 5 kap 1 §)
- Krävs för företag > 3 MSEK omsättning

## Förenklat årsbokslut: struktur

The förenklat årsbokslut consists of:
- A **balansräkning** (B-poster + B10 eget kapital)
- A **resultaträkning** (R-poster R1 till R11)
- A set of **U-poster** (U1-U4 upplysningar om obeskattade reserver)

These are submitted (informellt: för dokumentation; **inte registreras hos Bolagsverket**) and act as the bridge to NE-bilagan i deklarationen.

### Balansräkning struktur

**Anläggningstillgångar:**
| Post | Innehåll |
|---|---|
| **B1** | Immateriella anläggningstillgångar (rättigheter, patent, licenser, hemsidor, varumärken, franchiseavtal, goodwill) |
| **B2** | Byggnader och markanläggningar |
| **B3** | Mark och andra tillgångar som inte får skrivas av (mark, konst, antikviteter) |
| **B4** | Maskiner och inventarier |
| **B5** | Övriga anläggningstillgångar (andelar i ekonomiska föreningar, andelar i kooperativa föreningar) |

**Omsättningstillgångar:**
| Post | Innehåll |
|---|---|
| **B6** | Varulager |
| **B7** | Kundfordringar |
| **B8** | Övriga fordringar (förskott till leverantörer, upplupna ränteintäkter, momsfordran) |
| **B9** | Kassa och bank |

**Eget kapital:**
| Post | Innehåll |
|---|---|
| **B10** | Eget kapital (= tillgångar − skulder) |

**Skulder:**
| Post | Innehåll |
|---|---|
| **B13** | Låneskulder (banklån, kreditavtal) |
| **B14** | Skatteskulder (momsskuld, arbetsgivaravgifter, källskatt på lön) |
| **B15** | Leverantörsskulder |
| **B16** | Övriga skulder (förskott från kunder, upplupna räntekostnader, beslutade skadeståndsbetalningar) |

### Resultaträkning struktur

**Intäkter:**
| Post | Innehåll |
|---|---|
| **R1** | Försäljning och utfört arbete samt övriga momspliktiga intäkter (konto 3000) |
| **R2** | Momsfria intäkter (konto 3100, försäkringsersättningar, offentliga stöd, skadestånd) |
| **R3** | Bil- och bostadsförmån mm (konto 3200) |
| **R4** | Ränteintäkter mm (konto 8310, om sammanlagt > 5 000 kr) |

**Kostnader:**
| Post | Innehåll |
|---|---|
| **R5** | Varor, material och tjänster (konton 40-46 + 49) |
| **R6** | Övriga externa kostnader (lokal, telefon, försäkringar, reklam, etc; konton 50-69 + 47) |
| **R7** | Anställd personal (löner, sociala avgifter; konton 70-75) |
| **R8** | Räntekostnader mm (konto 8410, om sammanlagt > 5 000 kr) |

**Av- och nedskrivningar:**
| Post | Innehåll |
|---|---|
| **R9** | Av- och nedskrivningar av byggnader och markanläggningar (konto 7820, 7821, 7824) |
| **R10** | Av- och nedskrivningar av maskiner och inventarier och immateriella tillgångar (konto 7810, 7830) |

**Resultat:**
| Post | Innehåll |
|---|---|
| **R11** | Bokfört resultat (= R1+R2+R3+R4 − R5−R6−R7−R8−R9−R10) |

R11 är direkt utgångspunkt för **NE-bilaga sida 1 R11**.

### U-poster (upplysningar: informellt, inte bokförda)

| Post | Innehåll |
|---|---|
| **U1** | Summan av alla periodiseringsfonder vid årets slut |
| **U2** | Expansionsfond vid årets slut |
| **U3** | Ersättningsfond vid årets slut |
| **U4** | Insatsemissioner, skogskonto, skogsskadekonto, upphovsmannakonto, avbetalningsplan på skog och liknande |

**Critical**: U1, U2, U4 are informationspunkter: NOT booked. Periodiseringsfond och expansionsfond för EF får (per BFNAR 2006:1) **inte** bokföras direkt mot resultatet → de hör hemma endast på NE-bilagan sid 2. Men du **får** bokföra dem på ett konto under eget kapital (e.g., 2080 Periodiseringsfonder) med ett **utjämningskonto** (2090) som motkonto, för att hålla reda på dem, pure information, no resultatpåverkan.

U3 Ersättningsfond is **different**: ersättningsfond ÄR bokförd via resultaträkningen (med viss undantag för ersättningsfond för mark per BFNAR 2006:1 kommentar 9.2).

## BAS 2018 Förenklat årsbokslut kontoplan: overview

The K1-anpassade kontoplan har en mycket reducerat kontostruktur vs full BAS 2024. Key konton:

### Tillgångar (1xxx)

| Konto | Namn | B-post |
|---|---|---|
| 1000 | Immateriella anläggningstillgångar | B1 |
| 1009 | Årets avskrivningar på immateriella anläggningstillgångar | B1 |
| 1110 | Byggnader | B2 |
| 1119 | Ackumulerade avskrivningar på byggnader | B2 |
| 1130 | Mark | B3 |
| 1150 | Markanläggningar | B2 |
| 1159 | Ackumulerade avskrivningar på markanläggningar | B2 |
| 1180 | Pågående nyanläggningar och förskott för byggnader och mark | B3 |
| 1220 | Maskiner och inventarier | B4 |
| 1221 | Årets nyanskaffning av maskiner och inventarier | B4 |
| 1222 | Årets ersättning för maskiner och inventarier | B4 |
| 1229 | Årets avskrivningar på maskiner och inventarier | B4 |
| 1230 | Byggnads- och markinventarier | B4 |
| 1240 | Bilar och andra transportmedel | B4 |
| 1300 | Andelar | B5 |
| 1400 | Lager | B6 |
| 1500 | Kundfordringar | B7 |
| 1600 | Övriga fordringar | B8 |
| 1650 | Momsfordran | B8 |
| 1700 | Förskott till leverantörer | B8 |
| 1910 | Kassa | B9 |
| 1920 | PlusGiro | B9 |
| 1930 | Företagskonto/checkkonto/affärskonto | B9 |
| 1940 | Övriga bankkonton | - |
| 1970 | Särskilda bankkonton | B9 |

### Eget kapital (2xxx)

| Konto | Namn | B-post |
|---|---|---|
| 2010 | Eget kapital, delägare 1 | B10 |
| 2011 | Egna varuuttag | B10 |
| 2012 | Avräkning för skatter och avgifter (skattekonto) | B10 |
| 2013 | Övriga egna uttag | B10 |
| 2014 | Uttag förmåner | B10 |
| 2017 | Egna insättningar | B10 |
| 2019 | Årets resultat, delägare 1 | B10 |
| 2020-2040 | Eget kapital, delägare 2-4 | B10 |
| 2050 | Avsättning till expansionsfond | **U2** (information; ej bokfört avdrag) |
| 2060 | Ersättningsfond | **U3** (bokfört) |
| 2070 | Insatsemissioner, avbetalningsplan på skog, skogskonto, upphovsmannakonto | **U4** |
| 2080 | Periodiseringsfonder | **U1** (information; ej bokfört avdrag) |
| 2081-2089 | Periodiseringsfond olika år | **U1** |
| 2090 | Utjämningskonto upplysningar 1-4 | (motkonto for U1/U2/U4) |

### Skulder (2xxx forts.)

| Konto | Namn | B-post |
|---|---|---|
| 2330 | Checkräkningskredit | B13 |
| 2350 | Skulder till kreditinstitut | B13 |
| 2390 | Övriga låneskulder | B13 |
| 2440 | Leverantörsskulder | B15 |
| 2610-2649 | Moms-konton (utgående 25%/12%/6%, ingående) | B14 |
| 2650 | Redovisningskonto för moms | B14 |
| 2660 | Särskilda punktskatter | B14 |
| 2710 | Personalskatt | B14 |
| 2730 | Lagstadgade sociala avgifter och särskild löneskatt | B14 |
| 2900 | Övriga skulder (förutbetalda intäkter, upplupna räntekostnader, etc) | B16 |

### Intäkter (3xxx)

| Konto | Namn | R-post |
|---|---|---|
| 3000 | Försäljning och utfört arbete samt övriga momspliktiga intäkter | **R1** |
| 3100 | Momsfria intäkter | **R2** |
| 3200 | Bil- och bostadsförmån mm | **R3** |
| 3500 | Fakturerade kostnader | **R1** |
| 3700 | Lämnade rabatter, bonus etc | R1/R2 |
| 3900 | Övriga rörelseintäkter | R1/R2 |
| 3970 | Vinst vid avyttring av immateriella och materiella tillgångar | **R2** |
| 3980 | Erhållna bidrag | **R2** |

### Kostnader (4xxx-6xxx)

| Konto | Namn | R-post |
|---|---|---|
| 4000 | Varor | R5 |
| 4600 | Legoarbeten och underentreprenader | R5 |
| 4700 | Erhållna rabatter, bonus etc | R6 |
| 4900 | Förändring av lager | R5 |
| 5000 | Lokalkostnader | R6 |
| 5100 | Fastighetskostnader | R6 |
| 5200 | Hyra av anläggningstillgångar | R6 |
| 5400 | Förbrukningsinventarier och förbrukningsmaterial | R6 |
| 5500 | Reparation och underhåll | R6 |
| 5600-5620 | Kostnader för transportmedel | R6 |
| 5700 | Frakter och transporter | R6 |
| 5800 | Resekostnader | R6 |
| 5900 | Reklam och PR | R6 |
| 6000 | Övriga försäljningskostnader | R6 |
| 6070 | Representation | R6 |
| 6071 | Representation, avdragsgill | R6 |
| 6072 | Representation, ej avdragsgill | R6 + NE sid 2 (justeringspost R16) |
| 6100 | Kontorsmateriel och trycksaker | R6 |
| 6200 | Tele och post | R6 |
| 6300/6310 | Företagsförsäkringar och övriga riskkostnader | R6 |
| 6500 | Övriga externa tjänster | R6 |
| 6800 | Inhyrd personal | R6 |
| 6900/6980 | Övriga kostnader, föreningsavgifter | R6 |

### Personalkostnader (7xxx)

| Konto | Namn | R-post |
|---|---|---|
| 7000 | BAS-konton Löner till anställda | R7 |
| 7300 | Kostnadsersättningar och förmåner | R7 |
| 7400 | Pensionskostnader | R7 |
| 7500 | Sociala och andra avgifter enligt lag och avtal | R7 |
| 7810 | Avskrivning på immateriella anläggningstillgångar | R10 |
| 7820/7821/7824 | Avskrivning byggnader/markanläggningar | R9 |
| 7830 | Avskrivning maskiner och inventarier | R10 |

### Finansiella poster (8xxx)

| Konto | Namn | R-post |
|---|---|---|
| 8310 | Ränteintäkter och utdelningar | R4 |
| 8410 | Räntekostnader för skulder | R8 |
| 8999 | Årets resultat (motkonto) | - |
| 2019 | Årets resultat (egen kapital sida) | - |

## Värderingsregler: K1 skiljer sig från K2/K3

Tanken med K1: **så få justeringar som möjligt mellan redovisat resultat och skattemässigt resultat**: alltså K1-värderingar följer skatteregler.

### Inventarier

- Skattemässig värdering: **räkenskapsenlig avskrivning huvudregel 30%** eller **kompletteringsregel 20%** (samma som AB)
- I förteckning över anläggningstillgångar dokumenteras: datum, tillgång, anskaffningsvärde, livslängd

### Räkenskapsenlig avskrivning huvudregel: 30%

- Avskrivningsunderlag = bokfört värde IB + årets inköp − årets försäljningar
- Avskrivning max **30% av avskrivningsunderlaget**
- Tillgångar tas upp till lägst **70% av avskrivningsunderlaget**

### Räkenskapsenlig avskrivning kompletteringsregel: 20%

- Tillgångar får tas upp till lägst:
  - 80% × inköp under räkenskapsåret
  - 60% × inköp under året före räkenskapsåret
  - 40% × inköp under andra året före räkenskapsåret
  - 20% × inköp under tredje året före räkenskapsåret
- I praktiken: 20% avskrivning per år, så att tillgången är helt avskriven efter 5 år

Each year: räkna ut lägsta värdet enligt huvudregel + lägsta enligt kompletteringsregel → välj lägsta → årets avskrivning = avskrivningsunderlag − valda värdet.

**K1 6.38 (BFNAR 2025:1)**: uppgår det bokförda värdet före årets avskrivning (avskrivningsunderlaget) till högst ett halvt prisbasbelopp får hela beloppet skrivas av (IL 18:13).

### Förbrukningsinventarier: direktavdrag

- Korttidsinventarier (livslängd ≤ 3 år) → direktavdrag i sin helhet
- Inventarier av mindre värde (anskaffningsvärde < halvt prisbasbelopp; ≈ 29 400 kr 2025 + moms) → direktavdrag möjligt

### Lagervärdering

- Huvudregel: lägsta värdets princip (LVP): det lägre av anskaffningsvärde och nettoförsäljningsvärde
- FIFO för värdering av identiska partier
- **97%-regeln** (3% schablonmässigt inkuransavdrag) tillåts i K1
- **K1 specifik förenkling**: lager med ett sammanlagt värde på **högst ett halvt prisbasbelopp** (29 600 kr 2026) **behöver inte alls tas upp** som tillgång utan får redovisas som kostnad (K1 6.47; IL 17:4a)

### Skulder

- Skulder som inte hade behövts om bokföringen följde faktureringsmetoden → **får utelämnas om < 5 000 kr**
- Räntekostnader och förskott från kunder < 5 000 kr → behöver inte periodiseras

### Avskrivning byggnader

- Skattemässig avskrivningsplan följs (vanligen 2-4% per år för bostads-, hyres-, industrifastigheter)
- För småhus 2% per år är typiskt

### Skogskonto / skogsskadekonto / upphovsmannakonto

- I förenklat årsbokslut: **kontosaldot bokförs i sin helhet i B9 (Kassa och bank)**: pengarna tillhör företaget och ska redovisas som tillgång. Dessutom upplyses kontot i ruta **U4** (Övriga upplysningar) med beskrivning av kontotyp och latent skatteskuld.
- För **räntefördelningens kapitalunderlag** tas däremot bara **halva beloppet** av skogskonto/skogsskadekonto/upphovsmannakonto med (latent skatt elimineras).

## NE-bilaga mapping (the critical bridge)

The whole point of the förenklade årsbokslutet is to feed directly into NE-bilagan utan extra arbete:

| Förenklat årsbokslut | → | NE-bilaga ruta |
|---|---|---|
| B1 Immateriella anläggningstillgångar | → | (info ruta 5-6 om anläggningstillgångar) |
| B2-B4 Övriga anläggningstillgångar | → | (info ruta 5-6) |
| B6 Varulager | → | (info ruta 5) |
| B7 Kundfordringar | → | (info ruta 5) |
| B9 Kassa och bank | → | (info ruta 5) |
| B10 Eget kapital | → | (info ruta 6) |
| B13-B16 Skulder | → | (info ruta 6) |
| R11 Bokfört resultat | → | NE **R11** |
| R12-R26 (in deklarationsbilden) | Skattemässiga justeringar (ej avdragsgill rep, ränta osv) | NE R12-R26 |
| U1 Periodiseringsfonder | → | NE **R32 (återföring)** / **R34 (avsättning)** |
| U2 Expansionsfond | → | NE **R36 (återföring)** → INK1 p.12.1 / **R37 (ökning)** → INK1 p.12.2 |
| U3 Ersättningsfond | → | (bokförd avsättning via resultaträkningen, ingen separat NE-ruta: påverkar R11) |
| (Räntefördelning positiv) | → | NE **R30** → INK1 p.11.1 (inkomst av kapital) |
| (Räntefördelning negativ) | → | NE **R31** → INK1 p.11.2 (avdrag i kapital) |
| (Eget egenavgifter schablonavdrag) | → | NE **R39, R40, R43** |
| Aktiv/passiv-kryssruta | → | NE sid 1 |
| Slutligt R47/R48 (aktiv) eller R49/R50 (passiv) | → | INK1 sid 2 ruta 10.1-10.4 |

## Värderingsregler vid avveckling (vid sista räkenskapsåret)

Vid företagets nedläggning används samma värderingsregler som i löpande verksamhet, men:
- All P-fond och expansionsfond måste återföras till beskattning
- Sparat fördelningsbelopp (positiv räntefördelning) får användas mot återföringen
- Ackumulerad inkomst-beräkning kan begäras (se [[ackumulerad-inkomst]] in `swedish-ef-skatteplanering`)

## Förteckning över anläggningstillgångar

Required by BFNAR 2006:1 kap 6:

Förteckning ska innehålla **per tillgång**:
- Datum för anskaffning
- Tillgångens benämning
- Anskaffningsvärde (totalt inkl ev. moms om köpet ej är momspliktig)
- Beräknad livslängd (för bedömning av avskrivningstid)

Förenklingsregel: om endast fåtal tillgångar finns, behöver inte separate förteckning föras: det räcker om uppgifter framgår av den löpande bokföringen (kopior av fakturor i en pärm).

Praktisk implementering: skriva på fakturakopian hur länge tillgången beräknas vara till nytta (e.g., "10 år" på en bil-faktura).

Vid utrangering eller försäljning ska tillgången **strykas** från förteckningen.

## Arkivering

All räkenskapsinformation (verifikationer, det förenklade årsbokslutet, lagervärdering, anläggningsförteckning, anläggningsavtal, ansvarsförbindelser) ska arkiveras **7 år** efter räkenskapsårets utgång enligt BFL 7 kap.

Format: pappersfakturor → behåll i original i pärm; elektroniska underlag → arkiveras elektroniskt (eller papper om inkommit på papper).

**BFL-ändring 2024-07-01:** kravet att behålla pappersoriginal i 3 år efter scanning **är borttaget**. Pappersoriginal får förstöras direkt efter att räkenskapsinformationen överförts till ett annat format, förutsatt att överföringen är tillförlitlig och den digitala kopian uppfyller arkiveringskraven. 7-årsregeln gäller fortfarande för den lagrade räkenskapsinformationen.

## Bokslutsprocess: checklista per K1-fält

Bokslutssekvens för en EF som upprättar förenklat årsbokslut. Varje steg motsvarar en post i förenklat årsbokslut och dess bokföringsmotsvarighet.

| # | Operation | Förenklat årsbokslut-fält |
|---|---|---|
| 1 | Avstämning bank/kassa/skattekonto vs bokföring (innan B-poster) | - |
| 2 | Avskrivning byggnader (4 % standard för industri-/näringsfastighet: kontrollera SKV A 2005:5 för byggnadstyp) | B2 |
| 3 | Avskrivning inventarier: huvudregeln 30 % declining på (IB + årets inköp − årets försäljningar) eller kompletteringsregeln 20 % straight-line. Använd det som ger lägst restvärde. | B4 |
| 4 | Lagervärdering: fysisk inventering 31 dec, 97 % av anskaffningsvärde (3 %-schablonavdrag) eller 85 % för djurlager. Lager < halvt PBB får utelämnas (BFNAR 2025:1) | B6 |
| 5 | Kundfordringar: avboka fjolårets, boka årets per saldolista 31 dec | B7 |
| 6 | Övriga fordringar: förhöjd leasingavgift, förskott till leverantör | B8 |
| 7 | Kassa och bank: saldon 31 dec inklusive skogskonto till **fullt belopp** (se separat sektion) | B9 |
| 8 | Låneskulder | B13 |
| 9 | Skatteskulder: moms, AGI-skuld | B14 |
| 10 | Leverantörsskulder inkl. moms | B15 |
| 11 | Övriga skulder: förskott från kund > 5 000 kr (K1 6.72) | B16 |
| 12 | Boka årets resultat (8999 debet / 2019 kredit för EF) | R11 |
| 13 | Fyll i U1 (P-fond), U2 (expansionsfond), U3 (ersättningsfond), U4 (skogskonto/upphovsmannakonto/betalningsplan) | U1-U4 |
| 14 | För R11 till NE-bilaga, fortsätt med skattemässiga justeringar R12-R26, RF R30/R31, P-fond R32/R34, expansionsfond R36/R37, schablonavdrag R43 | (NE forts.) |

Kritiska invarianter att kontrollera efter steg 14:
- Σ tillgångar = Σ skulder + eget kapital (balansidentitet)
- U1-U4 är **upplysningar**, INTE bokföringsposter mot resultatet
- R11 i NE = R11 i förenklat årsbokslut (samma siffra)
- P-fond i U1 är endast information: avdraget görs på NE-ruta R34, INTE i resultaträkningen

## Common pitfalls (specifika för K1)

1. **Bokföra P-fond / expansionsfond som kostnad i resultaträkningen**: INTE tillåtet i K1 → avdraget blir ogiltigt
2. **Använda brutet räkenskapsår**: INTE tillåtet för enskild näringsidkare
3. **Räkna fel på lagergränsen**: lager på högst ett halvt prisbasbelopp får utelämnas (2026: lager 29 600 kr utelämnas; 29 601 kr tas upp)
4. **Glömma förskott från kunder > 5 000 kr**: ska redovisas som skuld (B16), minskar R1 årets försäljning
5. **Förenkla bort relevanta verifikationer**: verifikationerna är fortfarande huvudbevis enligt BFL
6. **Använda K1 trots > 3 MSEK omsättning**: INTE tillåtet
7. **Glömma U1-U4 upplysningar**: formell compliance issue
8. **Felaktig värdering av skogskonto / upphovsmannakonto**: ska tas upp till halva beloppet (latent skatt 50%)
9. **Glömma att åtgärda ärvda fel**: om föregående års bokslut hade fel, kan man behöva ändra IB i nuvarande år
10. **Periodisera räntor < 5 000 kr**: INTE krävt i K1 (förenkling), men för icke-K1-företag är det krav

## When K1 is *not* enough: switch to fullt årsbokslut

K1 räcker oftast, men byt till **fullt årsbokslut** (BFNAR 2017:3) när:
- Omsättning överstiger 3 MSEK
- Du behöver kassaflödesanalys för bankfinansiering
- Du driver gemensamt med en delägare > 3 MSEK (samtliga deklarerar fullt årsbokslut)
- Skattemässiga rapporteringsbehov överstiger K1:s förenklade format

Fullt årsbokslut innehåller:
- Resultaträkning + balansräkning med fullständiga uppställningar
- Tilläggsupplysningar
- (Optional) kassaflödesanalys
- Specifikationsförteckningar

## Implementation checklist för software

If you build bokföringssoftware targeted at EF:
- [ ] Detect omsättning > 3 MSEK → require switch to fullt årsbokslut
- [ ] Force K1-kontoplan struktur när K1 valt
- [ ] Block bokföring av P-fond/expansionsfond mot resultatkonto
- [ ] Allow informationsbokföring 2080/2050/2070 mot 2090 utjämningskonto
- [ ] Generate förenklat årsbokslut layout (SKV 2150 web pattern)
- [ ] Generate NE-bilaga med exakt mappning från B/R/U-poster
- [ ] Track räkenskapsmaterial 7 år
- [ ] Track anläggningsförteckning (datum, tillgång, anskaffningsvärde, livslängd)
- [ ] Force kalenderår räkenskapsår
- [ ] Support kontantmetoden + faktureringsmetoden
- [ ] Allow utelämning av < 5 000 kr fordringar/skulder per BFNAR 2006:1
- [ ] Apply 97% schablonavdrag för inkurans på lager
- [ ] Apply huvudregel/kompletteringsregel for avskrivning, choose lower automatic
- [ ] Surface halv-PBB-cap för förbrukningsinventarier (29 400 kr 2025 / 29 600 kr 2026; halvt PBB enligt IL 18:4, oförändrat sedan Lag 2009:547; K1 6.30)
- [ ] Surface halv-PBB-gränserna för lager (K1 6.47; IL 17:4a) och helavskrivning av avskrivningsunderlag på högst halvt PBB (K1 6.38; IL 18:13), räkenskapsår som inleds efter 2024-12-31 (BFNAR 2025:1)

## Out of scope

- AB-årsredovisning (use `swedish-financial-reporting`)
- Detailed NE-bilaga fält-by-fält (covered separately)
- INK1 huvudblankett (general personal tax form)
- Skatteplanerings-instrument för EF (use `swedish-ef-skatteplanering`)
- Momsdeklaration mekanik (use `swedish-vat`)

## Legal sources

- **BFL 1999:1078**: primary bokföringslagstiftning, especially 4 kap (omfattning), 5 kap (löpande bokföring), 6 kap (årsbokslut), 7 kap (arkivering)
- **BFNAR 2006:1**: K1, det förenklade årsbokslutet för enskild näringsidkare
- **BFNAR 2017:3**: fullt årsbokslut för icke-AB (the K2-EF equivalent)
- **SKV 2150**: Skatteverket's Förenklat årsbokslut blankett
- **SKV 2161**: NE-bilaga (näringsbilaga för enskild näringsverksamhet)
- **BAS 2018 Förenklat årsbokslut kontoplan**: published by BAS-kontogruppen
