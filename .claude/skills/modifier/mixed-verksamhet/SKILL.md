---
id: modifier/mixed-verksamhet
tier: modifier
title: "Blandad verksamhet (moms-split)"
description: >
  Modifier for any Swedish legal entity with BOTH momspliktig and momsfri omsättning in the same juridisk person, cross-SNI. Use whenever the books touch blandad verksamhet, proportionell avdragsrätt, fördelningsnyckel, skälig grund, jämkning/justering av avdrag, frivillig skattskyldighet/beskattning, mixed VAT, partial VAT recovery, holdingbolag avdragsrätt, lokaluthyrning moms, jämkningshandling/justeringshandling, uppförandeskede, retroaktivt avdrag, ML 13 kap 29 §, ML 15 kap, ML 12 kap, HFD 2023 ref. 45, or any chart of accounts showing both 2649 plus momsfri 3xxx-konton (3911, 3004) or both 3911 and 3913 hyresintäkter. Also triggers on questions about how to split input VAT between taxable and exempt activities, holding-company VAT deduction, property leasing VAT, voluntary tax liability, or 10-year/5-year adjustment periods for investment goods.
sni_prefixes: ["64", "65", "66", "68.20", "85", "86", "87", "88", "94"]
trigger_signals:
  vat_split: true
  text_patterns:
    - "fördelningsnyckel"
    - "proportionell avdragsrätt"
    - "skälig grund"
    - "jämkning"
    - "justering av avdrag"
    - "frivillig skattskyldighet"
    - "frivillig beskattning"
    - "blandad verksamhet"
    - "ej avdragsgill ingående moms"
    - "delvis avdragsrätt"
    - "omsättningsbaserad fördelning"
    - "jämkningshandling"
    - "justeringshandling"
    - "uppförandeskede"
    - "retroaktivt avdrag"
  bas_account_signals:
    - "2642"
    - "2649"
    - "6999"
    - "2613"
    - "3913"
    - "3911"
    - "1110"
    - "1220"
    - "3004"
    - "8210"
estimated_tokens: 4800
version: 1
---

# Swedish blandad verksamhet: moms-specifika regler

## 1. När denna skill ska användas

Aktiveras när huvudboken visar BÅDE momspliktig omsättning (3001/3002/3003/3913 med utgående moms 2611/2613) OCH momsfri omsättning (3004, 3911, undantagna tjänster per ML 10 kap NML) i samma juridiska person. Aktiveras också vid: registrerad frivillig beskattning för fastighetsupplåtelse (ML 12 kap NML); förvärv av investeringsvara ≥100 000 kr ingående moms (fastighet) eller ≥50 000 kr (lös egendom); holdingbolag med utdelningar + management fees; ideell förening med både bidragsfinansierad och momspliktig verksamhet; bostadsrättsförening med lokaluthyrning under frivillig beskattning. Skillen täcker INTE generella momsregler: se horisontal skill `swedish-vat`.

## 2. Typiska arbetsflödesmönster

**Fakturering.** Två parallella fakturaströmmar måste hållas isär på radnivå. Tagga varje rad vid utfärdande: momspliktig (3001/3002/3003 + 2611/2621/2631 eller 3913 + 2613), momsfri inom Sverige (3004), undantagen (specifika konton per undantagskategori, sjukvård, utbildning, finansiella tjänster). Vid blandade kundkontrakt (t.ex. lokalhyra + bostadshyra till samma hyresgäst): separera per yta i avtalet och bokför per kostnadsställe.

**Kostnadshantering.** Varje leverantörsfaktura ska klassas i tre kategorier vid kontering:
(a) **Direkt hänförlig till momspliktig verksamhet** → full avdrag på 2641;
(b) **Direkt hänförlig till momsfri verksamhet** → momsen kostnadsförs (ingen 26xx);
(c) **Gemensam kostnad** → hela momsen på 2649 löpande; vid bokslut/månadsavstämning splittras 2649 enligt aktuell fördelningsnyckel: avdragsgill del → 2650, resten → 6999.

Den vanligaste felklassificeringen är att (c) felaktigt behandlas som (a). Endast (c) får fördelningsnyckel.

