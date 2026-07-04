---
id: vertical/konsult-it
tier: vertical
title: "IT-konsult & systemutvecklare (SNI 62)"
description: >
  Swedish bookkeeping compliance for IT-konsult och mjukvarubolag (SNI 62.01 Dataprogrammering, 62.02 Datakonsultverksamhet, 62.09 Andra IT- och datatjänster, 63.11 Databehandling/hosting, 63.12 Webbportaler). Distinctive patterns: omvänd betalningsskyldighet vid B2B-tjänster inom och utanför EU, OSS-deklaration för B2C digitala tjänster, inköp av molntjänster/SaaS från USA (AWS, Azure, GitHub, OpenAI, Anthropic), 3:12-fåmansreglerna (IL 57 kap inkl. SFS 2025:1361-reformen), konsult-vs-anställd-klassificering av en-mans-konsult-AB. Load when the GL shows 4531/4535 (utländska tjänster), 2614/2645 (omvänd moms), 5420/6540 (programvaror/IT-tjänster), 3308/3305 (försäljning tjänster EU/utanför EU), 1010/1012/2089 (utvecklingsutgifter/fond), eller 7220 (lön företagsledare) i kombination med få anställda.
sni_prefixes: ["62.01", "62.02", "62.09", "63.11", "63.12"]
trigger_signals:
  text_patterns:
    - "omvänd betalningsskyldighet"
    - "omvänd skattskyldighet"
    - "reverse charge"
    - "AWS"
    - "Azure"
    - "GitHub"
    - "OpenAI"
    - "Anthropic"
    - "Microsoft 365"
    - "konsultarvode"
    - "licensavgift"
    - "SaaS-prenumeration"
    - "molntjänst"
    - "F-skattsedel"
    - "K10"
    - "gränsbelopp"
    - "fåmansföretag"
  bas_account_signals:
    - "4531"
    - "4535"
    - "2614"
    - "2645"
    - "3308"
    - "3305"
    - "5420"
    - "6540"
    - "6850"
    - "1012"
    - "2089"
    - "7220"
    - "3922"
estimated_tokens: 9800
version: 2
---

# Konsult-IT: Swedish bookkeeping compliance

## 1. When to use

Load this skill when the books belong to a Swedish AB or enskild firma in SNI 62.01-63.12 (IT-konsult, mjukvara, SaaS, hosting, webbportaler). Strong loading signal: simultaneous presence of foreign SaaS-suppliers (AWS/Azure/GitHub/OpenAI/Stripe), reverse-charge moms-konton (2614/2645), tjänsteförsäljning till EU/utland (3305/3308), och en koncentrerad lönelista där `7220 Löner till företagsledare` dominerar (fåmansbolag-signatur). Skip generic VAT/payroll/year-end skills: they are already covered by horizontal skills; this skill only documents what *differs* for the konsult-IT vertical.

## 2. Typical workflow patterns

**Invoicing cadence.** Three dominant modes coexist and often within the same client portfolio: (a) **timbaserad löpande räkning** with monthly invoicing of consumed hours (the default for staff-augmentation deals); (b) **månatlig retainer** for managed services/SLA (constant amount, periodiseras linjärt); (c) **fastprisprojekt** with milestone-based delfakturor (requires `1620 Upparbetad men ej fakturerad intäkt` or `2450 Fakturerad men ej upparbetad intäkt` at balansdagen: see successiv vinstavräkning in §4). SaaS adds a fourth: **förskottsfakturerade prenumerationer**, where 12-månadersfakturor periodiseras över avtalstiden mot `2972 Förutbetalda intäkter`.

**Expense rhythm.** Heavily skewed to **monthly recurring SaaS** (Microsoft 365, Adobe, Figma, JetBrains, Slack, Atlassian, Notion) on `5420 Programvoror`, plus **usage-based cloud** (AWS, Azure, GCP) on `6540 IT-tjänster`. Hardware is comparatively small (laptops via `5410 Förbrukningsinventarier` if under ½ pbb, else aktiveras på `1250 Datorer`). Critical pattern: nearly every recurring expense line triggers **omvänd betalningsskyldighet** because suppliers are non-Swedish.

