---
id: vertical/software-saas-ai
tier: vertical
title: "Software, SaaS & AI-produktbolag (SNI 58.21-63.12)"
description: >
  Swedish bookkeeping for software, SaaS and AI product companies (SNI 58.21, 58.29, 62.01, 62.03, 63.11, 63.12). Use whenever a Swedish AB or EF has recurring digital product revenue, US/EU cloud and LLM vendors in the supplier ledger (AWS, OpenAI, Anthropic, Stripe, GitHub), runs personaloptioner or KPO programs, books förutbetalda intäkter for annual prepay (2979), capitalizes development costs under K3 chapter 18, files OSS-deklaration, or operates under a US Delaware parent with a Swedish opco. Trigger on indirect cues: GL containing 1010 plus 2089 plus 4531/4535, 3:12-reformen 2026, K2-vs-K3 choice for SaaS, omvänd betalningsskyldighet on API costs, EU AI Act conformity, transfer pricing for cost-plus dev shops. Distinct from konsult-it (hourly billing): prefer this skill when subscription/usage-based digital product revenue dominates.
sni_prefixes: ["58.21", "58.29", "62.01", "62.03", "63.11", "63.12"]
trigger_signals:
  text_patterns:
    - "Stripe Payments"
    - "AWS EMEA SARL"
    - "Google Cloud EMEA"
    - "OpenAI"
    - "Anthropic"
    - "Vercel"
    - "GitHub"
    - "MRR"
    - "ARR"
    - "OSS-deklaration"
    - "personaloption"
    - "konvertibel"
    - "SAFE"
  bas_account_signals:
    - "1010"
    - "1018"
    - "2089"
    - "2614"
    - "2645"
    - "2647"
    - "2979"
    - "3305"
    - "3308"
    - "4531"
    - "4535"
    - "6540"
    - "6570"
estimated_tokens: 11500
version: 1
---

# software-saas-ai

## 1. När detta atom aktiveras

Bolag med SNI 58.21/58.29/62.01/62.03/63.11/63.12 vars huvudsakliga intäkt är återkommande digital produktförsäljning (SaaS, mjukvara, API, AI-applikation). Trigga också om GL innehåller 1010 + 2089 + (4531 eller 4535) + 2979 i kombination, eller om leverantörsregistret matchar AWS EMEA SARL, Google Cloud EMEA, OpenAI, Anthropic, Stripe, Vercel, GitHub. Ej för IT-konsulttjänst på timme: använd konsult-it.

## 2. Arbetsflödesmönster

**Faktureringskadens.** Dominerande mönster: månatlig eller årlig prenumeration förskottsfakturerad, ofta via Stripe/Adyen/Paddle. Sekundärt: usage-/seat-baserad efterskottsfakturering. Reseller- och marketplace-flöden (Apple App Store, Google Play, AWS Marketplace) kräver särskild momsanalys: plattformen är presumerad säljare till slutkund per Art. 9a EU-genomförandeförordning (EU) 282/2011, utvecklaren tillhandahåller B2B-tjänst till plattformen.

**Kostnadsrytm.** Molnberäkning, API och SaaS-prenumerationer dominerar OPEX och utgör typiskt 25-50% av kostnadsmassan. Övervägande del USD/EUR-fakturerat med valutaexponering. Månadsslut kräver upplupna kostnader på AWS/OpenAI/Anthropic eftersom invoices typiskt anländer 3-10 dagar in i efterföljande månad.

**Avstämning.** Stripe payout-avstämning kritisk: Stripe Reporting till bankinflöde mot 1930, Stripe-avgift mot 6570, FX-effekt mot 7960/8330. Periodisering av förutbetalda intäkter månadsvis vid bokslut och i månadsbokslut för ARR/MRR-rapportering.

**Lönekadens och kollektivavtal.** Tjänstemannaavtal dominerar: **TechSverige + Unionen** (tidigare IT&Telekomföretagen), **TechSverige + Sveriges Ingenjörer/Akavia/Ledarna**. IF Metall-avtal endast vid hårdvaruproduktion. Personaloptioner och bonus-avtal komplicerar lönerapportering: bruttolöneväxling, förmånsbeskattning vid icke-kvalificerade optioner (se §4.5).

## 3. BAS 2025 kontomönster

Verifierat mot BAS 2025 officiell kontoplan (bas.se/kontoplaner). Avvikelser från vanliga felaktiga referenser flaggade i §6.

