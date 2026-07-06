---
id: vertical/e-handel
tier: vertical
title: "E-handel & näthandel (SNI 47.91 / 47.99)"
description: >
  Svensk e-handelsbokföring (SNI 47.91, 47.99) med OSS/IOSS, plattformsclearing Stripe/Klarna/Adyen/PayPal/Shopify Payments, dropshipping-kedjetransaktioner, marketplace deemed supplier enligt 5 kap. 5-6 §§ ML 2023:200 och DAC7-rapportering. Trigga vid frågor om payouts, OSS-deklaration, IOSS-import ≤ 150 EUR, distansförsäljning till EU-konsumenter, reverse charge på Klaviyo/Meta/Google Ireland-fakturor, dropshipping från Kina via Shopify, försäljning via Amazon/eBay/Etsy/CDON/Fyndiq, presentkort/vouchers, ångerrätt, Lager- och E-handelsavtalet, payout-rekonciliering brutto/netto, FX-differens, eller kontoplanmappning för 1580/1581/2670/3106/4515/4535/4545/6040/6050. Distinkta arbetsmönster: brutto/netto-rekonciliering, OSS-tröskelövervakning (99 680 SEK/kalenderår), reverse charge på SaaS/ads, FX-redovisning per provider, periodisering av marketplace-provisioner.
sni_prefixes: ["47.91", "47.99"]
trigger_signals:
  text_patterns:
    - "Stripe payout"
    - "Klarna settlement"
    - "Shopify Payments"
    - "Adyen settlement"
    - "PayPal payout"
    - "OSS-deklaration"
    - "omvänd betalningsskyldighet"
    - "distansförsäljning"
    - "Amazon FBA"
    - "IOSS"
    - "dropshipping"
    - "marketplace"
  bas_account_signals:
    - "1580"
    - "1581"
    - "1980"
    - "2421"
    - "2614"
    - "2615"
    - "2645"
    - "2670"
    - "3106"
    - "3108"
    - "4515"
    - "4535"
    - "4545"
    - "5440"
    - "5710"
    - "6040"
    - "6050"
estimated_tokens: 11000
version: 1
---

# E-handel (SNI 47.91 / 47.99)

## 1. När denna skill ska laddas

Ladda denna skill när huvudboken visar minst två av: (a) konton 1580/1581/2670/3106/4535/6040/6050, (b) leverantörsfakturor från Stripe/Klarna/Adyen/PayPal/Shopify/Klaviyo/Meta/Google Ireland/Amazon Services, (c) OSS-deklaration i agendan, (d) klientens SNI börjar på 47.91 eller 47.99, eller (e) order-/payout-flöden från Shopify, Centra, WooCommerce, Magento eller marketplace-feed. Ladda EJ för ren fysisk butik (SNI 47.1x-47.7x utan distansförsäljning): använd då `detaljhandel`-skillen. För hybrid (butik + e-handel) ladda båda.

## 2. Typiska arbetsmönster

**Faktureringskadens.** Order-driven: en intäktsrad per order vid leveransdatum (BFNAR 2013:2 5 kap., leveransprincipen, ej orderdatum eller betalningsdatum). Vid förskottsbetalning bokförs mottaget belopp på **2420 Förskott från kunder** tills leveransen sker. Vid Klarna Pay Later/Slice it är fordran kvar på **1580/1513** tills Klarna godkänner och betalar ut. Plattformspayouts grupperas typiskt: Stripe dagligen (T+2 SEK, T+7 EUR/USD), Klarna 1-2 gånger/vecka (varierar per avtal), Shopify Payments dagligen, Adyen veckovis, PayPal manuellt eller veckovis, Amazon var 14:e dag (eller efter reserve).

**Kostnadsrytm.** Plattformsavgifter dagligen (per transaktion, debiteras netto från payout), CPC-marknadsföring dagligen (Google/Meta/TikTok faktureras månadsvis i efterhand mot tröskel), fulfilment och utgående frakt per order, SaaS-prenumerationer månadsvis i förskott (Shopify, Klaviyo, Gorgias, Sendcloud, Centra). **Reverse charge på i princip all EU-SaaS och ads**: Klaviyo (IE), Meta Ireland, Google Ireland, Stripe Technology Europe (IE), Shopify International (IE) levererar B2B-tjänster enligt huvudregeln 6 kap. 33 § ML 2023:200; kunden förvärvsbeskattar i Sverige (2614+2645, nettoeffekt 0 vid full avdragsrätt).

**Rekonciliering.** Tre matchningssteg behövs och måste byggas in i avstämningsroutinen: (1) order ledger (Shopify/Centra) ↔ payment provider gross (Stripe/Klarna), (2) provider gross minus avgifter ↔ payout till bank, (3) FX-differens mellan order-kursen och payout-kursen bokas på **3960/7960** vid settlement. Aggregerade dagsbokningar (1 verifikation/dag) tillåtna enligt BFNAR 2013:2 3 kap. 4 § om underlag bevaras digitalt; **kombinerade verifikationer för flera dagar är otillåtna**.