**Reconciliation timing.** Monthly close is required to capture (i) reverse-charge moms via 2614/2645 entries, (ii) FX-justeringar on USD/EUR-leverantörsskulder, and (iii) WIP-periodisering on löpande räkning. Periodisk sammanställning för EU-tjänsteförsäljning lämnas **kvartalsvis** med köparens VAT-nr.

**Payroll cadence & CBA.** Månadsavlöning den 25:e är standard. Tillämpligt kollektivavtal: **Tjänstemannaavtalet IT** (kallas "IT-avtalet") mellan **TechSverige** (tidigare IT&Telekomföretagen, namnbyte 2021-10-21; lämnade Almega 2024/25 och är nu fristående AGO) och **Unionen / Sveriges Ingenjörer / Akavia**. Aktuell period **2025-04-01 till 2027-03-31** (24 mån), totalvärde 6,4 %: löneökning 5,5 % (3,0 + 2,5), arbetstidsförkortning 0,5 %, flexpension +0,4 pe. Tjänstepension ITP1/ITP2 via Collectum (`7410`); särskild löneskatt på pensionskostnader 24,26 % på `7530`. Avtalsförsäkringar TGL/TFA via Fora.

## 3. BAS 2025 account patterns

Verifierat mot **Kontoplan BAS 2025 v.1.0** (bas.se/kontoplaner). Endast konton som denna vertical lutar tungt på listas; allmänna konton utelämnas.

| Konto | Namn (BAS 2025) | Industri-specifik användning |
|---|---|---|
| **1010** *(ej K2)* | Utvecklingsutgifter | Huvudkonto för aktiverade utgifter för intern produktutveckling (K3 aktiveringsmodell); ej tillåtet i K2. |
| **1012** *(ej K2)* | Balanserade utgifter för programvaror | Aktiverad SaaS-kodbas eller köpt programvarukomponent som integreras i egen produkt. |
| **1019** | Ackumulerade avskrivningar på balanserade utgifter | Linjär avskrivning på utvecklingsutgifter, typiskt 5 år (ÅRL 4 kap 4§ 2 st om nyttjandeperiod ej tillförlitligt kan fastställas). |
| **1040** | Licenser | Köpta perpetual-licenser med nyttjandeperiod >1 år (ERP, utvecklingsverktyg, källkodslicens). |
| **1620** | Upparbetad men ej fakturerad intäkt | Mycket vanlig: utförda men ofakturerade timmar/milstolpar på balansdagen vid successiv vinstavräkning eller löpande räkning. |
| **2089** *(ej K2)* | Fond för utvecklingsutgifter | **Obligatorisk vid K3-aktivering** (ÅRL 4 kap 2§); låser fritt eget kapital och därmed utdelningsbart belopp / 3:12-utrymme. |
| **2450** | Fakturerad men ej upparbetad intäkt | Förskottsfakturerad SaaS-prenumeration eller projektmilstolpe utan motsvarande prestation. |
| **2614** | Utgående moms, omvänd betalningsskyldighet, 25 % | Köparens kredit-sida vid inköp av tjänst från utländsk leverantör (AWS, GitHub, EU SaaS). |
| **2645** | Beräknad ingående moms på förvärv från utlandet | Motkonto debet; nettoeffekten 0 vid full avdragsrätt. |
| **3305** | Försäljning tjänster till land utanför EU | Konsultarvode till US/UK kund: utanför momslagens tillämpningsområde, momsruta **40**. |
| **3308** | Försäljning tjänster till annat EU-land | B2B-konsult/SaaS till EU företag: momsruta **39** + periodisk sammanställning. |
| **3922** | Licensintäkter och royalties | SaaS-licensavgifter, white-label-royalty, API-användningsavgift. |
| **3800** *(gruppkonto)* | Aktiverat arbete för egen räkning | K3-aktivering: motkonto till 1010/1012 när intern utvecklartid kapitaliseras. |
| **4531** | Inköp av tjänster från ett land utanför EU, 25 % | AWS US, OpenAI, GitHub, Anthropic, Stripe: utlöser 2614/2645. Momsruta **22+30+48**, **ej** i periodisk sammanställning. |
| **4535** | Inköp av tjänster från annat EU-land, 25 % | Microsoft IE, Atlassian NL, Google IE: utlöser 2614/2645. Momsruta **21+30+48**. |
| **5420** | Programvoror | SaaS-licenser och off-the-shelf-mjukvara (löpande operativ kostnad, skiljs från 6540 enligt bolagets policy). |
| **6540** | IT-tjänster | Molntjänster, IaaS, hosting, CI/CD, MDM, observability. Gränsdragning mot 5420 är policyfråga: tjänst vs licens. |
| **6550** | Konsultarvoden | Köpta konsulttjänster (revision, jurist, övrig icke-IT-konsult). |
| **6556** | Köpta tjänster avseende FoU | Externa FoU-konsulter; kan ingå i aktiveringsunderlag (1010/1012). |
| **6560** | Serviceavgifter till branschorganisationer | TechSverige, Dataföreningen, certifieringsorgan. |
| **6850** | Inhyrd IT-personal | **Sektor-specifikt huvudkonto**: underkonsult AB→AB-kontrakt mot slutkund (klassisk subkontraktering). |
| **6910** | Licensavgifter och royalties | **Utgående** royalty till tredjepart (komponent-/IP-licens som integreras i egen SaaS). |
| **7210** | Löner till tjänstemän | Konsulternas löner: räknas in i lönesumman för 3:12 lönebaserat utrymme. |
| **7220** | Löner till företagsledare | **Kritiskt för 3:12**: ägarens egen kontantlön: måste nå löneuttagskravet (gamla regler t.o.m. 2025). |
| **7811** | Avskrivningar på balanserade utgifter | Periodisk avskrivning av 1010/1012. |