**Avstämning.** Preliminär fördelningsnyckel används löpande under året (baserad på föregående års utfall eller budget). Vid bokslut görs **årlig avstämning** mot faktiskt utfall: slutlig fördelningsnyckel räknas på årsomsättning, retroaktiv justering bokförs i sista perioden. Detta är obligatoriskt; månadsvis "korrekt" fördelning utan slutlig årlig justering är inte tillåtet. Jämkning/justering av investeringsvaror redovisas i första redovisningsperioden EFTER räkenskapsårets utgång (ML 15 kap NML).

**Lönefördelning.** Specifikt för blandad verksamhet: när anställdas tid fördelas mellan momspliktig och momsfri verksamhetsgren utgör detta inte i sig en momsfråga, men tidredovisningen kan fungera som **alternativ fördelningsnyckel** ("tid") för gemensamma kostnader om omsättning ger ett missvisande resultat och den skattskyldige väljer att tillämpa skälig grund.

## 3. BAS 2025-konton specifika för blandad verksamhet

Verifierade mot bas.se BAS 2025. **Vanlig felaktig uppfattning att 2647 = blandad verksamhet är fel**: 2647 är "Ingående moms, omvänd betalningsskyldighet varor och tjänster i Sverige". **Blandad-verksamhet-kontot är 2649.**

| Konto | BAS 2025-namn | Användning vid blandad verksamhet |
|---|---|---|
| **2649** | Ingående moms, blandad verksamhet | Hela momsen på gemensamma kostnader debiteras 2649; splittas vid avstämning till 2650 + 6999 |
| **6999** | Ingående moms, blandad verksamhet | Kostnadssida: den icke-avdragsgilla delen av 2649 |
| **2642** | Debiterad ingående moms i anslutning till frivillig betalningsskyldighet | Ingående moms hänförlig till frivillig beskattning för lokaluthyrning (12 kap NML) |
| **2613** | Utgående moms för uthyrning, 25 % | Utgående moms på frivilligt momspliktig lokalhyra |
| **2648** | Vilande ingående moms | Bokslutsmetod; även vid pågående jämkning under räkenskapsår |
| **3913** | Frivilligt momspliktiga hyresintäkter | Lokalhyra under frivillig beskattning (ej "lokaler momspliktig") |
| **3914** | Övriga momspliktiga hyresintäkter | Korttidsuthyrning, parkering, garage (momspliktigt utan frivillig beskattning) |
| **3911** | Hyresintäkter | Bostadsuthyrning och annan momsfri hyra (ej "hyresintäkter momsfria") |
| **3912** | Arrendeintäkter | Arrende (momsfritt som regel) |
| **3004** | Försäljning inom Sverige, momsfri | Momsfri tjänsteförsäljning inom Sverige |
| **1110/1119** | Byggnader / Ackumulerade avskrivningar byggnader | Investeringsvara ≥100 tkr ingående moms → 10 års justeringsperiod |
| **1220/1229** | Inventarier och verktyg / Ackumulerade avskrivningar | Investeringsvara ≥50 tkr ingående moms → 5 års justeringsperiod |
| **8010/8210** | Utdelning på andelar i koncernföretag / andra företag | **Exkluderas från omsättningsbaserad fördelningsnyckel** (Cibo C-16/00) |
| **8250/8310** | Ränteintäkter (långfristiga / omsättningstillgångar) | Bitransaktioner exkluderas från fördelningsnyckel (art. 174.2 momsdirektivet) |

## 4. Regelverk unikt för blandad verksamhet

### 4.1 Mervärdesskatt: kärnregler med dubbel paragrafhänvisning

Ny ML (2023:200) trädde ikraft 1 juli 2023 och ersatte ML (1994:200). Terminologi: "jämkning" → "justering", "korrigeringstid" → "justeringsperiod", "jämkningshandling" → "justeringshandling". Substansen är i allt väsentligt oförändrad. Citera båda numreringarna i juridiska skrivelser; default till NML-numrering framåt.

**Proportionell avdragsrätt och fördelning efter skälig grund.** ML (1994:200) 8 kap 13 § och 14 § → ML (2023:200) **13 kap 29 § första och andra stycket**. Första stycket: vid gemensamma förvärv där avdragsrätt delvis saknas får avdrag endast göras för avdragsgill del. Andra stycket: om den avdragsgilla delen inte kan fastställas får uppdelning ske efter skälig grund.