**Lön och kollektivavtal.** Lager- och E-handelsavtalet mellan **Svensk Handel** och **Handelsanställdas förbund**, avtalsperiod **2025-04-01 till 2027-03-31** (tecknat 2025-04-04). Arbetstid kan förläggas må-sö 05-24, begränsningsperiod max 13 veckor, mertidsersättning för deltidsanställda (nyhet 2025), arbetstidsförkortning vid tidiga/sena/helger-pass. Detta är ett *annat* avtal än Detaljhandelsavtalet: e-handelslager som drivs som självständig enhet (även hos hybridföretag) ska ligga under Lager- och E-handelsavtalet.

## 3. BAS 2025: konton denna vertikal lutar sig tungt mot

Tabellen avser BAS 2025 v.1.0 (bas.se/kontoplaner/bas-2025). **Genomgående namnändring 2025: "omvänd skattskyldighet" → "omvänd betalningsskyldighet"** på 2614/2624/2634/2647 och 442x-konton.

| Konto | Officiellt namn (BAS 2025) | E-handel-kontext |
|---|---|---|
| 1580 | Fordringar för kontokort och kuponger | **Clearingkonto Stripe/Klarna/Adyen/PayPal/Shopify Payments**: ej 1684. Lägg upp underkonton 1581-1589 per provider. Saldo = orderintäkt mottagen av provider men ej utbetald till bank. |
| 1513 | Kundfordringar, delad faktura | Klarna Pay Later/Slice it innan settlement, B2B-avbetalningsplaner. |
| 1930 | Företagskonto / checkkonto | Mottagarkonto för payout efter clearing från 1580. |
| 1980 | Valutakonton | EUR/USD-konton för Stripe/PayPal-payouts som ligger kvar i FX innan växling: krav på månadsslutsvärdering till balansdagskurs (ÅRL 4 kap. 13 §). |
| 2420 | Förskott från kunder | Betald order ej levererad: får ej intäktsföras (BFNAR 2013:2 leveransprincipen). |
| 2421 | Ej inlösta presentkort | Skuld för MPV (flerfunktionsvoucher) tills inlösen eller civilrättslig preskription. SPV (enfunktionsvoucher) bokförs som intäkt + moms redan vid försäljning av kortet. |
| 2614 | Utgående moms, omvänd betalningsskyldighet, 25 % | EU-tjänster från Meta/Google/Klaviyo/Shopify (reverse charge) + EU-varuförvärv 4515, **ej** OSS-distansförsäljning. |
| 2615 | Utgående moms import av varor, 25 % | Importmoms vid tullklarering från tredjeland: motbokas mot 2645. |
| 2645 | Beräknad ingående moms på förvärv från utlandet | Motkonto till 2614/2615: nettoeffekt 0 vid full avdragsrätt. |
| 2647 | Ingående moms, omvänd betalningsskyldighet varor och tjänster i Sverige | **Endast** inhemsk omvänd moms (bygg, mobiltelefoner ≥ 100 tkr), sällsynt i ren e-handel. |
| 2650 | Redovisningskonto för moms | Nollställs vid momsdeklaration. |
| 2670 | Utgående moms på försäljning inom EU, OSS | **Kritiskt**: avstämningskonto för OSS-deklarerad moms. Bygg underkonton per destinationsland och momssats för OSS-rapportgenerering. Tillkom i BAS 2024. |
| 3001 / 3002 / 3003 | Försäljning inom Sverige 25/12/6 % | Standard B2C i Sverige; 3003 för e-böcker/digital prenumeration (sänkt 6 % sedan 2019). |
| 3105 | Försäljning varor till land utanför EU | **Export**: UK efter Brexit, USA, Norge, Schweiz. Momsfritt, kräver exportbevis (tulldeklaration eller leveransbevis). |
| 3106 | Försäljning varor till annat EU-land, momspliktig | **OSS-försäljningskontot**: destinationslandets moms redovisas via 2670. |
| 3108 | Försäljning varor till annat EU-land, momsfri | **B2B intracommunity supply**: kräver giltigt VAT-nr i VIES och periodisk sammanställning enligt 35 kap. SFL (materiellt villkor sedan 2020-01-01, 10 kap. 43 § ML). |
| 3305 / 3308 | Försäljning tjänster utanför EU / inom EU | Digital tjänst/SaaS-export; B2C digitala tjänster går via OSS, B2B reverse charge hos kunden. |
| 3520 / 3521 / 3522 | Fakturerade frakter (SE / EU / export) | Kunddebiterad frakt: följer huvudvarans momssats och destinationsregler. |
| 3740 | Öres- och kronutjämning | Avrundningsdifferenser Shopify/Centra → bokföring. |
| 3960 / 7960 | Valutakursvinster/-förluster på fordringar och skulder av rörelsekaraktär | FX-effekt vid Stripe/PayPal-payout-växling. |
| 4515-4518 | Inköp av varor från annat EU-land 25/12/6 %/momsfri | EU-grossistinköp till lager: triggar 2614+2645. |
| 4531 | Inköp av tjänster från ett land utanför EU, 25 % | Reverse charge på US-SaaS (AWS, Cloudflare, Shopify US-fakturering): triggar 2614+2645. |
| 4535 | Inköp av tjänster från annat EU-land, 25 % | **Vanligaste reverse charge-kontot för e-handel**: Klaviyo (IE), Stripe (IE), Meta Ireland, Google Ireland, Shopify International (IE). |
| 4545 | Import av varor, 25 % | Underlag för importmoms vid tullklarering: triggar 2615+2645. |
| 5440 | Förbrukningsemballage | Kartonger, fyllmaterial, tejp, polypåsar, fraktsedeletiketter. |
| 5710 | Frakter, transporter och försäkringar vid varudistribution | PostNord, DHL, Bring, Instabox, Budbee, Schenker: utgående frakt till slutkund. |
| 5720 | Tull- och speditionskostnader | Tullavgifter och DHL/UPS clearance fees, **ej** själva importmomsen. |
| 5970 | Film-, radio-, TV- och Internetreklam | Google/Meta/TikTok/YouTube ads: konceptuellt rätt (5910 också vanlig praxis). |
| 5980 | PR, institutionell reklam och sponsring | Influencer marketing-arvoden. |
| 6040 | Kontokortsavgifter | **Stripe/Adyen/Klarna/PayPal transaktionsavgifter**: konceptuellt korrekt (många bokföringsbyråer använder felaktigt 6570). |
| 6050 | Försäljningsprovisioner | **Marketplace-provisioner**: Amazon referral fees, CDON/Fyndiq, eBay final value, Etsy listing fees. |
| 6062 | Inkasso och KFM-avgifter | Klarna/Qliro-kreditfees, inkasso på obetalda fakturor. |

