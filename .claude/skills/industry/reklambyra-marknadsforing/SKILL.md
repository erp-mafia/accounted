---
id: vertical/reklambyra-marknadsforing
tier: vertical
title: "Reklambyrå & marknadsföring (SNI 73.11 / 73.12 / 70.21 / 74.10)"
description: >
  Svensk bokföring och skattecompliance för reklambyråer, mediabyråer, PR-byråer och designbyråer (SNI 73.11, 73.12, 70.21, 74.10). Ladda när verifikat innehåller mediainköp, byråprovision/agency fee, royalty- eller licensavgifter, A-SINK-utbetalningar till utländska artister/influencers, sponsringsavtal, eller fakturor från Google Ads, Meta Ads, TikTok Ads med omvänd betalningsskyldighet. Distinkta arbetsflöden: principal-vs-agent-bedömning för mediainköp (brutto vs netto enligt K3 kap 23 och IFRS 15 B34-B38), omvänd betalningsskyldighet på utländska digitala annonseringstjänster (ML 2023:200 6 kap 33 § och 16 kap), royalty och licensintäkter inkl. 25 % moms på reklamalster (undantag från 6 %-satsen), A-SINK 15 % på utländska artister och gränsdragning för influencers (SFS 1991:591), samt sponsringsavdrag med dokumenterad motprestation (RÅ 2000 ref. 31, HFD 2018 ref. 55).
sni_prefixes: ["73.11", "73.12", "70.21", "74.10"]
trigger_signals:
  text_patterns:
    - "mediainköp"
    - "byråprovision"
    - "agency fee"
    - "retainer"
    - "mark-up"
    - "royalty"
    - "licensavgift"
    - "A-SINK"
    - "sponsring"
    - "influencer"
    - "Google Ads"
    - "Meta Ads"
    - "kreativ produktion"
    - "kampanjproduktion"
  bas_account_signals:
    - "3922"
    - "3921"
    - "6910"
    - "5970"
    - "5980"
    - "5420"
    - "6540"
    - "6559"
    - "4535"
    - "4531"
    - "2614"
    - "2645"
    - "1620"
    - "2450"
estimated_tokens: 9800
version: 1
---

# Reklambyrå och marknadsföring: vertikal compliance-atom

## 1. När denna skill används

Tillämpas när bokföringsobjektet bedriver verksamhet under SNI 73.11 (Reklambyråverksamhet), 73.12 (Mediebyråverksamhet och annonsförsäljning), 70.21 (PR och kommunikation) eller 74.10 (Specialiserad designverksamhet). Triggas också av blandade kreativa konsultverksamheter där intäkter består av en kombination av kreativt arvode, mediainköp för kunds räkning, royalty/licens och influencer-/produktionsarvoden. Vid renodlad bemanning, eventproduktion utan kreativt innehåll, eller publicistisk verksamhet (dagstidning, etermedia): använd annan vertikal.

## 2. Typiska arbetsflödesmönster

**Faktureringsrytm**: Tre grundmönster förekommer parallellt och måste hållas isär bokföringsmässigt. **Retainer-arvode** faktureras månatligen i förskott eller efterskott och redovisas i normalfallet som löpande räkning enligt 17 kap 26 § IL (intäkt = fakturerat belopp, frikoppling från redovisning enligt RÅ 2006 ref. 28). **Kampanj-/projektarvode till fast pris** sträcker sig ofta över 2-6 månader och kräver successiv vinstavräkning enligt K3 kap 23.18 eller färdigställandemetoden enligt K3 23.31 / K2 6.22 (juridisk person, konsultrörelse i 17 kap 23 § IL). **Media payout** följer mediets faktureringscykel (ofta månatlig per kanal) och kräver separat avstämning mot kundens kampanjbudget.

**Kostnadsrytm**: Mediainköp dominerar volymen och måste klassificeras månadsvis som principal-inköp (vidarefaktureras med marginal) eller utlägg (genomgångspost). Frilansararvoden från svenska F-skattare bokas på 6559 Övrig konsultverksamhet (eller 6550). SaaS- och AI-prenumerationer (Adobe Creative Cloud, ChatGPT Teams, Midjourney, Figma, Claude) bokförs löpande på **5420 Programvaror**; externa AI-konsulttjänster eller API-användning på **6540 IT-tjänster**. Stockfoto- och fontlicenser bokförs på **6910 Licensavgifter och royalties**.