**HFD 2023 ref. 45** (mål 7254-7255-22, meddelad 16 oktober 2023, "VW Finans-målet") är landmärket. HFD slog fast att (i) 13 kap 29 § ML inte uppfyller EU-direktivets krav på tydlighet/precision/klarhet för att införliva art. 173.2 c momsdirektivet 2006/112/EG; (ii) artiklarna **173.1 och 174 har direkt effekt**: den skattskyldige kan välja omsättningsbaserad pro rata-metod oavsett om Skatteverket anser att en annan metod (sektor, yta, tid) ger ett mer exakt resultat; (iii) HFD 2014 ref. 18 I:s formulering om "den fördelningsgrund som ger ett mer exakt resultat" kan inte längre användas MOT den skattskyldige. Skatteverket bekräftade i ställningstagande **dnr 8-2749853 (2024-02-02)** "Uppdelning av ingående mervärdesskatt" som ersatte tidigare dnr 131 446423-15/111. Tre HFD-domar 2025-06-24 (mål 7071-24, 7072-24, 7273-24) samt **HFD 2025 not. 29** bekräftade att direkt effekt gäller även när inköpet delvis omfattas av avdragsförbudet för stadigvarande bostad.

**EU-praxis som binder svensk tillämpning.**
- C-4/94 BLP Group: "direkt och omedelbart samband"-testet.
- C-16/00 Cibo Participations: aktivt holdingbolags förvärvskostnader = allmänna omkostnader; utdelningar är utanför momsens tillämpningsområde.
- C-437/06 Securenta: tvåstegsavdrag, först fördelning mellan ekonomisk och icke-ekonomisk verksamhet, sedan pro rata.
- C-29/08 AB SKF: avdrag för rådgivning vid dotterbolagsavyttring kan medges som allmän omkostnad.
- C-108/14 + C-109/14 Larentia + Minerva: managementholdingbolag har som huvudregel full avdragsrätt.
- C-126/14 Sveda: avdrag möjligt även för anläggning som direkt används gratis av tredje man om den är medel för momspliktiga utgående transaktioner.
- C-132/16 Iberdrola: avdrag för arbeten på tredje mans fastighet om nödvändiga för egen momspliktig verksamhet.
- C-42/19 Sonaecom: avbruten förvärvstransaktion ger avdrag baserat på avsikt; faktisk momsfri användning bryter avdragsrätten.
- C-787/18 Sögård Fastigheter: svensk regel om automatiskt övertagande av jämkningsskyldighet vid ren fastighetsöverlåtelse strider mot EU-rätten: bekräftat i HFD 2021 not. 26-27.

**Frivillig beskattning för fastighetsupplåtelser.** ML (1994:200) 9 kap → ML (2023:200) **12 kap**, särskilt 12 kap 5 § (förutsättningar), 12 kap 18 § (anmälningsskyldighet), 12 kap 20-21 § (uppförandeskede). Förutsättning: stadigvarande uthyrning till hyresgäst med transaktioner som medför avdragsrätt (eller stat/kommun/kommunalförbund utan momspliktigt krav). Frivillig beskattning sker numera **genom att moms debiteras på fakturan**: ingen ansökan utom under uppförandeskede (blankett SKV 5704). Stadigvarande bostad är alltid undantagen.

**Jämkning av investeringsvaror.** ML (1994:200) 8a kap → ML (2023:200) **15 kap**. Definition 15 kap 4 §: maskiner/inventarier med ingående moms ≥**50 000 kr**, fastigheter med ingående moms ≥**100 000 kr** under ett beskattningsår. Justeringsperiod 15 kap 10 §: **10 år** fastigheter, **5 år** lös egendom, räknas från det räkenskapsår tillgången förvärvades/togs i bruk. Utlösande händelser (15 kap 6-9 §§): ändrad användning, överlåtelse, övergång till/från frivillig beskattning, konkurs, övergång till skattebefrielse. Förenklingsregel: ingen jämkning om förändring i avdragsrätt <5 procentenheter. Full mekanik och worked examples i `references/jamkning-mechanics.md`.