**Avgörande korrigeringar mot vanliga felmappningar i andra skill-bibliotek:** 1684 är *inte* clearingkontot (det är "fordringar hos leverantörer"): använd **1580**. 2614/2624/2634 är reverse charge, inte OSS: OSS går på **2670 + 3106**. 3108 är EU-B2B *momsfritt*, inte export: export är **3105**. Kontona 4056 och 7920 finns inte i BAS 2025; korrekt är **4535** respektive **6040**. 561x-serien är personbilskostnader, inte logistik: logistik är **57x-serien**.

## 4. Regulatorisk hårddel (högst informationstäthet)

### 4.1 Momsregler unika för e-handel

**OSS: unionsintern distansförsäljning av varor (B2C).** Definition i 2 kap. 7 § ML 2023:200. Leveransort = destinationsland enligt 6 kap. 7 § ML. **Tröskelvärde 99 680 SEK / 10 000 EUR** per **kalenderår** (ej rullande 12 mån) i 6 kap. 62 § ML: gäller endast säljare etablerad enbart i Sverige och avser sammanlagd unionsintern distansförsäljning av varor **plus** TBE-tjänster till alla EU-länder. Tröskeln måste vara underskriden både innevarande och närmast föregående kalenderår. Vid överskridande från och med den transaktion som överskrider: antingen lokal momsregistrering i varje destinationsstat eller unionsordningen (OSS) i 22 kap. ML. Frivillig OSS under tröskeln är möjlig (bindande minst två kalenderår). Ikraftträdande för den EU-gemensamma tröskeln: 2021-07-01 (genom prop. 2019/20:122); överförd till nuvarande paragrafnumrering 2023-07-01.

**IOSS: importordningen.** Definition i 2 kap. 8 § ML. Leveransort i 6 kap. 11 § ML (Sverige om transporten avslutas här och momsen redovisas via IOSS). 22 kap. ML reglerar själva ordningen. Gäller försändelser med **verkligt värde ≤ 150 EUR** (≈ 1 700 SEK enligt Tullverkets TFS 2022:5) exkl. punktskattepliktiga varor. Vid IOSS blir själva importen momsbefriad (10 kap. 65 § ML, art. 143.1 ca direktivet) och säljaren tar ut destinationslandets moms vid kassan. **22 EUR-import-frigränsen avskaffades 2021-07-01.** EU-grund: rådets direktiv (EU) 2017/2455 och 2019/1995. Saknas IOSS-nummer tas importmomsen ut av Tullverket vid gränsen från mottagaren/transportören.