**Avstämningstiming**: Pågående arbeten på löpande räkning (1620 Upparbetad men ej fakturerad intäkt / 2450 Fakturerad men ej upparbetad intäkt) stäms av månatligen. Mediainköpsavräkning mot kund görs vid kampanjavslut eller månatligen vid längre kampanjer.

**Kollektivavtal**: Samtliga fyra SNI-koder omfattas av **Gröna avtalet**: Tjänstemannaavtalet mellan Almega Tjänsteföretagen/Medieföretagen och Unionen/Akademikerförbunden (Akavia kontaktförbund). Innevarande period **2025-05-01 till 2027-04-30**, avtalsvärde 6,4 % (löneökningar 5,5 %, arbetstidsförkortning 0,5 %, flexpension 0,4 %). Almega Kompetensföretagen tillämpas inte om byrån inte bedriver bemanningsverksamhet. Chefer omfattas av Ledaravtalet mellan Almega och Ledarna.

## 3. BAS 2025-kontomönster

Verifierat mot BAS 2025 (Kontoplan-BAS-2025.xlsx, bas.se). Notera att BAS 2025 har bytt terminologi från **"skattskyldighet" till "betalningsskyldighet"** på samtliga moms-konton 2614/2624/2634/2642/2647/4415-4417/4425-4427: kontonumren oförändrade men kontonamnen är nya per 2025-01-01.

| Konto | BAS 2025-namn | Vertikalspecifik kontext |
|---|---|---|
| **1040** | Licenser | Förvärvade licenser till mjukvara/varumärken som aktiveras (ej egenupparbetade, förbjudet i K2 10.4, stopplista K3 18.5 för internt upparbetade varumärken). |
| **1620** | Upparbetad men ej fakturerad intäkt | Löpande räkning-uppdrag där arbete utförts men ej fakturerats vid balansdagen; alternativmetoden enligt K2/K3. |
| **1471** | Pågående arbeten, nedlagda kostnader | Fast pris-uppdrag (kampanjproduktion) vid färdigställandemetoden: aktiverade utgifter per uppdrag, ej kvittning mellan uppdrag (K2 6.24 efter BFNAR 2025:1). |
| **2450** | Fakturerad men ej upparbetad intäkt | Spegelbild av 1620; à conto/förskott vid retainer eller fast pris (jfr 17 kap 28 § IL). |
| **2614** | Utgående moms, omvänd betalningsskyldighet, 25 % | Google Ads (Google Ireland), Meta Ads, TikTok, LinkedIn: beräknad utgående moms vid tjänsteförvärv från utländsk beskattningsbar person enligt 6 kap 33 § + 16 kap ML 2023:200, rapporteras ruta 30. |
| **2645** | Beräknad ingående moms på förvärv från utlandet | Motpost till 2614; rapporteras ruta 48 (full avdragsrätt för momspliktig byråverksamhet). |
| **3308** | Försäljning tjänster till annat EU-land | B2B-fakturering till EU-kund med omvänd betalningsskyldighet (kundens land), ruta 39 + periodisk sammanställning. |
| **3305** | Försäljning tjänster till land utanför EU | B2B-export till t.ex. UK, US, Norge, ruta 40. |
| **3922** | Licensintäkter och royalties | **Inte 3070**: i BAS 2025 ligger royalty-intäkter på 3922 under huvudgrupp 3920 Provisionsintäkter, licensintäkter och royalties. |
| **3921** | Provisionsintäkter | Mediabyråprovision (agency commission) när byrån är agent: ren nettoredovisning. |
| **3996** | Erhållna reklambidrag | Marknadsföringsbidrag från leverantörer/varumärken. |
| **4531** | Inköp av tjänster från ett land utanför EU, 25 % moms | Kopplingskonto för rapportering ruta 22 (TikTok från icke-EU, Adobe US, OpenAI US). |
| **4535** | Inköp av tjänster från annat EU-land, 25 % | Kopplingskonto ruta 21 (Google Ireland, Meta Ireland, LinkedIn Ireland, Spotify Ireland). |
| **5420** | Programvaror | SaaS- och AI-prenumerationer (Adobe CC, ChatGPT Teams, Midjourney, Claude Pro, Figma). |
| **5970** | Film-, radio-, TV- och Internetreklam | Byråns egna mediainköp för egen marknadsföring (inte kundens kampanjer). |
| **5980** | PR, institutionell reklam och sponsring | **Sponsringsutgifter med dokumenterad motprestation**: separera avdragsgill del från eventuell gåvodel (jfr RÅ 2000 ref. 31). |
| **6071** | Representation, avdragsgill | OBS: I BAS är 6071 *avdragsgill* och 6072 *ej avdragsgill*: vanligt invertfel. Måltidsrepresentation 2025 endast moms-avdragsgill (60 kr/person ink. moms), inte inkomstskattemässigt. |
| **6072** | Representation, ej avdragsgill | Den del av sponsringspaket eller kundbjudningar som inte uppfyller motprestationskrav. |
| **6540** | IT-tjänster | Externa molntjänster, AI-API-användning (OpenAI API, Anthropic API), DevOps. |
| **6559** | Övrig konsultverksamhet | **Frilansande kreatörer med F-skatt** (copywriters, art directors, foto, motion designers). |
| **6860** | Inhyrd marknads- och försäljningspersonal | Bemanningsföretag för marknadsfunktioner. |
| **6910** | Licensavgifter och royalties | **Inte 4070**: royaltykostnader (stockfoto, fonter, musik, varumärkeslicens, royalty till upphovsman) ligger i klass 6, inte klass 4. |
| **7331** | Skattefria bilersättningar | Resor till kundpresentationer/inspelningsplatser (18,50 kr/mil 2025). |