**Noteringar.** `3001/3041` (försäljning tjänster Sverige 25 %) varierar mellan BAS-grundtabellen och bokföringsprogram (Fortnox/Visma/Bokio adderar 3041 som branschanpassning). Använd det som finns i klientens kontoplan. `2647 Ingående moms omvänd betalningsskyldighet varor och tjänster i Sverige` används endast vid inhemsk omvänd skattskyldighet (mer relevant bygg).

## 4. Regulatory edge cases

### 4.1 Momsregler

**Lagbas.** Ny **Mervärdesskattelag (2023:200)** ikraft **2023-07-01**, ersatte 1994:200 (GML). Paragrafnummer nedan är nya ML; gamla GML-referenser anges parentetiskt för historiska räkenskapsår.

**B2B huvudregel: säljarperspektiv.** ML **6 kap 33§** (gml. 5 kap 5§): tjänst till beskattningsbar person beskattas där köparen har säte. EU-grund: art. 44 i 2006/112/EG. Praktisk följd för IT-konsult: B2B-försäljning till företag i annat EU-land eller utanför EU → ingen svensk moms, faktura med text **"Omvänd betalningsskyldighet / Reverse charge, Artikel 44 och 196 i rådets direktiv 2006/112/EG"** + köparens VAT-nr. **VIES-validering är säljarens bevisbörda** (SKV ställningstagande dnr 202 460649-17/111, 2018-01-25, uppdaterad för ML 2023:200): spara skärmdump av VIES-kontrollen per kund per faktureringscykel.

**B2B köparperspektiv: omvänd betalningsskyldighet.** ML **16 kap 9-10§§**, EU-art. 196. Svensk köpare av tjänst från utländsk leverantör är **betalningsskyldig** för svensk moms. Bokföring: kostnadskonto debet, **2614 kredit 25 %**, **2645 debet 25 %**, 2440 kredit; nettoresultat 0 vid full avdragsrätt. Momsdeklaration: **ruta 21+30+48** för EU-leverantör, **ruta 22+30+48** för icke-EU. Periodisk sammanställning gäller endast försäljning (ej inköp). Terminologi: ML 2023:200 bytte "omvänd skattskyldighet" → **"omvänd betalningsskyldighet"**; båda termerna förekommer i praxis.

**OSS för B2C digitala tjänster.** ML **6 kap 56-58§§** (gml. 5 kap 16-17§§): telekom/broadcasting/elektroniska tjänster (TBE) till EU-konsument beskattas i köparens land. Tröskel **10 000 EUR / 99 680 SEK per kalenderår** för all unionsintern distansförsäljning B2C sammantaget (ML 6 kap 62-63§§). Över tröskel: registrera och deklarera i **OSS-unionsordningen** (ML 22 kap, ersatte upphävda lag 2011:1245 från 2023-07-01), kvartalsvis i EUR, separat från vanliga momsdeklarationen. Bokföring försäljning på 3308 + utgående OSS-moms på **2670**.