**Övertagande av justeringsskyldighet.** 15 kap 20 § (verksamhetsöverlåtelse) och 15 kap 21 § (fastighetsöverlåtelse) NML. EFTER C-787/18 Sögård tillämpar Skatteverket INTE 15 kap 21 § på rena fastighetsöverlåtelser: säljaren slutjämkar för återstoden. Vid verksamhetsöverlåtelse (TOGC) gäller övertagande fortfarande. SKV ställningstagande **dnr 8-2349336 (2023-05-12)** "Jämkningshandling vid vissa fastighetsöverlåtelser" anger formkrav. Detaljer i `references/frivillig-skattskyldighet-fastighet.md`.

**Undantag från skatteplikt: sektorkonton.**
- Finansiella tjänster: ML 3 kap 9 § GML → **10 kap 33 § NML**.
- Försäkring: 3 kap 10 § GML → **10 kap 32 § NML**.
- Sjukvård: 3 kap 4-5 §§ GML → **10 kap 6-7 §§ NML**.
- Utbildning: 3 kap 8 § GML → **10 kap 15-16 §§ NML** (uppdragsutbildning normalt momspliktig).
- Allmännyttiga ideella föreningar: 4 kap 8 § GML → **4 kap 6 § NML**. Avgörs via 7 kap 3 § IL (1999:1229).

### 4.2 Bokföringsregler unika för blandad verksamhet

BFL (1999:1078) 4 kap 2 § kräver att räkenskapsinformation är ordnad så att posternas samband med varandra utan svårighet kan följas. För blandad verksamhet betyder detta att verifikationer och kontoplaner måste vara så granulära att fördelning mellan momspliktig och momsfri verksamhetsgren kan rekonstrueras i efterhand: utan separation per kostnadsställe/projekt/lokal bryts god redovisningssed. BFNAR 2013:2 om bokföring kräver att varje affärshändelse bokförs så snart det kan ske; för blandad verksamhet innebär detta att klassificeringen (a/b/c per avsnitt 2 ovan) ska göras vid kontering, inte vid bokslut.

Periodiseringsfrågor: jämkningsbelopp periodiseras **inte** över räkenskapsåret utan redovisas i första redovisningsperioden efter räkenskapsårets utgång (ML 15 kap NML). Vid slutjämkning (försäljning, övergång till skattebefrielse) redovisas hela återstående beloppet i den period händelsen inträffar.

### 4.3 Sektorlagar som triggar momsfrihet

- **Fastighet:** JB 12 kap (hyreslagen) styr klassningen bostad vs lokal: bostad alltid momsfri och utesluter frivillig beskattning.
- **Vård:** HSL (2017:30) och patientsäkerhetslagen avgör vem som är legitimerad vårdgivare och därmed omfattas av ML 10 kap 6-7 §§ NML. Personaluthyrning räknas inte som sjukvård efter HFD 2018 ref. 41, HFD 2020 ref. 5, HFD 2020 ref. 35.
- **Utbildning:** Skollagen (2010:800) och högskolelagen (1992:1434) avgör vad som är grundläggande utbildning (momsfri per 10 kap 15 § NML). Uppdragsutbildning enligt förordning (2002:760) är momspliktig om inte beställaren själv bedriver utbildning där tjänsten ingår (10 kap 16 § NML).
- **Finans:** Lagen om bank- och finansieringsrörelse (2004:297): finansiell verksamhet undantagen per 10 kap 33 § NML.

### 4.4 Relevanta Skatteverket-ställningstaganden (2020-2026)

| Dnr | Datum | Ämne |
|---|---|---|
| 8-2749853 | 2024-02-02 | Uppdelning av ingående mervärdesskatt (huvudställningstagande post-HFD 2023 ref. 45) |
| (ej publikt verifierat) | ca 2025-10-15 | Ersättare till 8-2749853 efter HFD 2025 not. 29 (avdragsförbud stadigvarande bostad) |
| 8-2596368 | 2023-10-19 | Avdragsrätt för mervärdesskatt på inköp vid försäljning av aktier i dotterbolag (post-Volvo) |
| 202 377677-17/111 | 2017-12-19 | Holdingbolag: avdragsrätt (delvis överspelad; exempel 2 om riskkapitalbolag ersatt 2024-02-02 dnr 8-2756161) |
| 8-2349336 | 2023-05-12 | Jämkningshandling vid vissa fastighetsöverlåtelser |
| 8-2671490 | 2023-12-13 | Begreppet stadigvarande användning vid frivillig beskattning |
| 8-3193742 | 2024-12-12 | Rättsfallskommentar SRN 35-24/I (uppdelning + avdragsförbud bostad) |