Konton som **inte** används för denna vertikal trots vanliga missförstånd: 1060 (Hyresrätter, tomträtter, *inte* licenser), 7610 (Utbildning, *inte* frilansare), 7690 (Övriga personalkostnader, *inte* frilansare). Frilansare hör alltid till klass 6, inte klass 7.

## 4. Regelmässiga gränsfall

### 4.1 Moms unik för vertikalen

**Omvänd betalningsskyldighet på utländska digitala annonseringstjänster.** Google Ads (Google Ireland Ltd), Meta Ads (Meta Platforms Ireland Ltd), TikTok Ads (TikTok Ireland), LinkedIn Marketing Solutions (LinkedIn Ireland), X/Twitter Ads omfattas alla av huvudregel B2B i **6 kap 33 § ML 2023:200**: tjänsten är omsatt i Sverige när köparen är beskattningsbar person etablerad här. Betalningsskyldigheten övergår enligt **16 kap ML 2023:200** (motsvarar gamla 1 kap 2 § första stycket 2 ML 1994:200) till svenska köparen. Säljarens faktura ska vara utan moms och innehålla notering "Reverse charge / Omvänd betalningsskyldighet" samt svenska köparens VAT-nummer. Byrån redovisar **25 % utgående moms i ruta 30, beskattningsunderlag i ruta 21 (EU-säljare) eller 22 (icke-EU), ingående moms i ruta 48**. Nettoeffekt = 0 vid full avdragsrätt. Konton: 2614 + 2645 med motkonto 4535 (EU) eller 4531 (icke-EU). Skatteverkets vägledning: skatteverket.se/foretag/moms/sarskildamomsregler/handelmedandralander/momsreglerforutlandskaforetagare. EU-rättslig grund: art. 196 i mervärdesskattedirektivet 2006/112/EG.

**Mediainköp: utlägg vs vidarefakturering.** Skatteverkets utlägg-doktrin (skatteverket.se/foretag/moms/sarskildamomsregler/utlaggochvidarefakturering) kräver **tre kumulativa villkor** för att mediainköp ska klassas som genomgångspost: (a) slutkunden har eget betalningsansvar mot mediet, (b) inget vinstpålägg, (c) bokförs på balanskonto, inte i resultaträkningen. Underliggande mediafaktura ska vara utställd till slutkunden (eller "c/o byrån"). Vid utlägg har byrån **ingen avdragsrätt för ingående moms**: fakturakopian ska vidareöverlämnas till slutkunden som drar av. I praktiken uppfyller typiska mediabyråmodeller sällan villkoren eftersom byrån är avtalspart mot mediet: det är då **vidarefakturering** (avdrag för ingående moms, påslag av 25 % utgående moms vid vidarefakturering) eller **kostnadskomponent** i en sammansatt byråtjänst. Beskattningsunderlag enligt 8 kap ML 2023:200.

**Royalty och licensavgifter: moms.** Generell skattesats **25 % enligt 9 kap 2 § ML 2023:200**. Reducerad sats 6 % för vissa upphovsrättsöverlåtelser enligt 1, 4 eller 5 §§ URL i 9 kap ML 2023:200 (motsvarar gamla 7 kap 1 § tredje stycket 8 ML 1994:200): men **reklamalster är uttryckligen undantagna från 6 %-satsen**. Reklamfilm, reklamfoton, copy, layouts och kampanjmaterial som upplåts eller överlåts utlöser därför alltid 25 % moms även när royalty/licensavgift utgör ersättning. Licens (upplåtelse) och fullständig överlåtelse behandlas momsmässigt identiskt. Vid royalty till utländsk rättighetshavare: omvänd betalningsskyldighet 25 % (B2B, 6 kap 33 § ML), Sverige tar inte ut kupongskatt på royalty.