**Marketplace deemed supplier.** Två fall i ML 2023:200: **5 kap. 5 §**: plattform anses ha köpt och sålt vid distansförsäljning av importerade varor ≤ 150 EUR via elektroniskt gränssnitt; **5 kap. 6 §**: plattform anses ha köpt och sålt vid leverans inom EU från icke-EU-etablerad säljare till EU-konsument (oavsett om transporten är gränsöverskridande eller inom samma EU-land). Transportallokering i 6 kap. 17 § ML. Beskattningsgrundande händelse = när betalningen godkänns (7 kap. ML, art. 66a direktivet). Bakomliggande säljarens leverans till plattformen är undantagen (10 kap. ML, art. 136a). **Skatteverkets ställningstagande dnr 8-1293055 (2021-10-29, uppdaterat 2023-06-26)**: deemed supplier-reglerna omfattar inte förmedling i eget namn (då gäller 5 kap. 4 § ML); varorna måste fysiskt befinna sig inom EU när betalningen godkänns för 5 kap. 6 §; vid flerstegsförsäljning av importerade varor ≤ 150 EUR hänförs transporten till sista ledet. Se även **HFD mål nr 5815-22 (2023-02-24)** för kriterier kring "förmedling i eget namn".

**Dropshipping och kedjetransaktioner.** 6 kap. 14-17 §§ ML 2023:200 (motsvarar tidigare GML 5 kap. 2 e §). Huvudregel i 6 kap. 15 §: transporten hänförs till leveransen *till* mellanhanden. Undantag: om mellanhanden meddelat säljaren sitt VAT-nr **i avgångslandet** hänförs transporten till leveransen *från* mellanhanden. Detta är "Quick Fixes"-regeln (direktiv (EU) 2018/1910, art. 36a), ikraft i Sverige **2020-01-01** genom prop. 2018/19:160. Förenklingsregeln för trepartshandel kräver att alla tre parter är momsregistrerade i var sitt EU-land (10 kap. ML, art. 141 direktivet). Vid dropshipping från tredjeland direkt till EU-konsument med plattform i kedjan: se dnr 8-1293055: transporten hänförs till sista ledet.

**Returer och kreditfakturor (cross-border).** 8 kap. 14 § ML 2023:200 (prisnedsättning efter tillhandahållande minskar beskattningsunderlaget). 8 kap. 15 § ML (återtagande av vara vid avbetalningsköp). 17 kap. ML (kreditnotans formkrav). Vid OSS-försäljning korrigeras OSS-deklarationen genom justering i en senare period med hänvisning till ursprunglig deklaration enligt 22 kap. ML och kommissionens genomförandeförordning (EU) 2020/194. EU-grund: art. 90.1 direktivet 2006/112/EG.

**Vouchers: enfunktion vs flerfunktion.** 2 kap. 26-27 §§ ML (definitioner). 5 kap. 40-44 §§ ML (beskattningsbara transaktioner): kontrollera konsoliderad version efter SFS 2024:942-renumreringen från 2025-01-01. **SPV (enfunktion)**: beskattningsland och momssats kända vid utställandet → moms vid varje överlåtelse. **MPV (flerfunktion)**: moms först vid inlösen. Distributionstjänster för MPV är separat momspliktiga. EU-grund: rådets direktiv (EU) 2016/1065 (voucher-direktivet), implementerat i Sverige **2019-01-01**. Skatteverkets vägledning: **dnr 202 488720-18/111 (2018-11-26)** och **dnr 202 508158-18/111 (2018-12-06)**: fortsatt giltiga med paragrafnyckel till ML 2023:200.

**B2B-identifiering via VIES.** 10 kap. 42-43 §§ ML 2023:200: momsfri unionsintern leverans kräver (1) köpare beskattningsbar/juridisk person med momsregistrering i annat EU-land, (2) **giltigt VAT-nr verifierat i VIES**, (3) korrekt periodisk sammanställning enligt 35 kap. SFL. Dessa är **materiella** villkor sedan 2020-01-01 (Quick Fixes, direktiv (EU) 2018/1910), ej längre enbart formella. Saknas giltigt VAT-nr → svensk moms ska tas ut.

### 4.2 Bokföringsregler unika för e-handel

**Tidpunkt för intäktsredovisning.** BFNAR 2013:2 (om bokföring) 5 kap.: leveransprincipen styr; det är inte orderdatum eller betalningsdatum. För K2-företag preciserat i BFNAR 2016:10 3 kap. 4-7 §§ (rätten till ersättning övergår vid leverans/utförande). Vid förskott (betald order, ej levererad): **2420 Förskott från kunder**, ingen intäkt och ingen utgående moms vid mottagandet (moms uppkommer först vid leverans, undantag: enfunktionsvoucher beskattas vid utställandet).