**Konsulttjänst vs elektronisk tjänst: gränsdragning.** Tre kumulativa krav för elektronisk tjänst (EU genomförandeförordning 282/2011 art. 7 + bilaga I): huvudsakligen automatiserad, minimal mänsklig inblandning, kan ej utföras utan IT. Skräddarsydd kod på beställning = konsulttjänst (huvudregel). Standard-SaaS = elektronisk tjänst (OSS för B2C). Förinspelad onlinekurs = elektronisk tjänst; live-undervisning via video = konsulttjänst. Compute/GPU = elektronisk tjänst (Skatterättsnämnden förhandsbesked 2024 om beräkningskapacitet). Se `references/electronic-services-classification.md`.

**Skatteverkets ställningstaganden om molntjänster: caveat.** **Inget separat heltäckande moms-ställningstagande "SaaS" eller "molntjänster" existerar.** Sökträffar avser typiskt (a) energiskatt på datorhallar (dnr 202 321717-18/111, 2018-09-19, ej moms), eller (b) GDPR/personuppgifter vid tredjelandsöverföring. Klassificering sker via definitionen av elektronisk tjänst i ML 6 kap + 282/2011 art. 7 + Skatterättsnämndens förhandsbesked 2024. **Ange inte fiktiv dnr** i klientdokumentation.

**Marknadsplats-presumtion.** SKV ställningstagande **dnr 8-2059749, 2022-12-19** ("Försäljning av elektroniska tjänster via marknadsplats/förmedlare på Internet"): app stores och liknande presumeras vara säljare av slutkundstjänsten. Ersätter dnr 131 499122-14/111. Relevant för app-/SaaS-distribution via Apple/Google/Microsoft.

**Licens, royalty, programvara: vara vs tjänst.** Standardprogram på fysiskt medium = **vara**; standardprogram online (download/cloud) = **elektronisk tjänst**; skräddarsydd programvara = **konsulttjänst** (alltid). Royalty för immaterialrätt = tjänst i "diverse tjänster"-katalogen (ML 6 kap 64-66§§). Skattesats alltid **25 %** för programvara/SaaS (reducerad sats 6 % gäller inte programvara).

**Lagändring 2025-01-01 (SFS 2024:942).** Virtuella evenemang B2B → köparens land; omsättningsgräns för småföretag höjd till **120 000 SEK**. Påverkar små IT-frilansare under tröskeln.

**EU-dom C-247/21 Luxury Trust Automobil (2022).** Saknad "reverse charge"-text på faktura kan **inte rättas efteråt**, strikt formalia. Säkerställ korrekt fakturamall från första fakturan till EU B2B-kund.

### 4.2 Bokföringsregler

**K3 (BFNAR 2012:1) kap 18: immateriella anläggningstillgångar.** Bolaget **väljer** mellan aktiveringsmodellen och kostnadsföringsmodellen för internt upparbetade immateriella tillgångar (18.7); valet är en redovisningsprincip och tillämpas konsekvent. Aktivering kräver att samtliga sex kriterier i **18.12** uppfylls (teknisk genomförbarhet, avsikt, förmåga, sannolika ekonomiska fördelar, resurser, mätbarhet); forskningsfas kostnadsförs alltid (18.11). Förbud mot aktivering av varumärken, kundregister, "säljande" webbplats (18.5). Avskrivningstid = nyttjandeperiod; om ej tillförlitligt fastställbar → **5 år** (ÅRL 4 kap 4§ 2 st).

**K2 (BFNAR 2016:10) punkt 10.4: aktiveringsförbud.** "Ett företag får inte aktivera utgifter för egenupparbetade immateriella anläggningstillgångar." Förvärvade får aktiveras. **Praktisk följd**: SaaS-bolag som vill kapitalisera egenutvecklad mjukvara måste välja K3 (tvingande), vilket utlöser revisionsplikt över gränsvärdena, fond för utvecklingsutgifter, och uppskjuten skatt.

**Fond för utvecklingsutgifter: ÅRL 4 kap 2§.** Aktivering enligt K3 18 tvingar överföring från fritt EK till bunden fond **2089** med motsvarande belopp; fonden upplöses i takt med avskrivning/nedskrivning. **Direkt 3:12-implikation**: aktiverade 5 MSEK utvecklingsutgifter → 5 MSEK låst i 2089 → utdelningsbara medel minskar omedelbart.