**Influencer-marketing: moms.** Tre statusscenarier: **(1) privatperson / hobby** (omsättning ≤ 80 000 kr enligt 18 kap 2 § ML 2023:200): ingen moms, byrån gör skatteavdrag 30 % och betalar arbetsgivaravgifter om influencern saknar F-skatt; **(2) F-skattad / momsregistrerad svensk**: 25 % moms på marknadsföringstjänst, avdragsgill för byrån; **(3) utländsk beskattningsbar person**: omvänd betalningsskyldighet 25 % enligt 16 kap ML 2023:200. **Barter (varor mot exponering)** utgör byte = två omsättningar enligt Skatteverkets generella tolkning: företaget anses ha sålt produkten till marknadsvärde med 25 % moms, influencern har sålt marknadsföringstjänst till samma värde. Skatteverket har bedrivit specialgranskning av branschen 2024-2025; portal skatteverket.se/influencer. Inget enskilt numrerat ställningstagande dedikerat enbart till "influencer-moms" har publicerats: frågan styrs av generella momsprinciper.

**Sponsring och moms.** Ingående moms avdragsgill enligt **13 kap 6 § ML 2023:200** endast i den utsträckning utgiften hänförs till momspliktig verksamhet och uppfyller följande **kumulativa villkor** (Skatteverkets ställningstagande dnr 130 702489-04/113, **2005-06-27**, fortfarande gällande per Rättslig vägledning edition 2025.3): (i) dokumenterad motprestation i skriftligt sponsoravtal, (ii) motprestationen värderad till marknadsvärde, (iii) motprestationen faktiskt utnyttjad, (iv) varje del av sponsringspaketet bedöms separat (reklamskyltar = avdragsgillt; biljetter/representation = begränsat; rena gåvor = inget avdrag), (v) ren goodwill-/imagesponsring utan motprestation = gåva = inget momsavdrag. Kompletterande skrivelse om kultursponsring: dnr 131 476491-09/111, 2009-05-20.

**OSS: sällan tillämpligt.** OSS enligt 22 kap ML 2023:200 aktualiseras endast om byrån säljer digitala tjänster B2C till privatpersoner i andra EU-länder (t.ex. egna kurser, mallpaket, prenumerationer) och överskrider tröskeln **99 680 kr (10 000 EUR) per kalenderår sammanlagt**. Typiska B2B-byråtjänster är inte OSS-relevanta. **Flagga vid produktiserade B2C-erbjudanden**.

### 4.2 Bokföring unik för vertikalen

**Principal vs agent: K3 kap 23 / IFRS 15 B34-B38.** Avgörande för om mediainköp ska bruttoredovisas (inköp + intäkt) eller nettoredovisas (endast provision = 3921). **K3 punkt 23.2**: endast inflöde "för egen räkning" är intäkt. Vid agentrelation redovisas endast förmedlingsersättning. **IFRS 15 B37-indikatorer på huvudmannaskap** (relevant även som vägledning under K3 och vid RFR 2): (1) primärt ansvar mot kund för leveransen, (2) lager-/avbokningsrisk på medieutrymmet, (3) prissättningsfrihet, (4) kreditrisk mot kund, (5) substituerings-/kontrollmöjlighet. **Mediabyrå är principal** vid eget inköp i eget namn med påslag/marginal, egen kreditrisk och prissättningsfrihet → bruttoredovisning. **Agent** vid fast byråprovision, inköp i kundens namn eller utan kredit-/prissättningsrisk → endast provision intäktsredovisas (3921). Felklassificering påverkar omsättning, momsbas och ratios väsentligt.

**K2 (BFNAR 2016:10): förbud mot egenupparbetade immateriella tillgångar.** Punkt **10.4**: byrå som tillämpar K2 får **aldrig** redovisa internt upparbetade varumärken, kampanjkoncept, kreativa idéer, varumärkesstrategier, logotyper eller säljdrivande hemsidor som tillgång: alltid direkt kostnad. Smitto-regel 10.4 andra stycket: förvärvad immateriell tillgång som är avsedd att utvecklas vidare blir egenupparbetad och får inte aktiveras.