## 5. De tre högsta felfrekvenser-scenarierna

### 5.1 Holdingbolag drar 100 % på rådgivningskostnader trots betydande utdelningsinkomster

**Fel:** Bolag bokför hela ingående momsen på management consulting och M&A-rådgivning på 2641 med full avdragsrätt, samtidigt som resultaträkningen visar utdelningar (8010/8210) som överstiger management fee-intäkterna. Skatteverket gör upptaxering vid revision.

**Rätt:** Utdelningar är utanför momsens tillämpningsområde (C-16/00 Cibo) och ska inte ingå i fördelningsnyckel. Men om bolaget även äger andelar i dotterbolag i vilkas förvaltning det INTE medverkar (passivt innehav), måste en **två-stegs-fördelning** göras per C-437/06 Securenta: först fördelning mellan ekonomisk och icke-ekonomisk verksamhet, sedan pro rata inom ekonomisk del. Om hela innehavet är aktivt (management fees till alla dotterbolag) gäller däremot Larentia + Minerva (C-108/14) → full avdragsrätt på allmänna omkostnader. Rådgivning vid förvärv av dotterbolag som ska bli aktivt förvaltat = allmän omkostnad → avdrag (Cibo); rådgivning vid avyttring kan ge avdrag om kapital frigörs till egen momspliktig verksamhet (HFD 2017 ref. 20, HFD 2023 ref. 41).

**Kontering vid blandat innehav (aktiva + passiva):** Konsultfaktura 500 000 kr + moms 125 000 kr. Hela momsen → 2649. Vid bokslut: antag 80 % avdragsrätt enligt omsättningsbaserad fördelning på ekonomisk del. Bokföring: D 6999 25 000 / D 2650 100 000 / K 2649 125 000.

**Lag:** ML 13 kap 29 § NML; momsdirektivet art. 173-174; C-16/00, C-108/14, C-437/06, HFD 2017 ref. 20, HFD 2023 ref. 41, HFD 2023 ref. 45, HFD 2024 ref. 18. SKV dnr 8-2596368, dnr 202 377677-17/111 (delvis).

### 5.2 Fastighetsbolag missar jämkning vid övergång till/från frivillig beskattning eller saknar jämkningshandling vid överlåtelse

**Fel:** (a) Bolag övergår från frivillig beskattning på en lokal till bostadsuthyrning utan att redovisa negativ jämkning. (b) Vid fastighetsförsäljning utfärdar säljaren ingen jämkningshandling till köparen, och båda parter antar att skyldigheten "övergår automatiskt". (c) Köpare antar att övertagande av jämkningsskyldighet sker vid ren fastighetsöverlåtelse (sant före Sögård, INTE sant nu).

**Rätt:** (a) Övergång från frivillig beskattning är jämkningsutlösande händelse (15 kap NML); negativ jämkning ska beräknas på återstoden av justeringsperioden och redovisas i första redovisningsperioden efter räkenskapsårets utgång. (b) Vid **verksamhetsöverlåtelse** (TOGC) övertar förvärvaren rättighet/skyldighet: jämkningshandling enligt 15 kap 22-23 § NML är obligatorisk med samtliga 9 punkter (ursprungsbelopp, avdragen del, tidpunkter, fördelning per lokal, tidigare ägare, parter, transaktionsart, momsregistreringsnummer, övrigt). (c) Vid **ren fastighetsöverlåtelse** övergår jämkningsskyldigheten INTE längre: säljaren slutjämkar för återstoden (HFD 2021 not. 26-27 efter C-787/18 Sögård; SKV dnr 8-2349336).

**Kontering exempel:** Lokal byggdes om för 500 000 kr ingående moms år 1 (100 % avdrag). År 5 övergår till bostadsuthyrning (avdragsrätt 0 %). Δ = 100 procentenheter; återstående år (inkl år 5) = 6; årligt jämkningsbelopp = 500 000 × 100 % × 1/10 = 50 000 kr; totalt återbetalas 300 000 kr över 6 år. Bokföring år 5: D 7820 (eller motkonto fastighet) 50 000 / K 2650 50 000.