**Successiv vinstavräkning: K3 kap 23.** Huvudregel i K3 (23.17-23.18) när utfallet kan mätas tillförlitligt: intäkter och utgifter periodiseras efter färdigställandegrad. **Alternativregeln (färdigställandemetoden)** tillåten i juridisk person enligt **23.31** för bygg, anläggning, hantverk och **konsultverksamhet**: IT-konsult kvalificerar. I koncernredovisning enligt K3 är endast successiv vinstavräkning tillåten. Befarad förlust kostnadsförs direkt (23.32).

**Successiv vinstavräkning: K2 kap 6.** Löpande räkning: successiv vinstavräkning är **obligatorisk** (6.16-6.18). Fastpris: **val** mellan huvudregel (successiv) och alternativregel (färdigställande). Skattemässig synk: IL **17 kap 23-32§§** styr pågående arbeten; konsulttjänsteuppdrag till fast pris kan skatteperiodiseras enligt färdigställandemetoden, varför många IT-konsult-AB väljer K2 + färdigställande för enkelhet och senare skattedebitering.

**RFR 2 / IAS 38 / IFRS 15** (noterade). IAS 38 gör aktivering **tvingande** vid uppfyllda kriterier (skillnad mot K3 där aktivering är frivilligt principval). IFRS 15 tillåter inte färdigställandemetoden: intäkter ska redovisas över tid när art. 35-kriterier uppfylls.

### 4.3 Sektorlagar och annat

**3:12-reglerna (IL 57 kap)**: se utförlig behandling i §5 nedan och i `references/3-12-rules.md`. Kritisk reform: **SFS 2025:1361** ikraft 2026-01-01, tillämpas första gången på beskattningsår som börjar efter 2025-12-31 (K10 inlämnad våren 2027). Inkomstår 2025 (K10 våren 2026) följer gamla reglerna fullt ut.

**F-skatt och underkonsultkontroll.** SFL **10 kap 11§**: utbetalaren får lita på F-skatt-status endast om den anges **skriftligt** i handling upprättad i samband med uppdraget (faktura/avtal). SFL **10 kap 24§**: betalning till icke-F-skattegodkänd juridisk person utlöser skatteavdrag 30 %. **HFD 2019:60** (mål 3978-3979-18 m.fl.): uppdragsavtal med F-skattegodkänd uppdragstagare kan inte åsidosättas annat än vid **skenavtal**: starkt skydd för dokumenterade konsultupplägg. SKV ställningstagande **dnr 8-2386895** (2023-05-25) om F-skattsedelns rättsverkningar.

**Konsult vs anställd: IL 13 kap 1§** (efter prop. 2008/09:62 från 2009-01-01). Tre särskilt beaktade faktorer: partsavsikten, uppdragstagarens beroende av uppdragsgivaren, och integration i dennes organisation. **HFD 2018 ref. 31**: konsult via eget AB kan ändå klassas "verksam i betydande omfattning" hos kund i 3:12-mening. **HFD 2017 ref. 41**: styrelsearvode beskattas som tjänst även vid fakturering via AB. Se `references/consultant-vs-employee.md`.

**GDPR: personuppgiftsbiträde.** GDPR (EU 2016/679) **art. 28** + dataskyddslag (2018:218). IT-konsulten är typiskt biträde vid drift, förvaltning, SaaS-hosting och utveckling med produktionsdata; ansvarig (controller) för egen löne-/kund-/leverantörsdata. Tredjelandsöverföring: **EU-US Data Privacy Framework** (kommissionens adekvansbeslut 2023-07-10) återupplivar transatlantiska överföringar till certifierade mottagare; ej certifierade → SCC (beslut 2021/914) + TIA per **Schrems II (C-311/18)** + EDPB rek. 01/2020. Sanktionsavgifter från IMY → **ej avdragsgilla** (IL 16 kap 18§), bokas på 6990/7990.

**URL (1960:729) 40a§: datorprogram.** Implementerar datorprogramdirektivet 2009/24/EG. Anställdas kod övergår presumtivt till arbetsgivaren (även ideella rättigheter, vidare än direktivet). **Konsulter omfattas inte**: utan explicit IP-överlåtelseklausul behåller konsulten upphovsrätten; köparen får bara begränsad nyttjanderätt enligt tumregeln (AD 2002 nr 87). Klassisk DD-risk vid förvärv.