**K3 (BFNAR 2012:1): valbar aktivering men stopplista 18.5.** Företaget väljer mellan kostnadsföringsmodellen (18.7) och aktiveringsmodellen vid sex kumulativa kriterier (18.12). **Stopplista 18.5** förbjuder dock alltid aktivering av: internt upparbetade varumärken, utgivningsrätter, kundregister och etableringsutgifter. Vid aktivering krävs avsättning till fond för utvecklingsutgifter enligt **4 kap 2 § andra stycket + 4 kap 8 § ÅRL** (1995:1554). I praktiken aktiverar reklam-/mediabyråer sällan något: kreativa koncept för kund hanteras som tjänsteuppdrag (se nedan), och eget kampanjmaterial faller på stopplistan eller saknar tillförlitligt mätbara framtida ekonomiska fördelar.

**Pågående arbeten: löpande räkning vs fast pris.** Definitionen i **17 kap 25 § IL** + K2 6.13: löpande räkning = ersättning grundas "uteslutande eller så gott som uteslutande" på på-förhand-bestämt arvode per tidsenhet, faktisk tidsåtgång och faktiska utgifter. Annars fast pris. **Reklam-/mediabyrå räknas som konsultrörelse enligt 17 kap 23 § IL** vilket aktiverar särskilda regler. **17 kap 26 § IL** (löpande räkning): värdet behöver inte tas upp som tillgång; intäkt = fakturerat under beskattningsåret. Frikoppling redovisning-beskattning bekräftad i **RÅ 2006 ref. 28** och Skatterättsnämnden 2010. **17 kap 27 § IL** (fast pris): lägst av anskaffningsvärdet och nettoförsäljningsvärdet, ej slutredovisade uppdrag. **17 kap 28 § IL**: förskott/à conto vid fast pris bokförs som skuld (2450), inte intäkt. Bokföringsmässig huvudregel = successiv vinstavräkning (K3 23.18; K2 6.16); alternativregel i K2 6.22 / K3 23.31 tillåter juridisk person använda färdigställandemetoden konsekvent. **K2 6.24 efter BFNAR 2025:1**: kvittning förbjuden mellan olika uppdrag: uppdrag med positivt saldo redovisas som tillgång, negativt som skuld, separat per uppdrag. Srf U 14 (2020-08-25) reglerar bruttoredovisning; Srf U 15 definierar "väsentligen fullgjort" från kundaccept-/realisationsperspektiv.

**Kommissionärsförhållanden.** Civilrätten finns i **Kommissionslag (2009:865)**: gamla Lag (1914:45) om kommission **upphävdes 2009-10-01** (ofta felciterat i äldre handböcker). Mediabyrå som köper annonsutrymme i eget namn för annonsörens räkning kan vara handelskommissionär enligt 1 §; tredje man (mediet) får enligt 24 § endast krav mot kommissionären, inte kommittenten. Skatterättsligt är **IL 36 kap "Kommissionärsförhållanden"** ett separat konstrukt med sex kumulativa villkor i 36 kap 3 § (skriftligt avtal, uteslutande för kommittentens räkning, samma räkenskapsår, koncernbidragsrätt enligt 35 kap m.m.): sammanfaller inte med civilrättslig kommission. Momsmässigt har den tidigare möjligheten att flytta momsskyldighet (gamla 6 kap 7 § GML) tagits bort i ML 2023:200; kommissionären är alltid betalningsskyldig för utgående moms, med momsgrupp som möjlig lösning.

**RFR 2 / IFRS 15**: Om byrån är dotterbolag i noterad koncern tillämpas IFRS 15 direkt: principal-/agent-bedömning sker enligt B34-B38, intäktsredovisning enligt 5-stegsmodellen, performance obligation-identifiering kritisk vid kombinerade kreativa + media-uppdrag.

### 4.3 Sektorlagar

**Upphovsrättslag (1960:729, URL).** Sverige saknar **uttrycklig presumtionsregel** för reklambyrå-uppdrag: 31 § URL gäller förlagsavtal, inte reklam (vanlig felcitering). Förhållandet regleras genom 27-28 §§ URL (avtalsfrihet om överlåtelse, begränsning av rätt att ändra/vidareöverlåta), branschpraxis enligt **NJA 2010 s. 559** (avtalad användning på produktförpackning utvidgas till marknadsföring "på vedertaget sätt") och tumregeln i **AD 2002 nr 87** (arbetsgivaren får inom sitt verksamhetsområde utnyttja verk skapade av anställd som ett led i arbetsuppgifter). **40 a § URL** är den enda kodifierade arbetstagar-presumtionen och gäller endast datorprogram. **39 § URL** stadgar filmpresumtion. **DSM-direktivet (EU) 2019/790** implementerat genom **Lag (2022:1712)**, i kraft **2023-01-01**, infogade bl.a. 15 a-15 c §§ URL (TDM-undantag relevant för AI-träning, med opt-out på "lämpligt sätt"), 29 § URL (skälig ersättning + bästsäljarklausul), 29 d-29 e §§ (hävningsrätt utom filmverk), 48 b-48 d §§ (presspublikationsrätt, art. 15 DSM) och 52 i-52 u §§ (OCSSP-ansvar, art. 17 DSM).