| Konto | Officiellt namn (BAS 2025) | Branschspecifik användning |
|---|---|---|
| **1010** | Utvecklingsutgifter | Aktiverade egenutvecklade utvecklingsutgifter under K3 kap 18. Inte 1020 (= Koncessioner m.m.) |
| **1011** | Balanserade utgifter för forskning och utveckling | Vid uppdelning forskning/utveckling per K3 18.8 |
| **1012** | Balanserade utgifter för programvaror | Specifikt för aktiverad mjukvara |
| **1018** | Ackumulerade avskrivningar på balanserade utgifter | Inte 1029 |
| **2089** | Fond för utvecklingsutgifter [Ej K2] | Bundet EK, krävs vid aktivering i AB per ÅRL 4 kap 2 § |
| **2440** | Leverantörsskulder | Stora månatliga skulder mot AWS, OpenAI, Anthropic, GitHub typiska |
| **2614** | Utgående moms omvänd betalningsskyldighet 25% | Beräknad utg moms på inköp av API/moln från utlandet |
| **2645** | Beräknad ingående moms på förvärv från utlandet | Speglar 2614/2617 vid full avdragsrätt |
| **2647** | Ingående moms omvänd betalningsskyldighet, varor och tjänster i Sverige | Vid byggtjänst, ej API-import |
| **2979** | Övriga förutbetalda intäkter | Förskottsfakturerade årsprenumerationer. Inte 2972 (= förutbetalda medlemsavgifter) |
| **3001** | Försäljning inom Sverige, 25% moms | SaaS-intäkt B2B/B2C inom Sverige. Inte 3041 (existerar ej) |
| **3305** | Försäljning tjänster till land utanför EU | Export digitala tjänster, ingen svensk moms (ML 2023:200 6 kap 33 §) |
| **3308** | Försäljning tjänster till annat EU-land | B2B EU, omvänd hos köparen, rapporteras i periodisk sammanställning |
| **4531** | Inköp av tjänster från annat EU-land, 25% | AWS EMEA SARL (LU), Google Cloud EMEA (IE), Azure Ireland |
| **4535** | Inköp av tjänster från land utanför EU, 25% | OpenAI, Anthropic, Lambda Labs, RunPod, Modal, Cohere, Together AI |
| **4545** | Import av varor 25% | Endast vid hårdvaruimport (GPU). Inte 4541 (existerar ej) |
| **5410** | Förbrukningsinventarier | Datorer under halvt PBB, periferi |
| **6230** | Datakommunikation | Fiber, internet |
| **6540** | IT-tjänster | Löpande SaaS-verktyg, hosting under brytpunkt för aktivering |
| **6570** | Bankkostnader | Stripe-, Adyen-, Paddle-avgifter. Ej moms (finansiell tjänst, ML 10 kap 3 §) |
| **7630/7631/7632** | Personalrepresentation (avdragsgill/ej avdragsgill) | Teamoffsites, kickoff |
| **7699** | Övriga personalkostnader | Personaloptionskostnad K3 26.5a vid kontantreglerade. BAS 2025 har inget standardkonto för aktierelaterade ersättningar; använd 7690-gruppen + tilläggsupplysning |

**Terminologisk anmärkning.** BAS 2025 har bytt "omvänd skattskyldighet" till "omvänd betalningsskyldighet" till följd av nya mervärdesskattelagen (2023:200). Använd den nya termen i kontotexter och fakturanoteringar.

## 4. Regulatoriska kantfall

### 4.1 Intäktsredovisning för prenumerationer

**Lagrum:** ÅRL 2 kap 4 § (periodiseringsprincipen); BFNAR 2016:10 (K2) p 6.11 + 6.13 + 6.14; BFNAR 2012:1 (K3) kap 23, särskilt 23.2, 23.8, 23.13, 23.17. K3 är **inte** harmoniserat med IFRS 15; BFN:s 2025 års översyn (BFNAR 2025:3, ikraft för räkenskapsår som inleds efter 2025-12-31) behåller RR 11/IAS 18-modellen.

**Standardiserad SaaS-tjänst är inte tjänsteuppdrag** enligt K3 23.8 utan periodiseras enligt grundprincipen. Förskottsfakturerat årsabonnemang bokas på **2979** vid fakturadag och resolveras månadsvis till **3001/3305/3308**. Löpande räkning under K3 ger huvudregel 23.17 (successiv vinstavräkning). K2 6.13 är huvudregel, K2 6.14 alternativregeln (intäkt i takt med fakturering) får användas konsekvent.

**Setup/onboarding-fees.** Ej separat reglerat i K3/K2. Bedömning per K3 23.13 (avtalsdelar). Om setup inte ger fristående värde till kund: **periodisera över avtalstid eller förväntad kundlivslängd**. Fristående leverans: engångsintäkt vid leverans.

**Usage-/metered billing.** Intäkt i takt med faktisk förbrukning per K3 23.17 / K2 6.13.

**Free trials/freemium.** Ingen intäktsbokning före betalningsförpliktelse uppstår (K3 23.2 + 2.18 grundkriterier). Konverteringstid till betald plan utlöser periodiseringsstart.

**Reseller-avtal principal vs agent.** Bruttoredovisningsprincipen K3 23.2 + 2.5-2.6. Provisionsbaserat uppdrag K2 6.9: netto. Bedömning sker enligt grundprinciper, ej IFRS 15 control-test.