**Utlandstjänstgöring: URA gäller INTE privat IT-sektor.** URA-avtalet tecknas av Arbetsgivarverket och gäller endast statligt anställda. Faktiska tillämpliga regler för privata IT-konsulter utomlands: **sexmånadersregeln** (IL 3 kap 9§ 1 st), **ettårsregeln** (IL 3 kap 9§ 2 st), **kortare avbrott max 6 dagar/månad eller 72 dagar/anställningsår** (IL 3 kap 10§; HFD 2011 ref. 40, HFD 2014:9). **SINK** (1991:586): 25 % fast på svensk lön till bosatt utomlands. **Expertskatt** (IL 11 kap 22-23§§ + lag 1999:1305): 25 % av lön + vissa ersättningar skattefria i **7 år** (utökat från 5 år genom lag 2023:880 fr.o.m. vistelse efter 2023-03-31); förenklingsregel från 2025-01-01 = månadsersättning ≥ **1,5 pbb**. **A1-intyg** (förordning 883/2004 art. 12) för utsändning ≤24 mån inom EU/EES/Schweiz/UK: bevarar svensk socialförsäkringstillhörighet. Se `references/cross-border-payroll.md`.

**Fast driftställe vid hemmakontor.** **HFD 2022 ref. 39** (mål 6446-21): utländsk arbetsgivare får i regel inte fast driftställe i Sverige genom anställds hemmakontor utan arbetsgivarens krav. Backas av SKV ställningstagande **dnr 8-1677220** (2023-05-13). Mer restriktivt än tidigare praxis: relevant för utländska IT-bolag med remote-anställda i Sverige.

### 4.4 Relevant HFD-praxis 2021-2026

| Mål | Område | Innebörd |
|---|---|---|
| HFD 2019:60 (3978-3979-18) | F-skatt / arbetsgivaravgifter | Uppdragsavtal med F-skatt ej åsidosättbart utom vid skenavtal: dominerande prejudikat för IT-konsult-AB. |
| HFD 2018 ref. 31 (3936-3939-17) | 3:12 / verksam i betydande omfattning | Konsultarbete via eget AB kan ändå smitta kundens fåmansbolag. |
| HFD 2021 ref. 40 ("Valedo") | 3:12 / utomståenderegeln | A/B-aktiestruktur med carried interest → särskilda skäl, kvalificerade trots >30 % utomstående. |
| HFD 2023 ref. 11 (5807-22) | 3:12 / samma eller likartad verksamhet | Nyemission från extern investerare smittar inte mottagarens andra bolag om ägarsambandet bryts. |
| HFD 2024 ref. 8 (2887-23) | 3:12 / utomståenderegeln | Villkorade tillskott + vetokrav slår **inte** ut utomståenderegeln: restriktiv tolkning av "särskilda skäl". |
| HFD 2024 ref. 51 (1372-24) | 3:12 / kapitalsmitta | Direkt + indirekt ägande hos samma krets → kapitalsmitta kvarstår; försämring jämfört med 2023 ref. 11. |
| HFD 2022 ref. 39 (6446-21) | Fast driftställe | Hemmakontor utan AG-krav skapar ej fast driftställe. |
| HFD 2024 ref. 42 | Moms / digital plattform | EdTech-plattform ej "bok": standard 25 %. |
| Skatterättsnämnden 2024 | Moms / compute | Beräkningskapacitet/GPU = elektronisk tjänst. |
| EUD C-247/21 (2022) | Moms / fakturaformalia | "Reverse charge"-text kan inte rättas i efterhand. |

## 5. The 3 highest-error-rate scenarios

### 5.1 SaaS-prenumerationer från utländska leverantörer (AWS, Azure, GitHub, OpenAI, Anthropic, Stripe)

**Fel mönster.** Bokföra AWS US-fakturan som om den vore svensk: kostnad 80 % på 6540, ingående moms 20 % på 2641, **eller** kostnad 100 % på 6540 utan motkonto, ignorera momsen. Båda är fel.