**A-SINK: Lag (1991:591) om särskild inkomstskatt för utomlands bosatta artister m.fl.** Skattesats **15 % definitiv enligt 9 § A-SINK**, oförändrad 2025-2026. "Artistisk verksamhet" definieras i 3 § som **personligt framträdande inför publik eller vid ljud-/bildupptagning med sång, musik, dans, teater, cirkus eller liknande**. Scenpersonal, tekniska biträden, regissörer och koreografer omfattas inte: för dem gäller SINK. **Influencers**: ingen publicerad Skatteverkets ställningstagande placerar influencers under A-SINK; rådande praxis behandlar dem som näringsverksamhet (svensk F-skatt) eller SINK om utomlands bosatta: eftersom social-media-innehåll inte är personligt framträdande inför publik i traditionell mening. **Voice actors/dubbning**: troligen A-SINK (ljud-/bildupptagning inom teater/liknande). **Modeller**: SINK, inte A-SINK. Tax treaty (OECD modellavtal art. 17) ger normalt Sverige källskatterätt för artister: A-SINK består. Betalaren (byrån) gör 15 %-avdrag vid utbetalning och rapporterar på **individnivå i arbetsgivardeklarationen (AGI)** månadsvis enligt skatteförfarandelagen (2011:1244).

**SINK: Lag (1991:586) om särskild inkomstskatt för utomlands bosatta.** Skattesats **25 % under 2025**, **22,5 % från 2026-01-01** (Lag 2025:1355), **20 % från 2027-01-01** (Lag 2025:1356). Tillämpas på utländska kreativa konsulter som inte är artister (copywriters, regissörer, art directors, models, influencers utan personligt scenframträdande). Kräver SINK-beslut från Skatteverket per arbetsgivare och inkomstår.

**EU AI Act: förordning (EU) 2024/1689.** I kraft 2024-08-01. Tidsplan: förbjudna AI-praktiker + AI-litteracitetskrav (art. 4) gäller från **2025-02-02**; GPAI-skyldigheter från **2025-08-02**; full tillämpning **2026-08-02**; högrisk-AI i reglerade produkter från 2027-08-02 (justerat genom AI Omnibus, politisk överenskommelse 2026-05-07). **Operativ relevans för byråer**: art. 50 transparens: deployers av GPAI för deepfake/syntetiskt innehåll måste märka AI-genererat material från 2026-08-02; art. 4 kräver personalutbildning sedan 2025-02-02; loggning av GPAI-output i kampanjer.

**Kontrolluppgifter.** Royalty till juridisk person eller F-skattad enskild näringsidkare: **KU70 (SKV 2316) "Näringsbidrag och royalty"**, deadline **31 januari året efter inkomståret**. Royalty till privatperson som engångsersättning för konstnärligt arbete → KU10 (inkomst av tjänst). Royalty till utomlands bosatt utan svensk beskattning → KU70 med utländskt TIN. A-SINK rapporteras **inte** på separat KU utan på individnivå i månatlig AGI.

### 4.4 Praxis och Skatteverkets ställningstaganden

**RÅ 2000 ref. 31 I (Procordia/Operan)**: grundbulten för sponsring. Aktiebolagspresumtion under 16 kap 1 § IL gäller, men gåvoförbudet i 9 kap 2 § andra stycket IL är lex specialis. Test: krav på **direkt motprestation** eller **stark anknytning** mellan sponsorns och den sponsrades verksamheter (indirekt omkostnad). Utfall: skönsmässig uppdelning, ca hälften avdragsgillt. **RÅ 2000 ref. 31 II (Falcon/Pilgrimsfalken)**: full avdragsrätt vid stark verksamhetsanknytning (falksymbol som varumärke sedan 1896).