**Skatteverket vägledning:** rattsligvagledning, Inkomstskatt, Näringsverksamhet, Uppdrag på löpande räkning resp. fast pris (https://www4.skatteverket.se/rattsligvagledning/edition/2023.16/324730.html).

### 4.2 Aktivering av egenutvecklad mjukvara

**K3 BFNAR 2012:1 kap 18** tillåter aktivering om **samtliga sex kriterier i 18.12** är uppfyllda (tekniskt möjligt, avsikt, förmåga, sannolika ekonomiska fördelar, resurser, tillförlitlig utgiftsberäkning). Forskningsfas 18.9 är obligatorisk kostnadsföring. Val mellan kostnadsförings- och aktiveringsmodell ska göras konsekvent på samtliga internt upparbetade immateriella tillgångar (18.7). Pågående tillgångar nedskrivningsprövas årligen oavsett indikation (18.24).

**K2 BFNAR 2016:10 p 10.4** (inte 5.5 §) innehåller **absolut förbud** mot aktivering av egenupparbetade immateriella anläggningstillgångar. Utgifterna kostnadsförs när de uppkommer. Endast förvärvade immateriella tillgångar får aktiveras under K2.

**Fond för utvecklingsutgifter.** ÅRL 4 kap 2 §: aktiebolag som aktiverar måste föra över motsvarande belopp från fritt EK till **fond för utvecklingsutgifter** (bundet EK, konto 2089). ÅRL 4 kap 7 §: fonden får tas i anspråk endast för fondemission/nyemission eller förlusttäckning. ÅRL 4 kap 8 §: fonden minskas vid avskrivning/nedskrivning/avyttring med överföring till fritt EK.

**Avskrivningstid.** ÅRL 4 kap 4 § 2 st: om nyttjandeperiod inte kan fastställas tillförlitligt antas 5 år. I praktiken används 3-5 år för mjukvara.

**Strategiskt K2 vs K3-val.** Bolag med betydande utvecklingsutgifter och optionsprogram bör välja K3 från start. **Kritisk förändring 2026:** Nya K2 1.1A g (BFNAR 2025:1, ikraft för räkenskapsår som inleds efter 2025-12-31) förbjuder K2 för bolag som förvärvat varor/tjänster mot aktierelaterade ersättningar under räkenskapsåret. SaaS-startups med personaloptioner kan inte längre välja K2.

**Stoppregel K3 35.16/35.25.** Kostnadsförda utvecklingsutgifter i tidigare räkenskapsår får aldrig retroaktivt aktiveras vid modellbyte.

Skatteverket: https://www4.skatteverket.se/rattsligvagledning/edition/2025.2/324718.html.

### 4.3 Moms på digitala tjänster (ML 2023:200)

**Ny mervärdesskattelag ikraft 2023-07-01** (SFS 2023:200) ersatte ML (1994:200). Strukturen följer EU:s momsdirektiv. "Skattskyldig" har bytts till "beskattningsbar person"/"betalningsskyldig". Äldre referenser till "5 kap ML" är obsoleta.

| Transaktion | Ny ML 2023:200 | Hantering |
|---|---|---|
| B2B-tjänst inom EU (huvudregel) | **6 kap 33 §** | Omsatt i köparens land, omvänd betalningsskyldighet hos köparen. Krav VIES-validering av köparens VAT-nr; sparat verifikat. Periodisk sammanställning. Faktura: "reverse charge". Konto 3308 |
| B2B-tjänst utanför EU | **6 kap 33 §** | Omsatt utomlands, ej svensk moms. Konto 3305. Faktura: "Outside scope of Swedish VAT" |
| B2C digitala/elektroniska tjänster inom EU | **6 kap 56-57 §§**, tröskel 99 680 kr (10 000 EUR) i **6 kap 62-65 §§** | OSS-deklaration via Skatteverket (unionsordningen), destinationslandets momssats, **22 kap ML** |
| B2C tjänster utanför EU | **6 kap 58-59 §§** | Utanför svensk moms |

**OSS-valutaomräkning.** Beloppen redovisas i EUR. Vid annan transaktionsvaluta används **ECB-kursen för den SISTA dagen av redovisningsperioden** (kvartalet), eller nästa publicerade kurs om ECB inte publicerar den dagen. Detta följer EU:s momsdirektiv art. 366.

**App store / marketplace facilitator.** Skatteverkets tidigare ställningstagande 2014-12-04 dnr 131 664810-14/111 **upphävdes 2022-12-19 (dnr 8-2059749)** med motivering att EU-kommissionens förklarande anmärkningar och Skatteverkets rättsliga vägledning täcker frågan. Materiella regeln **kvarstår** via direkt tillämplig **art. 9a EU-genomförandeförordning 282/2011**: plattform (Apple App Store, Google Play) är presumerad säljare till slutkund om plattformen (a) godkänner debiteringen, (b) godkänner leveransen, eller (c) sätter allmänna villkor. Utvecklaren tillhandahåller B2B-tjänst till plattformen och tillämpar omvänd betalningsskyldighet (Apple Distribution Intl, IE-VAT; Google Commerce Ltd, IE-VAT), konto 3308 plus periodisk sammanställning. Marketplace facilitator för **varor** via elektroniskt gränssnitt: ML 2023:200 5 kap 4-6 §§.

Skatteverket: https://www4.skatteverket.se/rattsligvagledning/edition/2025.1/409182.html.

### 4.4 API-kostnader och molntjänster

**Klassificering per leverantörsetableringsland (omvänd betalningsskyldighet, ML 2023:200 6 kap 33 § + 16 kap):**

| Leverantör | Etablering | Konto inköp | Utg moms | Ing moms |
|---|---|---|---|---|
| AWS EMEA SARL | Luxemburg (EU) | 4531 | 2614 | 2645 (avdrag) |
| Google Cloud EMEA Ltd | Irland (EU) | 4531 | 2614 | 2645 |
| Microsoft Azure (Microsoft Ireland Operations) | Irland (EU) | 4531 | 2614 | 2645 |
| OpenAI LLC | USA (utanför EU) | 4535 | 2614 | 2645 |
| Anthropic PBC | USA (utanför EU) | 4535 | 2614 | 2645 |
| Mistral AI | Frankrike (EU) | 4531 | 2614 | 2645 |
| Cohere | Kanada (utanför EU) | 4535 | 2614 | 2645 |
| Lambda Labs, RunPod, Modal, Together AI | USA | 4535 | 2614 | 2645 |
| GitHub Inc | USA | 4535 | 2614 | 2645 |
| Vercel Inc | USA | 4535 | 2614 | 2645 |

VIES-validering av EU-leverantörers VAT-nummer ska göras periodiskt och dokumenteras (screenshot/timestamp). Stripe, Adyen, Paddle: betalningstjänst undantagen från moms (ML 10 kap 3 §, finansiell tjänst). Avgift bokas brutto på 6570 utan momsberäkning.

**Periodisering API-kostnader.** Matcha mot intäkt månadsvis. Vid betydande månads-end-cutoff: upplupna kostnader 2990 baserat på dashboard-rapporter (AWS Cost Explorer, OpenAI Usage). Verifikatet ska referera till underliggande rapport, faktura kommer 3-10 dagar in i nästa månad.

**Momsdeklaration ruta-rapportering (verifierat oförändrat 2025-2026):**
- Inköp tjänster annat EU-land (4531): beskattningsunderlag i **ruta 21**, utgående moms 25% i **ruta 30**, ingående avdrag i **ruta 48**
- Inköp tjänster utanför EU (4535): beskattningsunderlag i **ruta 22**, utgående moms 25% i **ruta 30**, ingående avdrag i **ruta 48**
- Försäljning tjänster B2B annat EU-land (3308): **ruta 39** plus periodisk sammanställning
- Försäljning tjänster export utanför EU (3305): **ruta 40**

### 4.5 Personaloptioner

**Kvalificerade personaloptioner, IL 11 a kap** (SFS 2017:1212, ikraft 2018-01-01; utvidgning prop. 2021/22:25, SFS 2021:1147, ikraft 2022-01-01). **Ingen ytterligare reform genomförd 2023-maj 2026.** 3:12-utredningens slutbetänkande väntades 2026-01-19 om KPO i 3:12-systemet; ingen prop. publicerad ännu (flaggad öppen fråga).

Aktuella villkor:
- Medelantal anställda (koncern) under 150 (11 a kap 6 §)
- Nettoomsättning eller balansomslutning högst 280 MSEK (11 a kap 6 §)
- Statligt ägande under 25% (11 a kap 7 §)
- Ej noterat på reglerad marknad (Spotlight/NGM Nordic SME OK) (11 a kap 7 §)
- Verksamhet ej inom juridik/skatte/redovisning/revision/bank/finans/försäkring/fastigheter (11 a kap 8 §)
- Verksamhetens ålder högst 10 kalenderår från första årsskiftet (11 a kap 9 §)
- Max optionsvärde per anställd 3 MSEK vid förvärvstidpunkt (11 a kap 13 §)
- Max totalt optionsvärde per bolag 75 MSEK (11 a kap 13 §)
- Innehavstid min 3 år, max 10 år (11 a kap 14 §)
- Min 30 h/vecka anställning; min ersättning 13 IBB under de tre första åren; styrelseledamot min 1,5 IBB/år (11 a kap 15 §)

Effekt: skatte- och socialavgiftsbefrielse vid förvärv och utnyttjande; vinst beskattas som kapitalvinst hos optionsinnehavaren vid avyttring av aktien.

**Icke-kvalificerade personaloptioner**, IL 10 kap 11 §: förmånsbeskattning vid utnyttjande som lön (tjänsteinkomst), arbetsgivaravgifter på förmånsvärdet.

**Teckningsoptioner**, IL 41-44 kap: beroende på utformning antingen kapitalvinst- eller tjänstebeskattning per HFD-praxis.

**Bokföring K3 kap 26 "Aktierelaterade ersättningar":**
- Egetkapitalreglerade (vanliga personaloptioner, KPO): kostnad redovisas över intjänandeperiod mot eget kapital (26.3, 26.5a, 26.6-26.7). Verkligt värde vid tilldelningstidpunkten, omvärderas ej. Endast antalet förväntat intjänade instrument justeras varje balansdag.
- Kontantreglerade (syntetiska optioner, SARs): skuld baserad på aktiekurs, omvärderas (26.4, 26.5b).
- Sociala avgifter på samma sätt som ersättningen (26.20).
- Värderingsmodell (Black-Scholes, binomial) ej föreskriven i K3 men praxis.

**K2 (BFNAR 2016:10) saknar regler för aktierelaterade ersättningar.** Nuvarande K2: tolkning utifrån grundprinciper, typiskt ingen kostnad vid equity-settled. **Nya K2 (BFNAR 2025:1) ikraft för räkenskapsår som inleds efter 2025-12-31, p 1.1A g: bolag som under räkenskapsåret förvärvat varor/tjänster mot aktierelaterade ersättningar får inte tillämpa K2.** Byte till K3 obligatoriskt.

Skatteverket: https://www4.skatteverket.se/rattsligvagledning/edition/2024.3/399929.html (KPO); https://www4.skatteverket.se/rattsligvagledning/edition/2024.3/324733.html (aktierelaterade ersättningar).

### 4.6 3:12-reglerna efter 2026 års reform

**REFORM IMPLEMENTERAD 2026-01-01.** Prop. 2025/26:1 (budgetpropositionen, "Enklare och bättre skatteregler för delägare i fåmansföretag"), bet. 2025/26:FiU1, rskr. 2025/26:65. Bygger på SOU 2024:36. Ändringar i IL 57 kap gäller från räkenskapsår som börjar efter 2025-12-31.

**Huvudförändringar:**
- Förenklingsregeln och huvudregeln slopas, ersätts av **EN beräkningsregel** för årets gränsbelopp = grundbelopp + lönebaserat utrymme + ränta på omkostnadsbelopp
- **Grundbelopp** = 4 IBB året före beskattningsåret (för 2026: 4 × 80 600 = 322 400 kr), fördelas proportionellt mellan delägare
- **Lönebaserat utrymme** = 50% × (delägarens andel av löneunderlaget minus schablonavdrag 8 IBB = 644 800 kr för 2026)
- **Löneuttagskravet (6 IBB plus 5% av total lön) är SLOPAT** och ersätts av schablonavdraget på 8 IBB. Central förändring jämfört med tidigare regelverk
- **4%-spärren (kapitalandelskravet) slopas**, alla delägare oavsett andel kan nyttja lönebaserat utrymme
- 50×-taket på egen lön kvarstår
- Ränta på omkostnadsbelopp = SLR + 9 pe, endast på omkostnadsbelopp över 100 000 kr
- Ränteuppräkning av sparat utdelningsutrymme slopas
- Karenstid (trädabolag, utomståenderegel) förkortas från 5 till 4 år (tillämpas första gången för räkenskapsår som börjar efter 2026-12-31)
- Index- och kapitalunderlagsreglerna slopas (övergångsbestämmelser t.o.m. beskattningsår som börjar före 2029-01-01)
- Tjänstebeskattningstak utdelning 90 IBB; kapitalvinst 100 IBB (oförändrat)

K10-blankett ska lämnas årligen av varje delägare som äger kvalificerade andelar.

### 4.7 Investerare och konvertibler

**Konvertibla skuldebrev (KVL)** regleras av **ABL 15 kap** (emissionsbeslut, riktade emissioner, registrering). Redovisning K3 BFNAR 2012:1 kap 22 "Finansiella instrument": konvertibel uppdelas i skuldkomponent (diskonterat kassaflöde till marknadsränta) och egetkapitalkomponent (residual). K2 saknar uppdelningskrav, redovisas som skuld till nominellt belopp.

**Investeraravdrag, IL 43 kap.** Oförändrade beloppsgränser 2024-maj 2026; mindre teknisk EU-statsstödsanpassning prop. 2023/24:80, ikraft 2024-07-01:
- Avdrag 50% av betalningen för andelar vid bildande eller nyemission
- Max underlag per fysisk person/år: **1 300 000 kr**, max avdrag 650 000 kr/år
- Skatteeffekt 30% av avdraget = max 195 000 kr/år
- Max per företag/år: 20 MSEK samlat underlag
- Återföring vid avyttring/värdeöverföring inom 5 år (43 kap 22, 25, 26, 27 §§ IL)
- Företaget får ej ha varit verksamt på marknad mer än 7 år efter första kommersiella försäljning (anpassning 2024)
- Juridiska personer får ej avdrag

Skatteverket: https://www.skatteverket.se/privat/skatter/vardepapper/investeraravdrag.

**SAFE (Simple Agreement for Future Equity).** Rättslig kvalificering osäker under svensk rätt: kan klassificeras som konvertibel skuld (KVL-regelverk, ABL 15 kap) eller villkorat aktieägartillskott beroende på utformning. Skatteverket har inget publicerat ställningstagande specifikt för SAFE. Bedöm per avtalsutformning: om återbetalningsskyldighet vid t.ex. likvidation, skuldinstrument; om endast konverteringsrätt utan återbetalning, egetkapitalkaraktär. Flaggas för humangranskning vid varje SAFE-avtal.

### 4.8 Internationell struktur

**US Delaware C-corp parent + svenskt opco** (YC-/Stripe Atlas-struktur). Vanlig vid YC, US VC-runda eller global enterprise-försäljning.

**Transfer pricing.** Korrigeringsregeln armlängdsprincipen **IL 14 kap 19-20 §§** (HFD 2016:45 Diligentia). Bedömning enligt OECD TPG. För svenskt opco som utvecklingscentrum: typiskt **cost-plus** med markup 5-12% beroende på funktion/risk; opcot bär kontraktsutvecklarrisk.

**Dokumentationsskyldighet.** **39 kap 15-16 f §§ skatteförfarandelagen (2011:1244), SFL** (inte IL). Master file/local file-struktur per BEPS Action 13 (prop. 2016/17:47, ikraft för beskattningsår som börjar efter 2017-03-31). Undantag 39 kap 16 a § SFL: intressegemenskap med under 250 anställda och omsättning högst 450 MSEK eller balansomslutning högst 400 MSEK befrias från dokumentation. Land-för-land-rapportering 33 a kap SFL.

**Fast driftställe (PE-risk).** Bedömning per OECD modellavtal art. 5 och svenska skatteavtal. Risk att US parent har PE i Sverige om svenska anställda har avtalsmandat ("dependent agent PE"). Mitigera genom: skriftliga begränsningar, ingen avtalsslutning i Sverige för USA-räkning, separata kontrakt till svenskt opco.

Skatteverket: https://www4.skatteverket.se/rattsligvagledning/edition/2025.1/324857.html (korrigeringsregeln).

### 4.9 FoU-avdrag och växa-stöd

**FoU-avdrag på arbetsgivaravgifter.** **Lag (2023:747)** om särskilt avdrag vid beräkning av arbetsgivaravgifter och allmän löneavgift för personer som arbetar med FoU, ikraft 2024-01-01 (prop. 2023/24:14). Ersatte tidigare regler i socialavgiftslagen 2 kap 29-31 §§.

- Avdrag = 20% av avgiftsunderlaget för FoU-personal
- **Sammanlagt tak per koncern och kalendermånad: 3 MSEK** (1,5 MSEK från arbetsgivaravgifterna plus resterande från allmän löneavgift), 8 § lag 2023:747
- Arbetstidskrav: minst 50% av faktisk arbetstid OCH minst 15 timmar/månad med FoU (7 § lag 2023:747; sänkt från 75% till 50% prop. 2020/21:110 ikraft 2021-07-01)
- Får ej innebära att avgifterna understiger ålderspensionsavgiften 10,21%

Pågående utredning (dir. 2023:81, tilläggsdir. 2024:104) om återbetalningsbar skattereduktion; delbetänkande 2025-01-15, slutbetänkande 2026-01-19. Ingen prop. publicerad i maj 2026.

Skatteverket: https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/forskningsavdrag.

**Växa-stöd.** Lag (2016:1053) om särskild beräkning av vissa avgifter för enmansföretag.

Förändringar:
- **2025-01-01**: utvidgning till **två anställda**, lönetak höjt 25 000 till 35 000 kr/månad
- **2026-01-01**: omlagt till **återbetalningsmodell** (prop. 2025/26:24 "Anpassning av vissa skatte- och avgiftsnedsättningar till EU:s regler om statsstöd"). Arbetsgivaren betalar full avgift och ansöker om återbetalning via Skatteverkets e-tjänst månadsvis. Anpassning till EU de minimis-stödsregistrering.

Aktuella regler 2026:
- Arbetsgivaravgift sänks till 10,21% på de första 35 000 kr/månad per anställd
- 24 kalendermånader, anställning minst 3 månader och 20 h/vecka
- De minimis-tak 300 000 EUR samlat statsstöd över 3 år
- Övergång: anställningar påbörjade före 2024-05-01 går på gamla regler resten av 24-månadersperioden

Skatteverket: https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/vaxastod/reglerforvaxastod.

### 4.10 EU AI Act (förordning (EU) 2024/1689)

Ikraft 2024-08-01. Tillämpningsdatum staggrade per art. 113.

| Tier | Originaldatum | Status maj 2026 |
|---|---|---|
| Förbjudna AI-praktiker (art. 5) plus AI-kompetens (art. 4) | 2025-02-02 | Tillämpas |
| GPAI-modeller (art. 51-55), governance (kap VII), notified bodies (kap III §4), sanktioner (kap XII) | 2025-08-02 | Tillämpas |
| Annex III high-risk-system plus transparens (art. 50) | 2026-08-02 | **Skjuts upp till 2027-12-02** per Digital Omnibus-överenskommelse 2026-05-07 (preliminär, ej publicerad i OJEU) |
| Annex I high-risk produktsäkerhet (art. 6(1)) | 2027-08-02 | **Skjuts upp till 2028-08-02** per Digital Omnibus |

Digital Omnibus-tillägg (preliminär överenskommelse 2026-05-07): art. 50(2) vattenmärkning av AI-genererat innehåll övergångsperiod till 2026-12-02; nationella regulatoriska sandlådor 2027-08-02; ny prohibited practice (NCII/nudifier-AI); SMC-kategori (small mid-cap) med lättad börda. **GPAI- och prohibited-practice-deadlines påverkas ej.**

**Bokföringsmässig hantering.** Conformity assessment-kostnader (notified body-avgift, intern compliance, dokumentation enligt art. 11) ska klassificeras per K3 18.12 / IAS 38:
- Externa avgifter och dokumentationsarbete direkt hänförliga till en specifik AI-systemvariant under utveckling: kan aktiveras som del av utvecklingsutgift om 18.12-kriterierna uppfylls
- Löpande compliance/övervakning post-marknad (art. 72), AI-litterati-träning (art. 4): kostnadsförs som driftskostnad (6540/7510)
- K2-bolag: alltid kostnadsföring (10.4 §)

EUR-Lex: https://eur-lex.europa.eu/eli/reg/2024/1689/oj.

Digital Omnibus ej formellt antagen/publicerad maj 2026. Tills OJEU-publikation gäller originaldeadlines formellt. Flaggas som öppen fråga §6.

## 5. De tre högsta felfrekvens-scenariorna

### 5.1 Årsprenumeration bokas som intäkt direkt

**Fel.** Vid fakturering av 12-månaders prenumeration 120 000 kr 2026-01-15:
```
1510 Kundfordringar     150 000 D
  3001 Försäljning 25%       120 000 K
  2610 Utgående moms 25%      30 000 K
```

**Rätt.** Intäkten ska periodiseras över abonnemangsperioden:
```
2026-01-15 (fakturering):
1510 Kundfordringar     150 000 D
  2979 Övriga förutbetalda intäkter   120 000 K
  2610 Utgående moms 25%               30 000 K

Månadsvis 2026-01-31, 02-28, ..., 2026-12-31 (12 ggr × 10 000):
2979 Övriga förutbetalda intäkter    10 000 D
  3001 Försäljning 25%                10 000 K
```

**Lagrum.** ÅRL 2 kap 4 § (periodiseringsprincipen); BFNAR 2012:1 (K3) 23.2 + 23.13; BFNAR 2016:10 (K2) 6.11 + 6.13.

**Anmärkning.** Konto **2979** (Övriga förutbetalda intäkter), inte 2972 (Förutbetalda medlemsavgifter).

### 5.2 OpenAI-faktura bokas utan omvänd betalningsskyldighet

**Fel.** OpenAI USD-faktura 1 000 USD bokas direkt mot bank utan momsberäkning:
```
6540 IT-tjänster                1 000 D
  1930 Bank                        1 000 K
```

**Rätt.** Omvänd betalningsskyldighet ska tillämpas eftersom OpenAI LLC är etablerad utanför EU och tillhandahåller B2B-tjänst till svensk beskattningsbar person:
```
4535 Inköp tjänster från land utanför EU 25%   1 000 D
2645 Beräknad ingående moms på förvärv         250 D
  1930 Bank                                      1 000 K
  2614 Utgående moms omv betaln.skyld 25%          250 K
```

**Lagrum.** ML 2023:200 6 kap 33 § (huvudregel B2B-tjänst, omsatt i köparens land); ML 2023:200 16 kap (omvänd betalningsskyldighet); art. 196 EU:s momsdirektiv 2006/112/EG.

**Momsdeklaration.** Beskattningsunderlag i **ruta 22**, utg moms 25% i **ruta 30**, ing moms-avdrag i **ruta 48**. (Ruta 21 plus 30 är korrekt för EU-inköp 4531, fel ruta för 4535 utanför EU.)

**Anmärkning.** Äldre referens till "ML 5 kap 5 §" gäller gamla mervärdesskattelagen (1994:200). Ny ML 2023:200 har bestämmelsen i 6 kap 33 § (plats för tillhandahållande) och 16 kap (vem är betalningsskyldig).

### 5.3 Egenutvecklad mjukvara aktiveras i K2-bolag

**Fel.** K2-bolag bokar 500 000 kr utvecklarlönedel:
```
1010 Utvecklingsutgifter           500 000 D
  7010 Löner                          500 000 K
```

**Rätt under K2.** Aktivering förbjuden, hela lönekostnaden kostnadsförs:
```
7010 Löner till tjänstemän         500 000 D
2730 Lagstadgade soc.avg            ca 157 100 D (31,42%)
  1930/2710/2731 Bank/skatte-/avg.skuld   657 100 K
```

**Lagrum.** BFNAR 2016:10 (K2) **punkt 10.4**: "Företag som tillämpar K2 får inte redovisa egenupparbetade immateriella anläggningstillgångar som tillgångar i balansräkningen. Utgifterna ska i stället redovisas som kostnad i resultaträkningen."

**Åtgärd.** Byte till K3 (BFNAR 2012:1) krävs för aktivering. Då tillämpas K3 18.12 (sex aktiveringskriterier), 18.8 (forskningsfas vs utvecklingsfas), och ÅRL 4 kap 2 §: motsvarande belopp överförs från fritt EK till **fond för utvecklingsutgifter** (konto 2089). Stoppregel K3 35.16/35.25: kostnadsförda utvecklingsutgifter i tidigare räkenskapsår får aldrig retroaktivt aktiveras.

**Bonusvarning från 2026.** Nya K2 1.1A g (BFNAR 2025:1) tvingar redan bolag med personaloptionsprogram över till K3. SaaS-startups med både utvecklingskostnader och optioner bör därför inte starta i K2.

## 6. Öppna frågor

1. **3:12-reform SFS-nummer.** Sekundärkälla anger SFS 2025:1361 för ändringen av IL 57 kap. Verifiera direkt mot svenskforfattningssamling.se. Prop., bet., rskr. och ikraftträdande 2026-01-01 är dock bekräftade via flera oberoende rådgivare (PwC, Forvis Mazars, SRF konsulterna).

2. **KPO-utredning slutbetänkande.** 3:12-utredningens slutbetänkande väntades 2026-01-19 med förslag på hur KPO-aktier ska beskattas under 3:12-reglerna. Per maj 2026: ingen prop. publicerad. Följ regeringen.se. Eftersom 4%-spärren slopades i 3:12-reformen 2026 har vissa friktionspunkter redan adresserats.

3. **EU AI Act Digital Omnibus.** Preliminär politisk överenskommelse 2026-05-07 om uppskjutna deadlines (Annex III till 2027-12-02). Ej formellt antagen eller publicerad i OJEU per maj 2026. Tills OJEU-publikation gäller originaltidsplanen i (EU) 2024/1689 formellt; Kommissionen har dock signalerat förbearance. Kontrollera EUR-Lex för slutlig text.

4. **App store-ställningstagande.** Korrekt referens: ställningstagande dnr 131 664810-14/111 (2014-12-04) **upphävt 2022-12-19 dnr 8-2059749**. Materiella regeln gäller via art. 9a EU 282/2011.

5. **K3 kap 26 värderingsmodell.** K3 föreskriver inte specifik optionsvärderingsmodell. Black-Scholes praxis för publika underliggande aktier; binomial- eller Monte Carlo-modeller vid komplexa villkor. För onoterade SaaS-bolag krävs ofta extern värdering eftersom underliggande aktievärde inte är observerbart.

6. **SAFE-avtal kvalificering.** Inget Skatteverket-ställningstagande eller HFD-praxis specifikt för SAFE. Bedöms per avtalsutformning enligt allmänna principer; återbetalningsskyldighet vid likvidation indikerar skuld (KVL ABL 15 kap), pur konverteringsrätt utan return-of-capital indikerar egetkapitalkaraktär. Humangranskning per avtal rekommenderad.

7. **FoU-avdrag återbetalningsbar skattereduktion.** Utredning pågår (slutbetänkande 2026-01-19). Eventuell ny modell tidigast 2027.

## 7. Modifier: ai-heavy

Aktiveras när **API-leverantörer (OpenAI, Anthropic, Mistral, Cohere, Lambda Labs, RunPod, Modal, Together AI) över 15% av total kostnad** ELLER **konto 4535 över 15% av totala kostnader**.

**Token-baserad kostnadsallokering.** API-kostnader allokeras per kund/produkt baserat på faktisk token-konsumtion från leverantörens usage-API:
- OpenAI: organization.usage endpoint
- Anthropic: workspaces usage report
- AWS Bedrock: CloudWatch metrics per modell-ARN

Lagra kund-ID i request metadata och avstäm månadsvis. Allokering bokas via interna fördelningskonton (4910-4998-gruppen) eller direkt mot kund-/produkt-dimensioner i redovisningssystemet (Fortnox projektdimension, Visma kostnadsbärare).

**COGS-attribution per kund.** Möjliggör verklig bruttomarginalsanalys per kund/plan, kritiskt för pricing och churn-modellering. Den månatliga matchningen API-cost mot intäkt sker via:
1. Periodiserad intäkt månadsvis från 2979 till 3001/3305/3308
2. Faktisk API-kostnad månadsvis på 4535
3. Bruttomarginal per kund = intäkt minus allokerad API-kostnad minus Stripe-avgift (6570)

**Omvänd betalningsskyldighet bulk-hantering.** Vid många små API-fakturor (t.ex. OpenAI weekly invoicing): batch-bokning per månad mot 4535 plus spegelposter 2614/2645 acceptabelt om underliggande fakturasummering bifogas verifikatet. Verifieringsspår per faktura krävs för Skatteverkets revision.

**AI Act conformity-kostnader.** För high-risk AI-system (Annex III): notified body-avgifter, riskhanteringssystem (art. 9), data governance-dokumentation (art. 10), teknisk dokumentation (art. 11), kvalitetsledningssystem (art. 17), post-market monitoring (art. 72). Bedömning aktivering vs opex:
- Aktivering tillåten under K3 18.12 endast om kostnader är direkt hänförliga till specifik AI-systemvariant under utveckling och övriga sex kriterier uppfylls
- Övergripande compliance-infrastruktur, governance, AI-litterati (art. 4): kostnadsförs (typiskt 6540, 7610 personalutbildning, 6550 konsultarvoden)
- K2-bolag: alltid kostnadsföring

**GPU-compute spend.** Stora månatliga GPU-kostnader (Lambda Labs, RunPod, Modal, Together AI) på 4535 plus 2614/2645. Reserved capacity / committed spend ska periodiseras enligt avtalsperioden: förskottsbetalning bokas mot 1790 (övriga förutbetalda kostnader) och resolveras månadsvis till 6540 eller 4535 beroende på behandling i momshänseende.