**Kassaregister-undantaget.** Lag (2007:592) **upphävdes 2012-01-01** av SFS 2011:1244: gällande regler i **39 kap. skatteförfarandelagen (2011:1244)**. **39 kap. 5 § SFL undantar ren e-handel** (distansavtal enligt 2005:59). Hybridfall: självständiga verksamheter bedöms var för sig: om fysisk butik tar emot kontant/kort/Swish över 4 prisbasbelopp/år krävs kassaregister för butiksdelen, men e-handelsdelen är undantagen. Click-and-collect där betalning sker online räknas som distansavtal; betalning vid hämtning i butik räknas som fysisk handel.

**Periodisering av plattformsavgifter.** Procentbaserade avgifter (Stripe 1,4 % + 1,80 kr för EEA-kort etc.) periodiseras till samma period som transaktionen genererades, även om de debiteras netto i nästa payout. Månatliga SaaS-avgifter och fasta plattformsavgifter periodiseras månadsvis (interimsskuld eller -fordran om faktureringsperiod ej följer kalendermånad).

**Lagerredovisning vid dropshipping.** Säljaren äger aldrig lagret → ingen lagervärdering enligt BFNAR 2016:10 (K2) eller BFNAR 2012:1 (K3). Vid hybridmodell (eget lager + dropship-sortiment) ska dropship-sortimentet inte ingå i lagervärdet vid bokslut.

**Plattformsclearing: brutto vs netto.** Bokföringsmässigt och momsmässigt **brutto-princip krävs**: full försäljning på 3001/3106 etc., utgående moms separat, plattformsavgift som separat kostnad på 6040 eller 6050. Detta är inte förhandlingsbart: Skatteverket kräver bruttoredovisning för moms (1 kap. ML; jfr även BFL 5 kap. 6 § om netto-bokning bara där intäkt och kostnad har klart samband med samma transaktion och nettot är obetydligt). Stripe-avgifter har inte momsmässigt samband med varuförsäljningen.

### 4.3 Sektorlagar

**Distansavtalslagen: lag (2005:59) om distansavtal och avtal utanför affärslokaler.** Ångerrätt 14 dagar (**2 kap. 10 §**), fristens början (2 kap. 12 §), förlängd frist upp till 12 mån vid informationsbrist (2 kap. 2 §), undantag från ångerrätt (2 kap. 11 §: specialtillverkade, livsmedel, lösnummer, plomberade hygienartiklar, evenemangsbiljetter, digitalt innehåll efter levererad fullgörelse). Återbetalning inom 14 dagar (2 kap. 14 §). Värdeminskningsavdrag (2 kap. 15 §). Online-marknadsplatser har särskilda informationskrav i 2 kap. 2 a § (näringsidkare vs privatperson, rankningskriterier). **SFS 2026:246** inför 19 juni 2026 krav på "ångerknapp" i onlinegränssnitt.

**Konsumentköplagen (2022:260).** Ikraft 2022-05-01, ersätter KKL 1990:932. Genomför direktiv (EU) 2019/771 och 2019/770. Reklamationstid/näringsidkaransvar **3 år från avlämnandet** (4 kap. 14 §). **Omvänd bevisbörda 2 år** (4 kap. 17 §): fel som visar sig inom 2 år presumeras ha funnits vid avlämnandet (höjt från 6 månader). Uppdateringsskyldighet på varor med digitala delar (4 kap. 4 §). 9 kap. reglerar digitalt innehåll/digitala tjänster, inkl. avtal där betalningen utgörs av personuppgifter (9 kap. 7 §).

**E-handelslagen: lag (2002:562) om elektronisk handel.** Informationskrav om tjänsteleverantören i 8-9 §§ (namn, org.nr, gatuadress, e-post, momsregnr, ev. registrering). Beställningskrav i 10-11 §§ (tekniska steg, möjlighet att upptäcka och rätta inmatningsfel, språk, sparbar varaktig form av villkor). Bekräftelse utan dröjsmål (12 §). Påföljd via marknadsföringslagen (15 §).

**GDPR (EU) 2016/679** + kompletterande lag (2018:218). Rättslig grund för kundregister: avtalsuppfyllelse (köp): art. 6.1 b; berättigat intresse (befintliga kunder, marknadsföring): art. 6.1 f; samtycke (nyhetsbrev till nya kontakter, cookies utanför funktionella): art. 6.1 a. Lagringsbegränsning art. 5.1 e: kundregister får inte sparas längre än nödvändigt; **bokföringslagens 7-årskrav på räkenskapsinformation (BFL 7 kap. 2 §) är specialregel** och tar över för fakturor/orderdata. Biträdesavtal (art. 28) med Shopify, Klaviyo, Stripe, fraktbolag, ESP. Cookies regleras via LEK (2022:482).