**HFD 2018 ref. 55 (Arla Foods, klimatkompensation)**: **inte** HFD 2018 ref. 11 (vanlig felcitering). HFD biföll Arlas avdrag för ~5,8 MSEK i klimatkompensation 2013 eftersom utgifterna specifikt kompenserade utsläpp från bolagets ekologiska produkter: klassad som **marknadsföringskostnad enligt 16 kap 1 § IL**, inte gåva. Åtskild från **HFD 2014 ref. 62 (Saltå Kvarn)** där generell trädplantering i Uganda saknade motprestation och direkt anknytning.

**Kammarrätten i Göteborg, dom december 2024**: bolag medgavs avdrag för sponsring av Frölunda HC och Göteborgsoperan; Skatteverkets krav på dokumenterat datum och person för biljettnyttjande underkändes; Skatteverket kan inte kräva mer än motprestationens marknadsvärde med skäligt underlag.

**Skatteverkets ställningstagande dnr 130 702489-04/113, 2005-06-27** (Riktlinjer för avdragsrätt för sponsring): fortfarande gällande tolkningsstöd per Rättslig vägledning edition 2025.3. Kompletterande skrivelse om kultursponsring dnr 131 476491-09/111, 2009-05-20.

**SOU 2026:5 "Utvidgad avdragsrätt för sponsring m.m."** lämnades 2026-01-19. Förslag om ny **16 kap 11 § IL** som tillåter avdrag för utgifter "som kan antas få betydelse för näringsverksamhetens särskilda eller allmänna anseende ... om utgiften är kommersiellt betingad": föreslås gälla från **2027-01-01**. **Inte gällande rätt 2026-05**: flagga för bevakning.

## 5. Tre felmönster med högst frekvens

**Felmönster 1: Mediainköp bruttoredovisat när byrån är agent.** Reklambyrå med fast byråprovision på 5 % bokför hela mediainköpet (t.ex. 2 MSEK för en kampanj hos Bonnier) på 4-konto med motsvarande 3-konto-intäkt, vilket uppblåser omsättning, momsbas och resultatmått. **Rätt mönster**: när byrån saknar prissättningsfrihet, lager-/avbokningsrisk och primärt ansvar mot kunden för medieleveransen är den agent enligt K3 punkt 23.2 och IFRS 15 B37: endast provisionen (100 000 kr) intäktsredovisas på 3921, mediakostnaden hanteras som genomgångspost eller utlägg om Skatteverkets tre kriterier är uppfyllda (faktura ställd till slutkund, inget påslag, balanskonto). Lagrum: K3 punkt 23.2; IFRS 15 B34-B38; Skatteverkets utlägg-vägledning; 5 kap + 8 kap ML 2023:200.

**Felmönster 2: Google Ads/Meta Ads-fakturor bokförda utan omvänd betalningsskyldighet.** Faktura från Google Ireland på 50 000 kr bokförs som inhemsk kostnad utan momsberäkning, eller med felaktig svensk 25 % moms som dras av: leder till underrapportering av utgående moms i ruta 30 och felaktig avdragspost. **Rätt mönster**: bokföring på 4535 (motkonto 2440 leverantörsskuld), beräkning av 12 500 kr utgående moms 2614 (ruta 21 beskattningsunderlag, ruta 30 utgående moms) och motsvarande ingående moms 2645 (ruta 48). Säljarens faktura ska visa "Reverse charge" och svenska byråns VAT-nummer; saknas det = begär korrigerad faktura. Lagrum: 6 kap 33 § + 16 kap ML 2023:200; mervärdesskattedirektivet art. 196.

**Felmönster 3: Sponsringsavdrag taget utan dokumenterad motprestation.** Byrå sponsrar idrottsklubb med 200 000 kr och bokför hela beloppet på 5980 med 25 % momsavdrag, utan skriftligt sponsoravtal som specificerar och värderar motprestationer (reklamskyltar, biljetter, exponering). Vid revision underkänns avdraget helt eller delvis och klassas som gåva enligt 9 kap 2 § andra stycket IL: både inkomstskatt- och momsavdrag återförs med skattetillägg. **Rätt mönster**: skriftligt sponsoravtal med specificerad motprestation, marknadsvärdering per komponent (jämförelse med reklamprislista, lokalhyra, biljettpris), separat hantering av eventuell representations- eller gåvodel (6072), dokumentation av faktiskt utnyttjande. Lagrum: 16 kap 1 § IL; 9 kap 2 § andra stycket IL; 13 kap 6 § ML 2023:200; Skatteverkets dnr 130 702489-04/113 (2005-06-27); RÅ 2000 ref. 31; HFD 2018 ref. 55.

## 6. Öppna frågor: flaggas för manuell granskning