**Rätt mönster.** Inköpet är tjänst från utländsk beskattningsbar person enligt huvudregeln (ML **6 kap 33§**), och köparen är betalningsskyldig (ML **16 kap 9§**). Bokföring:

- 4531 (icke-EU) eller 4535 (EU) debet: bruttobelopp i SEK
- 2440 kredit: leverantörsskuld
- 2614 kredit 25 %: utgående moms omvänd betalningsskyldighet
- 2645 debet 25 %: beräknad ingående moms (full avdragsrätt vid momspliktig verksamhet → netto 0)

Momsdeklaration: **ruta 22+30+48** för icke-EU; **ruta 21+30+48** för EU. Ej i periodisk sammanställning.

**Praktisk fallgrop.** Microsoft fakturerar typiskt via Irland → EU-behandling. AWS, Google Cloud fakturerar via olika entiteter beroende på avtal: **kontrollera fakturafoten** för säljarens etablering. Säkerställ att klientens VAT-nr finns i leverantörens konto: annars debiterar leverantören utländsk moms som **inte är avdragsgill i Sverige** (kräv kreditfaktura).

**Lagreferens.** ML 6 kap 33§ + 16 kap 9-10§§ (SFS 2023:200, ikraft 2023-07-01); art. 44 + 196 i 2006/112/EG.

### 5.2 Fakturering av EU B2B-kund med svensk moms

**Fel mönster.** Svensk IT-konsult fakturerar tyskt eller franskt företag med svenska 25 % moms (försäljning 80 % på 3041, moms 20 % på 2611), eftersom det "känns säkrast" eller fakturamallen inte ändrats. Kunden vägrar betala momsdelen.

**Rätt mönster.** B2B-tjänst till EU-företag beskattas i köparens land (ML **6 kap 33§**); köparen redovisar via reverse charge (art. 196 i 2006/112/EG). Faktura: **ingen moms**, försäljning på **3308**, fakturatext **"Omvänd betalningsskyldighet / Reverse charge, Artikel 44 och 196 i rådets direktiv 2006/112/EG"**, köparens VAT-nr på fakturan. **VIES-validering krävs och ska sparas** (säljarens bevisbörda enligt SKV ställningstagande dnr 202 460649-17/111, 2018-01-25). Momsdeklaration **ruta 39** + **periodisk sammanställning kvartalsvis** med köparens VAT-nr.

**Praktisk fallgrop.** Om VAT-nr inte kan verifieras i VIES → behandla som B2C, debitera svensk moms (eller OSS över 10 000 EUR/år). Saknas "reverse charge"-textern → **EUD C-247/21 (2022)**: kan inte rättas efteråt. Korrigera fakturamallen omedelbart.

**Lagreferens.** ML 6 kap 33§; ML 17 kap (faktureringsskyldighet); art. 44 + 196 i 2006/112/EG; EUD C-247/21 Luxury Trust Automobil.

### 5.3 3:12 K10: felaktig löneunderlagsberäkning (gäller K10 vår 2026 / inkomstår 2025)

**Fel mönster.** Ägare av en-mans-IT-konsult-AB tar löneuttag 350 000 kr 2024, deklarerar K10 huvudregeln 2025, beräknar lönebaserat utrymme = 50 % × egen lön = 175 000 kr, och missar att löneuttagskravet inte är uppfyllt, så lönebaserat utrymme blir **0**. Eller: räknar med styrelsearvoden i lönesumman.

**Rätt mönster.** **IL 57 kap 19§**: för rätt till lönebaserat utrymme måste delägare eller närstående ha tagit ut kontant lön året före beskattningsåret om minst det **lägre** av (a) 6 IBB + 5 % av total kontant lönesumma i AB + dotter, eller (b) 9,6 IBB. För K10 vår 2026 (inkomstår 2025) räknas mot **IBB 2024 = 76 200 kr** → tak (b) = **731 520 kr**, golv (a) = **457 200 kr + 5 % × lönesumman**. För en-mans-AB med ägaren som enda anställd och lön 600 000 kr: (a) = 457 200 + 30 000 = 487 200 kr → kravet uppfyllt. Styrelsearvoden räknas **inte** in (uppdragstagare); skattepliktig del av bilersättning/traktamente räknas in per SKV ställningstagande **dnr 131 764318-09/111** (2009-11-16). Kapitalandelskrav 4 % (IL 57 kap 19a§).