**Marknadsföringslagen (2008:486).** 5 § (god marknadsföringssed), 7 § (aggressiv), 8 § (transaktionstest), 10 § (vilseledande), 12 § (köperbjudande). Omnibus-ändringar **ikraft 2022-09-01** (ej 2023-01-01, vanligt felaktigt datum): **12 c §** transparenskrav vid konsumentrecensioner; svarta listan p. 23a-23c (förbud mot falska/manipulerade recensioner, oavslöjade betalda placeringar). **Prisinformationslagen (2004:347) 7 a §**, 30-dagars-regeln: vid prissänkning ska lägsta pris under senaste 30 dagarna anges. Sanktionsavgift upp till **4 % av årsomsättningen** för flagranta överträdelser (Omnibus).

**Penningtvättslagen (2017:630).** **Ren varuförsäljning omfattas normalt INTE**: tröskeln 15 000 EUR för varuförsäljning togs bort genom SFS 2019:608/774. Plattform som tillhandahåller betaltjänster, escrow, peer-to-peer-överföringar eller e-pengar omfattas dock som verksamhetsutövare (1 kap. 2 § p 8/9). Konstförmedling ≥ 10 000 EUR omfattas alltid. Krypto-tillgångar omfattas.

**Produktsäkerhet.** **GPSR: förordning (EU) 2023/988** tillämpas **från 2024-12-13** och är direkt tillämplig; ersätter direktiv 2001/95/EG. Lag (2004:451) gäller fortsatt för tjänster och för varor som släpptes ut på marknaden före 2024-12-13. För e-handel: krav på spårbarhet av säljare (artikel 9), informationskrav vid distansförsäljning (artikel 19), återkallelse­procedurer.

### 4.4 EU-regler (utöver moms-paketet)

**DAC7: direktiv (EU) 2021/514.** Svensk transponering: **lag (2022:1681)** om plattformsoperatörers inhämtande av vissa uppgifter (POL) + **lag (2022:1682)** om automatiskt utbyte + förordningar 2022:1692 och 2022:1693 + **22 c kap. skatteförfarandelagen**. Ikraft 2023-01-01; första rapportering **2024-01-31** för år 2023. Omfattar plattformar som förmedlar uthyrning av fast egendom, personliga tjänster, försäljning av varor, uthyrning av transportmedel. Säljarundantag för varor: **färre än 30 transaktioner OCH högst 2 000 EUR** per kalenderår (båda måste vara uppfyllda). Plattformsavgift **2 500-12 500 kr** per utebliven/felaktig kontrolluppgift. Dokumentationsbevarande 7 år (POL 6 kap. 14 §).

**Geoblocking: förordning (EU) 2018/302** + kompletterande lag (2019:59).

**P2B: förordning (EU) 2019/1150.** Krav på online-marknadsplatser gentemot säljare: tydliga villkor (art. 3), 15 dagars notice vid ändring, 30 dagars varsel vid suspension (art. 4), rankningstransparens (art. 5), internt klagomålssystem (art. 11).

**DSA: förordning (EU) 2022/2065.** Tillämpas fullt ut **från 2024-02-17**. Marknadsplatser som möjliggör B2C-avtal har särskilda krav: KYBC (art. 30, spårbarhet av säljare), transparens om reklam, mekanismer för rapportering av olagligt innehåll/produkter. Sanktion upp till 6 % av global årsomsättning. Tillsyn: PTS (samordnare), Mediemyndigheten, Konsumentverket.

**Omnibus-direktivet (EU) 2019/2161.** Genomfört genom prop. 2021/22:174: ikraft **2022-09-01** (vissa delar 2022-05-28 via svarta listan).

### 4.5 Skatteverket-ställningstaganden och HFD (2020-2025)

| Typ | Dnr / Mål nr | Datum | Ämne |
|---|---|---|---|
| SKV ställningstagande | **8-1293055** | 2021-10-29 (uppd. 2023-06-26) | Plattformsförsäljning / deemed supplier 5 kap. 5-6 §§ ML: transportallokering vid flerstegsförsäljning av importerade varor ≤ 150 EUR |
| SKV ställningstagande | **8-2059749** | 2022-12-19 | Elektroniska tjänster via marknadsplatser: presumtion om förmedlare som säljare (art. 9a genomförandeförordning 282/2011) |
| SKV ställningstagande | **8-5507** | 2020-01-13 | Betaltjänster och undantaget från skatteplikt: momsfri endast vid rättsliga/ekonomiska förändringar mellan betalare och mottagare; rena tekniska/administrativa tjänster är momspliktiga (avgör avdragsrätt på Stripe/Klarna/Adyen-avgifter) |
| SKV ställningstagande | **8-314934** | 2020-09-25 | Förmedling av tjänster i eget vs annans namn |
| SKV ställningstagande | **8-498120** | 2020-09-25 | Förmedling av varor i annans namn |
| SKV ställningstagande | **202 488720-18/111** | 2018-11-26 | Vouchers (SPV/MPV): fortsatt giltigt under ML 2023:200 |
| SKV ställningstagande | **202 508158-18/111** | 2018-12-06 | Fakturering och redovisning av vouchers |
| SKV ställningstagande | **8-155570-2025** | 2025-05-02 | Betalningsskyldig för importmoms: deklaranten i tulldeklarationen redovisar i sin momsdeklaration (gemensamt SKV/Tullverket) |
| HFD-dom | **Mål nr 5815-22** | 2023-02-24 | Vårdplattform: kriterier för "förmedling i eget namn" (analogt tillämpbart på e-handelsplattformar) |
| HFD-dom | **Mål nr 4610-21** | 2022-01-07 | Mellanbanksavgifter / kortinlösen: inlösentjänst momsfri; mellanbanksavgift ej ersättning för tjänst |
| HFD 2023 ref. 45 | **Mål nr 7254-7255-22** | 2023-10-16 | Omsättningsbaserad fördelningsgrund vid blandad verksamhet: direkt effekt av art. 173-174 direktivet |