**AI-genererat innehåll och upphovsrätt 2025-2026**: Inget svenskt PMD/PMÖD-avgörande har publicerats om upphovsrättsligt skydd för rent AI-genererade verk per 2026-05. Konsensus följer EU-praxis (Infopaq, Painer, Cofemel) att verkshöjd kräver mänsklig kreativ insats; AI-assisterade verk kan skyddas vid "icke obefintlig kreativ medverkan med direkt koppling till slutresultatet". Avtalsklausuler bör explicit reglera (a) AI-användning och disclosure, (b) garanti mot upphovsrättsintrång från träningsdata, (c) ägarskap av AI-genererade element, (d) TDM-opt-out enligt 15 a § andra stycket URL, (e) art. 50 AI Act-märkning från 2026-08-02. Pendant EU-domstolens mål **C-250/25** (Google/Gemini och presspublikationsrätt) väntas hösten 2026 och kan påverka 15 a § URL-tolkningen.

**A-SINK-gränsdragning för influencers**: Skatteverket har inte publicerat numrerat ställningstagande som placerar influencers under A-SINK. Specialgranskning 2024-2025 har inte resulterat i ny lagstiftning. Gränsdragningen mellan A-SINK (15 %, artister med personligt framträdande) och SINK (22,5 % från 2026) för utländska influencers är inte slutligt klarlagd: försiktighetsprincipen: behandla som SINK om aktiviteten inte involverar personligt scenframträdande inför publik.

**OSS-tillämpning på hybrida tjänster**: När byrån paketerar kreativa tjänster med digitala leveranser till privatpersoner i EU (t.ex. masterclass-serie, mallpaket, prenumeration) är klassificering som "elektronisk tjänst" vs "konsulttjänst" inte alltid uppenbar. Skatteverkets vägledning ger inte fullständig praxis för hybrid B2C-byråverksamhet.

**Sponsringsreformen 2027**: SOU 2026:5 föreslår uttrycklig avdragsregel i ny 16 kap 11 § IL från 2027-01-01. Övergångsperiod och retroaktivitet ännu inte beslutat. Bevaka prop. och riksdagsbehandling under 2026.

**BAS-utvecklingen**: BAS 2025 har bytt terminologi "skattskyldighet" → "betalningsskyldighet" på alla momskonton (2614, 2624, 2634, 2642, 2647, 4415-4417, 4425-4427) med oförändrade kontonummer. Bevaka BAS 2026-utgåvan för ytterligare ändringar relevanta för digitala annonsörer och AI-tjänster.

---

## Overflow-filer (planerad utbyggnad)

Token-budget för denna SKILL.md är hållen under 15k. Föreslagna overflow-ämnen för djupare detaljer (inga av dessa referensfiler är skapade ännu):

- **principal-vs-agent-mediainkop**: Beslutsmatris med IFRS 15 B37-indikatorer, K3 23.2-tillämpning, exempelposteringar för principal/agent/utlägg, mall för principal-/agent-analys per kund.
- **a-sink-influencer-utlandsbetalningar**: A-SINK vs SINK-beslut, AGI-rapportering, skatteavtal (OECD art. 17), formulärflöden (SKV 520, SINK-ansökan), KU70 till utländska mottagare.
- **sponsring-motprestationsbedomning**: Mall för sponsoravtal med marknadsvärdering per komponent, checklista för dokumentation, fullständig praxisgenomgång (RÅ 1976 ref. 127 I/II, RÅ 2000 ref. 31 I/II, HFD 2014 ref. 62, HFD 2018 ref. 55, KR Göteborg 2024-12), SOU 2026:5-bevakning.
- **url-upphovsratt-byraavtal**: Branschmallar för upphovsrätts-överlåtelse i byrå-kundavtal, NJA 2010 s. 559-tolkning, DSM-direktivets §§ i URL (15 a-15 c, 29, 29 d-e, 48 b-d, 52 i-u), AD 2002 nr 87.
- **ai-content-och-ai-act-byraer**: EU AI Act-tidslinje (art. 4, art. 50), TDM-opt-out under 15 a § URL, AI-klausulbibliotek för byråavtal, bokföring av AI-prenumerationer och API-konsumtion (5420 vs 6540), C-250/25-bevakning.
- **pagaende-arbeten-konsultrorelse**: K2 6.13-6.24 och K3 23.18-23.37 jämförelse, IL 17 kap 23-32 §§, RÅ 2006 ref. 28 frikoppling, Srf U 14 + U 15, BFNAR 2025:1-kvittningsförbud, exempelflöden för retainer, kampanj fast pris och blandade uppdrag.