**När huvudregeln är värdelös, använd förenklingsregeln.** IL 57 kap 11a§: schablon **2,75 × IBB året före** = 2,75 × 76 200 = **209 550 kr för inkomstår 2025** (K10 vår 2026). Restriktion: får användas i **endast ett** företag per delägare per år (parallella konsult-AB:n fälla).

**Lagreferens.** IL 57 kap 11§ (gränsbelopp), 11a§ (förenklingsregeln), 12§ (huvudregeln), 16-19§§ (lönebaserat utrymme + löneuttagskrav), 19a§ (kapitalandelskrav).

**Varning för K10 vår 2027 (inkomstår 2026).** **SFS 2025:1361** (ikraft 2026-01-01): löneuttagskrav och 4 %-kapitalandelskrav **slopas**; grundbelopp = **4 × IBB** (2026: 4 × 80 600 = **322 400 kr**, fördelas över andelar och kan inte multipliceras genom parallella AB); lönebaserat utrymme = 50 % × (löneunderlag − schablonavdrag 8 IBB per delägare) = 50 % × (löneunderlag − 644 800 kr); uppräkning av sparat utdelningsutrymme slopas. Tidsperioder 5→4 år tillämpas först bsk-år efter 2026-12-31. Se `references/3-12-rules.md` för fullständig övergång.

## 6. Open questions (flag for human review)

1. **3:12-reformens detaljparagrafer.** Exakt §-numrering i IL 57 kap **efter** SFS 2025:1361: förenklingsregeln 11a§ utgår; takbelopp 20/22§§ kan ha omnumrerats. Verifiera mot officiell konsoliderad SFS-text när tillgänglig. Reformen tillämpas från räkenskapsår som börjar efter 2025-12-31; första K10 enligt nya reglerna lämnas våren 2027.
2. **BAS 2026.** BFN beslutade 2025-06-16 och 2025-12-13 om större ändringar i K3/K2; BAS 2026 har följdändringar. Detta SKILL.md är låst till **BAS 2025 v.1.0** för rapportering avseende räkenskapsår 2025. Uppdatera vid övergång till BAS 2026.
3. **3041 vs 3001.** I abbreviated BAS 2025-tabellen finns endast 3001-3004 som standard. Fortnox/Visma/Bokio lägger ofta till 3041 "Försäljning tjänster inom Sverige 25 %". Verifiera klientens specifika kontoplan innan användning.
4. **Tjänsteställe vid distansarbete.** SKV ställningstagande **dnr 8-1283049** (2021-12) om att hem ej blir tjänsteställe när AG tillhandahåller arbetsplats är kontroversiellt och anses av vissa rättskällor strida mot lag: flagga för manuell granskning vid reseavdrag och milersättning för konsulter med blandad arbetsplats.
5. **MicrosoftIE vs MicrosoftUS-fakturering.** Vissa kunder får fakturor från Microsoft Ireland Operations Ltd (EU) men andra från Microsoft Corp (US) beroende på avtalstyp (Enterprise Agreement vs CSP). Bokföringen skiljer (4531 vs 4535) men momsmekaniken är identisk. Verifiera fakturafoten.
6. **Konsult-vs-anställd vid en kund.** HFD 2019:60 ger starkt skydd vid dokumenterad F-skatt, men en-uppdragsgivare-AB:n riskerar fortfarande reklassificering vid bristande självständighetsdokumentation. Inhämta avtalskopior och självständighetschecklista vid årlig review.

## Reference files

- `references/3-12-rules.md`: Full IL 57 kap walkthrough, IBB-tabeller 2023-2026, K10-blanketten, SFS 2025:1361-reformbridge.
- `references/electronic-services-classification.md`: Beslutsträd konsulttjänst vs elektronisk tjänst, OSS-tröskel, marknadsplats-presumtion.
- `references/cross-border-payroll.md`: Sexmånadersregeln, ettårsregeln, SINK, expertskatt, A1-intyg.
- `references/consultant-vs-employee.md`: IL 13:1-kriterier, HFD-praxis, dokumentationschecklista.
- `references/software-capitalization.md`: K3/K2/IFRS aktivering, fond för utvecklingsutgifter, bokföringsmönster.
- `references/invoice-templates.md`: Fakturatext-bibliotek B2B EU / icke-EU / B2C / royalty.