## 5. De tre högsta felfrekvensscenarierna

### 5.1 OSS-tröskel överskriden: fortsatt svensk moms i kassan
**Fel:** Säljaren passerar 99 680 SEK i samlad EU-B2C-omsättning (varor + TBE-tjänster) och fortsätter ta ut 25 % svensk moms på order till EU-konsumenter. Bokföring kvar på 3001 + 2611.
**Rätt:** Från och med **den transaktion som överskrider tröskeln** beskattas i destinationsland (6 kap. 7 § + 6 kap. 63 § ML 2023:200). Antingen registrera i unionsordningen (OSS, 22 kap. ML) via Skatteverket e-tjänst eller momsregistrera i varje destinationsstat. Bokföringsmässigt: bruttointäkt på **3106** per destinationsland, destinationslandets moms på **2670** med underkonto per land/sats. Kvartalsvis OSS-deklaration i SEK omräknad till EUR enligt ECB-kursen sista dagen i deklarationsperioden. Korrigering vid retur sker i senare OSS-period med referens till ursprunglig deklaration (kommissionens genomförandeförordning (EU) 2020/194).
**Lagstöd:** 6 kap. 7, 62-65 §§ ML 2023:200; 22 kap. ML; prop. 2019/20:122.

### 5.2 Plattformspayouts (Stripe/Klarna/Adyen) bokförda netto
**Fel:** Daglig payout om 87 600 SEK (efter 2 400 SEK Stripe-avgift på 90 000 brutto) bokförs i sin helhet som 3001 + 2611 → omsättning underskattas, ingående moms på den momspliktiga delen av Stripe-tjänsten missas, marketplace-provisioner från Amazon/CDON syns inte i resultaträkningen som kostnad.
**Rätt:** Brutto-redovisning krävs. Stegvis: (a) vid orderbekräftelse/leverans bokas brutto försäljning 3001 (eller 3106 för OSS) + utgående moms 2611/2670 mot fordran **1580/1581** per provider; (b) avgiften bokas separat som kostnad på **6040** (kontokortsavgifter, Stripe/Adyen/Klarna) eller **6050** (marketplace-provisioner Amazon/CDON/Fyndiq/eBay): reverse charge på EU-providers (Stripe Technology Europe IE, Klarna SE → ingen RC, Adyen NL) tillämpas på den momspliktiga komponenten enligt dnr 8-5507; (c) faktisk bankpayout bokas mot 1580 → 1930; (d) FX-differens på fordringskontot vid settlement bokas på 3960/7960. **HFD mål 4610-21 (2022-01-07)** stödjer att kortinlösen är momsfri men närliggande tekniska tjänster är momspliktiga: uppdelning krävs ofta. Vid fakturaspecifikation från providern följ deras momsklassificering per komponent.
**Lagstöd:** Bruttoprincip 1 kap. ML 2023:200; BFL 5 kap. 6 §; dnr 8-5507 (2020-01-13); HFD mål 4610-21.

### 5.3 Dropshipping från tredjeland direkt till EU-konsument utan korrekt kedjeanalys
**Fel:** Svensk säljare via Shopify har leverantör i Kina som skickar varan direkt till tysk konsument. Säljaren bokför som svensk inhemsk försäljning med 25 % svensk moms, eller alternativt som momsfri export. Inget av detta är korrekt.
**Rätt:** Tre scenarier kräver olika hantering. **(A) Varuvärde > 150 EUR, ingen plattform som deemed supplier:** importen sker i destinationslandet (Tyskland), tysk importmoms erläggs av mottagaren eller av säljaren om DDP-leverans: kan trigga tysk momsregistreringsskyldighet. Säljarens "leverans" är gjord utomlands (6 kap. 3 § ML, transport börjar utanför EU) och ligger utanför svensk moms. **(B) Varuvärde ≤ 150 EUR, säljaren använder IOSS:** moms tas ut vid kassan med destinationslandets sats, redovisas månatligt via importordningen (22 kap. ML); själva importen är momsbefriad (10 kap. 65 § ML). Bokföringsmässigt: intäkt 3106 + utgående moms 2670 per destinationsland. **(C) Försäljning sker via deemed supplier-plattform (Amazon, Etsy, eBay) ≤ 150 EUR:** plattformen blir momsskyldig enligt 5 kap. 5 § ML, säljarens leverans till plattformen är undantagen (10 kap. ML, art. 136a direktivet). Vid kedjetransaktion inom EU tillämpas 6 kap. 14-17 §§ ML (Quick Fixes): VAT-nr i avgångslandet styr transporttilldelningen.
**Lagstöd:** 5 kap. 5-6 §§, 6 kap. 3, 11, 14-17 §§, 10 kap. 65 § ML 2023:200; dnr 8-1293055 (2021-10-29); direktiv (EU) 2017/2455, 2018/1910, 2019/1995.