**Lag:** ML 15 kap 4, 6-10, 12, 20-23 §§ NML (motsv. 8a kap 2, 4-8, 11-12, 15-17 §§ GML); ML 12 kap NML (frivillig beskattning); C-787/18; HFD 2021 not. 26-27; SKV dnr 8-2349336, dnr 8-2671490.

### 5.3 Fördelningsnyckel beräknas på fel basperiod eller inkluderar fel poster

**Fel:** (a) Bolag beräknar omsättningsbaserad fördelningsnyckel månadsvis utan slutlig årlig avstämning vid bokslut. (b) Utdelningar, ränteintäkter, fastighetsförsäljningar och bidrag inkluderas i nämnaren och späder ut den avdragsgilla andelen. (c) Bolag använder budget i stället för faktiskt utfall vid bokslut.

**Rätt:** (a) Preliminär nyckel löpande (baserad på föregående år eller budget), **slutlig årlig nyckel vid bokslut** med retroaktiv justering: detta är obligatoriskt enligt SKV rättslig vägledning. (b) Exkludera från fördelningsnyckel: utdelningar (utanför momsens tillämpningsområde per Cibo); ränteintäkter och fastighetstransaktioner om de är bitransaktioner (art. 174.2 momsdirektivet); kapitalvaror som används i verksamheten; bidrag som inte utgör ersättning för tjänst (C-126/14 Sveda kontrasterar mot bidrag som DEL av priset). (c) Faktiskt utfall styr; budget endast preliminärt. Slutlig fördelningsandel avrundas uppåt till heltal (art. 175 momsdirektivet).

**Kontering exempel:** Företag har årsomsättning momspliktig 8 mkr + momsfri 2 mkr + utdelning 5 mkr + räntor 200 tkr (bitransaktioner). Fördelningsnyckel = 8 / (8+2) = 80 %. Utdelning och räntor exkluderas helt. Gemensamma kostnader 1 000 000 kr + moms 250 000 kr på 2649 löpande. Bokslutsjustering: D 2650 200 000 / D 6999 50 000 / K 2649 250 000.

**Lag:** ML 13 kap 29 § NML; momsdirektivet art. 173.1, 174.1-2, 175; C-16/00, C-437/06, HFD 2023 ref. 45; SKV dnr 8-2749853 (och 2025-efterträdare).

## 6. Öppna frågor: flagga för manuell granskning

1. **Val mellan omsättningsbaserad och sektorbaserad fördelning för borderline holdingbolag** där management fees är låga relativt utdelningar och Skatteverket kan ifrågasätta omsättningsmetoden. Efter HFD 2023 ref. 45 kan den skattskyldige välja, men valet bör motiveras skriftligt och dokumenteras i momspolicy.
2. **Bitransaktion vs huvudtransaktion** för enstaka stora finansiella transaktioner (t.ex. ett internt lån, en aktieförsäljning). Cibo och art. 174.2 ger inte tydlig gräns; beror på frekvens, omfattning, resursåtgång. Vid osäkerhet inhämta förhandsbesked från Skatterättsnämnden.
3. **Nybyggnation där användning ännu inte fastställts.** Under uppförandeskede kan retroaktivt avdrag eller löpande avdrag vid frivillig beskattning bli aktuellt: val mellan dessa har stora konsekvenser för jämkning senare. Konsultera fastighetsmomsspecialist.
4. **Status för SKV-ställningstagande hösten 2025** som ersätter dnr 8-2749853 efter HFD 2025 not. 29. Dnr inte publikt verifierat i forskningen: kontrollera Skatteverkets ställningstagandeindex innan ny rådgivning ges.
5. **Pågående lagstiftningsarbete:** Dir. 2024:46 om utökad frivillig beskattning och nya justeringsregler (redovisas 2026-01-30); regeringens förslag 2025-12-04 om omsättningsmetod som lagstadgad huvudregel i ML: planerat ikraftträdande 1 januari 2027. Bevaka.

## Referensfiler

- `references/jamkning-mechanics.md`: Full ML 15 kap-mekanik med tre worked examples
- `references/fordelningsnyckel-metoder.md`: Omsättning/yta/tid/sektor + HFD 2023 ref. 45 deep-dive
- `references/holdingbolag-avdragsratt.md`: EU- och HFD-praxis, management fee-krav
- `references/frivillig-skattskyldighet-fastighet.md`: Anmälan, krav, jämkning vid övergång