## 6. Öppna frågor (flaggade för mänsklig granskning)

- **Amazon FBA och PAN-EU FBA**: Ingen specifik dnr-baserad vägledning från Skatteverket per 2025-05. Överföring av egna varor till annat EU-lager utlöser lokal momsregistreringsskyldighet (förvärv lika med) och OSS kan användas parallellt för försäljning från utländskt lager till andra EU-länder, men gränsdragningen och rapporteringen i bokföringssystemet kräver klientspecifik granskning.
- **Triangulär handel via deemed supplier-plattform**: ingen separat ställningstagande: analys måste göras genom kombination av dnr 8-1293055 och kedjetransaktionsreglerna i 6 kap. 14-17 §§ ML.
- **Aktörsspecifika momsbedömningar Stripe/Klarna/Adyen/PayPal/Mollie**: Skatteverket har inte publicerat aktörsspecifika ställningstaganden. Bedömning sker per komponent på respektive fakturaspecifikation utifrån dnr 8-5507. Klarnas svenska entitet (Klarna Bank AB) faktureras utan reverse charge; Stripe Technology Europe (IE) och Adyen NV (NL) faktureras med reverse charge: verifiera per aktuell faktura.
- **Värdering vid 150 EUR-gränsen (rabattkoder, frakt, valutaomräkning)**: ingen tydlig SKV-vägledning per 2025-05. Tullverkets praxis: verkligt värde exkl. frakt/försäkring/skatter motsvarar tullfrihetsförordningens definition.
- **6040 vs 6570 vs 6050** för payment provider fees: branschpraxis är delad. Denna skill rekommenderar 6040 för Stripe/Adyen/Klarna (kontokortsavgifter, konceptuellt korrekt) och 6050 för marketplace referral fees, men 6570 förekommer brett och är försvarbart om klienten redan konsekvent använder det.
- **SFS 2024:942-renumrering** av voucher-paragrafer i 5 kap. ML från 2025-01-01: verifiera konsoliderad version på riksdagen.se före produktionsdeploy.
- **BAS 2026**: BAS-intressenternas Förening har aviserat större ändringar 2026 (Framtidens kontoplan). Versionshantera kontoplanen i koden.
- **Reverse charge-tillämpning på Klarna-avgifter**: Klarna Bank AB (SE) fakturerar inkl. svensk moms; Klarna Inc/övriga utländska entiteter med RC. Identifiera entiteten per faktura, inte per varumärke.

## Referensfiler

- `references/oss-ioss-mekanik.md`: fullständig OSS-/IOSS-deklarationsmekanik, ECB-kurs, korrigeringar, registreringsförfarande
- `references/payment-providers.md`: provider-för-provider-mapping (Stripe/Klarna/Adyen/PayPal/Shopify Payments/Mollie/Qliro) av fee-struktur, payout-cykel, momsbehandling per komponent, BAS-konton
- `references/dropshipping-kedjetransaktioner.md`: beslutsschema för dropshipping (varuvärde × destinationsland × plattformsstatus → korrekt momsbehandling)
- `references/marketplace-deemed-supplier.md`: Amazon FBA/PAN-EU, eBay, Etsy, CDON, Fyndiq, när 5 kap. 5-6 §§ ML triggas, säljarens bokföring
- `references/dac7-rapportering.md`: POL/LAUP-mekanik, vilka plattformar omfattas, kontrolluppgifter KU90-KU93
- `references/vouchers-presentkort.md`: SPV/MPV-beslutsmatris, BAS-konton, redovisningstidpunkt
- `references/konsumentratt.md`: DAL 2005:59, KKL 2022:260, MFL/Omnibus, prisinformation 30-dagars, ångerknapp SFS 2026:246
- `references/kollektivavtal-lager-e-handel.md`: fullständigt 2025-2027-avtal, OB-tabell, arbetstidsregler, mertidsersättning
- `references/skv-stallningstaganden-katalog.md`: fullständig katalog över relevanta dnr 2018-2025 med paragrafnyckel GML↔ML 2023:200
