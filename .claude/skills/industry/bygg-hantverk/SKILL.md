---
id: vertical/bygg-hantverk
tier: vertical
title: "Bygg & hantverk (SNI 41-43)"
description: >
  Svensk bokföringsskill för bygg- och hantverksföretag i SNI 41 (uppförande av byggnader), 42 (anläggningsarbeten) och 43 (specialiserad bygg- och installationsverksamhet). Distinkta arbetsflöden: omvänd betalningsskyldighet på byggtjänster B2B (ML 2023:200 16 kap. 13 §), ROT-fakturering enligt fakturamodellen, elektronisk personalliggare/ID06 (SFL 39 kap. 11 a §), successiv vinstavräkning vs färdigställandemetoden (K3 23.18-23.37, K2 6.13-6.26, IL 17 kap. 23-32 §§) och ackordslön + branschpension enligt Byggavtalet/Installationsavtalet/Måleriavtalet. Använd när konteringen rör UE-fakturor, ROT-poster, byggarbetsplats, entreprenadkontrakt AB 04/ABT 06/ABS 18, à conto-fakturering, pågående arbeten, eller bygg-/installation-/måleri-CBA.
sni_prefixes: ["41.10", "41.20", "42.11", "42.12", "42.13", "42.21", "42.22", "42.91", "42.99", "43.11", "43.12", "43.13", "43.21", "43.22", "43.29", "43.31", "43.32", "43.33", "43.34", "43.39", "43.91", "43.99"]
trigger_signals:
  text_patterns:
    - "omvänd betalningsskyldighet"
    - "omvänd skattskyldighet"
    - "ROT-avdrag"
    - "rotarbete"
    - "fakturamodellen"
    - "ID06"
    - "personalliggare"
    - "byggarbetsplats"
    - "akontofaktura"
    - "à conto"
    - "UE-faktura"
    - "underentreprenör"
    - "ÄTA-arbete"
    - "slutbesiktning"
    - "AB 04"
    - "ABT 06"
    - "ABS 18"
    - "pågående arbete"
    - "successiv vinstavräkning"
    - "byggherre"
    - "fastighetsbeteckning"
    - "Byggnads"
    - "ackord"
    - "Målerifakta"
    - "Mätföretaget"
  bas_account_signals:
    - "1471"
    - "1478"
    - "1513"
    - "1620"
    - "2340"
    - "2450"
    - "2614"
    - "2617"
    - "2647"
    - "3231"
    - "4415"
    - "4425"
    - "4600"
    - "4970"
    - "5480"
    - "6330"
    - "6360"
    - "6810"
    - "7010"
estimated_tokens: 9800
version: 1
---

# Bygg och hantverk: vertikalspecifik bokföringsskill

## 1. När denna skill ska laddas

Ladda när företaget har huvudsaklig verksamhet inom SNI 41-43 (uppförande av byggnader, anläggningsarbeten, specialiserad bygg- och installationsverksamhet), eller när konteringsärendet innehåller någon av följande markörer: leverantörsfaktura med texten "omvänd betalningsskyldighet/skattskyldighet"; kund- eller leverantörsfaktura där arbetskostnad är separerad och hänvisar till ROT/skattereduktion; verifikat märkt ID06/personalliggare/byggarbetsplats; entreprenadkontrakt enligt AB 04, ABT 06 eller ABS 18; à conto-fakturering kopplad till uppdragsmilstolpar; närvaro av BAS-kontona 1620/2450, 1471/2450, 2614/2617/2647, 3231, 4415/4425 eller 4600. Denna skill täcker ENDAST vertikalspecifika avvikelser: generella moms-, BFL-, SIE-, lön- och bokslutsregler dras från horisontella skills.

## 2. Typiska arbetsflödesmönster

**Fakturering.** Bygg- och installationsbolag fakturerar nästan aldrig som rena varuförsäljare. Tre fakturatyper dominerar och kräver olika kontering: **akontofakturor (à conto)** under entreprenadens gång enligt avtalad betalplan; **slutfaktura** efter godkänd slutbesiktning enligt AB 04 kap. 7 / ABT 06 kap. 7; och **ÄTA-fakturor** för Ändrings-, Tilläggs- och Avgående arbeten enligt AB 04 kap. 2 §§ 6-9. För B2B mellan byggföretag ställs samtliga fakturor ut **utan moms** med text "Omvänd betalningsskyldighet" och hänvisning till **16 kap. 13 § ML (2023:200)** eller artikel 199.1 a momsdirektivet; köparens VAT-nummer är obligatoriskt på fakturan (17 kap. 24 § ML). Mot privatperson eller icke-byggföretag debiteras 25 % moms och ROT-avdrag tillämpas via **fakturamodellen** (67 kap. 11-19 §§ IL + lag 2009:194): arbetskostnad separeras, preliminär skattereduktion (30 % normalt, 50 % 2025-05-12 till 2025-12-31, åter 30 % från 2026-01-01) dras direkt på fakturan, utföraren begär utbetalning från Skatteverket via e-tjänst senast 31 januari året efter betalningsåret.

**Utgiftsrytm.** Materialinköp från byggvaruhus (Beijer, Optimera, Ahlsell) flödar dagligen och bokförs på 4010 eller 5460; större beställningar är ofta projekt-specifika. UE-tjänster bokförs i 46-serien (4600-gruppen) med särskild moms-mekanik vid omvänd betalningsskyldighet. ID06-kort, fortbildning säkerhet på väg, fallskydd, ställningsutbildning är återkommande poster (bokförs typiskt på 6991: det finns inget dedikerat ID06-konto i BAS 2025). Verktyg under brytpunkten (½ pbb, 2025 = 29 400 kr) går på 5410 Förbrukningsinventarier; över brytpunkten aktiveras på 1220-serien.

**Avstämning.** Avstämning sker **per projekt/objekt** snarare än per period: varje projekt har egen kostnadssamlingskonto i 1471 (alternativregeln) eller behandlas via 1620/2450 (huvudregeln/PoC enligt K3 23.18). UE-skulder stäms av per leverantör och per projekt vid varje månadsslut: om à conto-fakturor från UE inte är slutfakturerade vid bokslut ska reservationen för upparbetat men ej fakturerat hanteras. ROT-utbetalningar från Skatteverket stäms av på 1513 Kundfordringar, delad faktura: differensen mellan kundens betalning och Skatteverkets utbetalning ska gå mot noll per avslutad faktura inom 60 dagar.

**Lönerytm och kollektivavtal.** Löneutbetalning sker **vecko- eller månadsvis beroende på CBA**. Yrkesarbetare lönesätts ofta med ackord (resultatlön) i tillägg till tidlön. Kollektivavtal per sub-vertikal mappas grovt så här: Byggavtalet (Byggnads + Byggföretagen) täcker SNI 41, 42, 43.11, 43.12, 43.31, 43.32, 43.33, 43.39, 43.99; Installationsavtalet (SEF + Installatörsföretagen) täcker 43.21; Teknikinstallationsavtalet VVS & Kyl (Byggnads + Installatörsföretagen) täcker 43.22; Plåt- och Ventilationsavtalet (Byggnads + Plåt & Vent Företagen) täcker plåt- och ventilationsdelarna av 43.22/43.29/43.91; Måleriavtalet (Byggnads + Måleriföretagen) täcker måleri-delen av 43.34; Glasmästeriavtalet (Byggnads + Glasbranschföreningen) täcker glasmästeri-delen av 43.34. Alla avtal har period **2025-05-01 till 2027-04-30** med märket 6,4 %. Försäkringspaket: AGS, AGB, TFA, TGL och Avtalspension SAF-LO via Fora för kollektivanställda; ITP via Collectum för tjänstemän. Se `references/kollektivavtal.md` för CBA-detaljer per sub-vertikal.

## 3. BAS 2025-kontomönster (verifierat mot bas.se)

| Konto | Exakt titel BAS 2025 | Branschkontext |
|-------|----------------------|----------------|
| 1181 | Pågående ny-, till- och ombyggnad | Egen byggnation av anläggningstillgång (byggherre i egen regi). |
| 1471 | Pågående arbeten, nedlagda kostnader | Aktiverade utgifter per uppdrag, alternativregeln (färdigställandemetoden) K3/K2. |
| 1478 | Pågående arbeten, fakturering | À conto-fakturering bokförd under pågående uppdrag, alternativregeln. **OBS: ej "Förskott till leverantörer".** |
| 1513 | Kundfordringar, delad faktura | Skatteverkets ROT-del av ROT-fakturor; saldot ska gå mot noll när Skatteverket utbetalar. |
| 1620 | Upparbetad men ej fakturerad intäkt | Successiv vinstavräkning (PoC) huvudregeln K3 23.18 ff; positiv differens upparbetat ÷ fakturerat per uppdrag. |
| 2340 | Byggnadskreditiv | Långfristig byggkredit; kortfristig del separeras till 2412. |
| 2420 | Förskott från kunder | Mottagna förskott som inte motsvarar upparbetat värde. |
| 2431 | Pågående arbeten, fakturering | Skuldsidans à conto-konto för alternativregeln (motpart till 1471). |
| 2450 | Fakturerad men ej upparbetad intäkt | PoC-skuldsida (motpart till 1620). |
| 2614 | Utgående moms, omvänd betalningsskyldighet, 25 % | Säljarens redovisningskonto vid B2B-bygg (rapporteras i ruta 41). |
| 2617 | Utgående moms omvänd betalningsskyldighet (köparen) | Köparens beräknade utgående moms vid UE-tjänsteinköp (ruta 30). |
| 2645 | Beräknad ingående moms på förvärv från utlandet | Endast vid utländska UE; ej för svenska omvänd-byggmoms. |
| 2647 | Ingående moms, omvänd betalningsskyldighet varor och tjänster i Sverige | Köparens avdragsgilla ingående moms vid omvänd byggmoms (ruta 48). |
| 3231 | Försäljning inom byggsektorn, omvänd betalningsskyldighet moms | Centralt försäljningskonto vid B2B-bygg utan moms (ruta 41). |
| 4415 | Inköpta varor i Sverige, omvänd betalningsskyldighet, 25 % moms | Vid varuleveranser inom omvänd (sällsynt i bygg, främst skrot/metallhandel). |
| 4425 | Inköpta tjänster i Sverige, omvänd betalningsskyldighet, 25 % moms | **Huvudkontot för UE-tjänster** vid omvänd betalningsskyldighet (ruta 24). |
| 4600 | Legoarbeten och underentreprenader (gruppkonto) | Strukturkonto; underkonton per UE-leverantör eller projekt vanligt. |
| 4970 | Förändring av pågående arbeten, nedlagda kostnader | Motpart till 1471 vid in-/utbokning av pågående arbete alternativregeln. |
| 5410 | Förbrukningsinventarier | Verktyg under ½ pbb (2025 = 29 400 kr). |
| 5460 | Förbrukningsmaterial | Småmaterial under skäliga gräns (skruv, spik, fogmassa). |
| 5480 | Arbetskläder och skyddsmaterial | Hjälm, skor S3, hörselskydd, fallskydd, avdragsgillt enligt SKV. |
| 5611-5613, 5615, 5616, 5619 | Personbilskostnader | Servicebil personbil; OBS 50 % moms-avdrag på leasing/hyra (ML). |
| 5620 | Lastbilskostnader | Servicebil lätt lastbil: 100 % moms-avdrag om uppfyller skåp-/öppet flak-krav. |
| 6330 | Förluster i pågående arbeten | Reservering av befarad förlust per K3 23.32. |
| 6360 | Garantikostnader (med 6361, 6362) | Garantiavsättning för AB 04/ABT 06 garantitid. |
| 6510 | Mätningskostnader | Mätningsarvode till Målerifakta, Mätföretaget i Sverige (Byggavtalet § 2 / Installationsavtalet). |
| 6810 | Inhyrd produktionspersonal | Skild från övriga konsulttjänster; ofta bokföringsmässigt felklassificerat som UE. |
| 6991 | Övriga externa kostnader, avdragsgilla | Standardkonto för ID06-avgifter (inget dedikerat konto finns). |
| 6992 | Övriga externa kostnader, ej avdragsgilla | Kontrollavgift för bristande personalliggare (50 kap. SFL), ej avdragsgill. |
| 7010 | Löner till kollektivanställda | Yrkesarbetare. **OBS: ej 7210**, 7210 är tjänstemän. |
| 7510 | Arbetsgivaravgifter 31,42 % | Underkonton 7511-7519. |
| 7570 | Premier för arbetsmarknadsförsäkringar | TFA, AGS, AGB, TGL via Fora. **Konto 7560 finns inte i BAS 2025.** |
| 7411 | Premier för kollektiva pensionsförsäkringar | Avtalspension SAF-LO via Fora. |

Konton som vanligtvis EJ existerar med förväntade namn: **6541 (ID06-kort kostnader)** finns inte: använd 6991. **3232 (Utbetald ROT Skatteverket)** finns inte: ROT-fordran hanteras via 1513. **7560** finns inte: använd 7570. **5614** är vakant. Verifiera alltid mot kundens lokala kontoplan eftersom företag ofta lägger upp egna underkonton.

## 4. Regelmässiga gränsfall (huvudvärdet i denna skill)

### 4a. Omvänd betalningsskyldighet på byggtjänster

**Lagrum efter 2023-07-01.** Bestämmelsen flyttades från 1 kap. 2 § första stycket 4 b ML (1994:200) till **16 kap. 13 § ML (2023:200)** (ikraftträdande 2023-07-01). Materiellt oförändrad: första stycket = köparkravet, andra stycket = tjänstekatalogen (punkt 1 byggtjänster, punkt 2 byggstädning, punkt 3 personaluthyrning för punkterna 1-2). Terminologin är ändrad från "omvänd skattskyldighet" till **"omvänd betalningsskyldighet"**: BAS 2025 har uppdaterat kontotexterna med ändringsstreck men det är samma regel. Faktureringsregler i 17 kap. 24 § ML (fullständig faktura); förenklad faktura (17 kap. 28 §) får inte användas. Skatteverket har explicit förklarat att alla äldre ställningstaganden om "omvänd skattskyldighet inom byggsektorn" gäller vidare; endast paragrafhänvisningarna är inaktuella.

**Vilka tjänster triggar omvänd.** Skatteverket vägleds av SNI 2002 huvudgrupp 45: (a) mark- och grundarbeten, (b) bygg- och anläggningsarbeten, (c) bygginstallationer (el, VVS, ventilation, isolering, larm), (d) slutbehandling (puts, snickeri, golv, måleri, glasmästeri), (e) uthyrning av bygg-/anläggningsmaskiner **med förare**, plus byggstädning och personaluthyrning för dessa. Skatteverkets uttömmande A-Ö-förteckning ligger på `skatteverket.se/foretag/moms/sarskildamomsregler/byggverksamhet`. Tjänsten måste avse fastighet enligt ML (2 kap. 11 §).

**Köparkravet.** Köparen är betalningsskyldig endast om denne är en beskattningsbar person som **"inte endast tillfälligt"** tillhandahåller sådana tjänster (= byggföretag i vid mening), eller är mellanman som säljer vidare till sådan. "Inte endast tillfälligt" tolkas brett: t.ex. en kökstillverkare med monteringsverksamhet på 0,06 % av omsättningen och ~40 tillfällen/år omfattas (SRN 2014). Köparens SNI-kod är **inte avgörande**: det är faktisk verksamhet som räknas. Status upphör först vid avveckling av byggdelen. Stat och kommun kan vara byggföretag (Skatteverket dnr 8-1148796 omarbetad till dnr 8-2718597; dnr 8-1228116 staten).

**Gränsfall.** Material som ingår i byggtjänst → allt räknas som tjänst (RÅ 2010 ref. 50 I/II förblir ledande). Markupplåtelse och fastighetsförsäljning är undantagna enligt 10 kap. 35 § ML, ej byggtjänst. Byggstädning omfattas; lokalstädning, snöskottning och bortforsling av byggavfall omfattas inte. Maskinuthyrning med förare = omvänd; utan förare = ej omvänd. Projektering/arkitekt som självständig tjänst = ej omvänd; men som del av entreprenad → omvänd. 12 % moms på reparation av cyklar/skor/lädervaror/kläder/hushållslinne (9 kap. 7 § ML) har ingen överlappning med byggtjänster: dessa varor blir aldrig fastighet. Försäljning till privatperson eller icke-byggföretag → 25 % moms, ej omvänd; ROT påverkar inte momssatsen.

**Ställningstaganden senaste 5 åren.** Inga materiella nyheter 2024-2026; flera ställningstaganden från 2017 är omarbetade för att uppdatera paragrafhänvisningar. Centrala: dnr 131 101175-17/111 (FoS A allmänna förutsättningar), 131 101180-17/111 (FoS B arbete på byggnader), 131 101225-17/111 (FoS C mark), 131 101266-17/111 (FoS D bedömningsfrågor), 202 157785-19/111 (lyftarbeten, byggkran, bygghiss), 202 448424-19/111 (fastighetsbegreppet), 8-1148796 (kommun, omarb. 8-2718597), 8-1228116 (staten), 8-724682 (fakturatext). Se `references/momsregler.md` för fullständig lista och URL.

### 4b. Pågående arbeten och entreprenadavtal

**K3 (BFNAR 2012:1) kapitel 23, inte 2017:1.** Brukstexten i uppgiftsbrevet hänvisade till BFNAR 2017:1; det korrekta är **BFNAR 2012:1** (K3, allmänna råd om årsredovisning och koncernredovisning), kapitel 23 "Intäkter". Tillämpningsområde i 23.1; definitioner i 23.9; **huvudregeln successiv vinstavräkning (PoC) i 23.18-23.27**: tillämpas när uppdragets ekonomiska utfall kan beräknas tillförlitligt (kriterier i 23.18). Färdigställandegrad enligt 23.22 (cost-to-cost mest vanlig). Om utfallet inte kan beräknas tillförlitligt → nollavräkning (23.23). **Alternativregeln färdigställandemetoden i 23.31-23.37**: får tillämpas i **juridisk person** för uppdrag i bygg-, anläggnings-, hantverks- eller konsultrörelse enligt 17 kap. 23 § IL (kopplingsregeln). Befarad förlust ska redovisas omedelbart oavsett metod (23.32). I koncernredovisning gäller **endast PoC**: färdigställandemetoden är förbjuden där.

**K2 (BFNAR 2016:10) kapitel 6.** Tjänsteuppdrag och entreprenaduppdrag i punkterna 6.13-6.26. Löpande räkning enligt 6.13-6.14: intäkt redovisas i takt med utförande och materialleverans, alternativt enligt fakturering (kopplingen till IL 17 kap. 26 §). Fast pris enligt 6.15: företaget väljer **antingen huvudregeln (PoC) eller alternativregeln (färdigställandemetoden)** och tillämpar samma metod på samtliga fastprisuppdrag. Pågående arbete i BR enligt 6.24: bruttoredovisning per uppdrag obligatorisk (Srf U 14); kvittning mellan uppdrag uttryckligen förbjuden för räkenskapsår som inleds efter 2025-12-31 (BFN-beslut 2025-06-16). Se `references/pagaende-arbeten.md` för flödesexempel.

**IL (1999:1229) 17 kap. 23-32 §§.** Kopplingsregeln i **17 kap. 23 §**: redovisning av pågående arbeten i bygg-, anläggnings-, hantverks- eller konsultrörelse följs vid beskattningen om inte 24-32 §§ avviker. **17 kap. 24 §** definierar löpande räkning (≥ 90 % av arvodet baserat på tidsenhet/utgifter enligt SKV A 2016:7). **17 kap. 26 §** = faktureringsmetoden för löpande räkning: värdet behöver inte tas upp som tillgång; istället utgör fakturerat belopp intäkt. **17 kap. 27 § första stycket** = huvudregeln för fast pris (lägsta värdets princip mellan anskaffningsvärde och nettoförsäljningsvärde); **andra stycket = 97 %-regeln/alternativregeln** för byggnads-, anläggnings- och hantverksrörelse (men **inte konsultrörelse**). SKV A 2016:6 ger värderingsvägledning. **HFD 2011 ref. 20 (Skanska)** förblir ledande prejudikat för faktureringsmetoden och frikoppling skatt↔redovisning vid löpande räkning.

### 4c. ROT-avdrag (skattereduktion för rotarbete)

**Lagrum.** IL 67 kap. 11-19 §§ med definition av rotarbete i **13 a §** (reparation, underhåll, om-/tillbyggnad av småhus, bostadsrätt, ägarlägenhet) och uttömmande undantag i **13 c §** (installationer/service på maskiner och inventarier; arbete med försäkringsersättning). Krav på utförare har F-skatt (67 kap. 16 § 1). Krav på elektronisk betalning (67 kap. 19 §) sedan 2020-01-01. Förfarandet regleras i lag (2009:194) om förfarandet vid skattereduktion för hushållsarbete (HUSFL), särskilt 4, 6, 7, 8, 11 §§.

**Belopp och subventionsgrad.** Ordinarie tak 50 000 kr/person/år för ROT 2025-2026, inom ett gemensamt utrymme på 75 000 kr/person/år (max 50 000 kr ROT). Subventionsgrad **30 % av arbetskostnaden** ordinärt, tillfälligt höjt till **50 %** under perioden **2025-05-12 till 2025-12-31** enligt prop. 2024/25:156 (FiU32); återgång till 30 % från 2026-01-01. Avgörande för procentsatsen är **betalningsdatum**, inte fakturadatum. Under 2024 var taket tillfälligt höjt till 75 000 kr separat för ROT: det är inte längre fallet.

**Fakturamodellen och dokumentation.** Utföraren drar preliminär skattereduktion på fakturan; kund betalar elektroniskt; utföraren begär utbetalning från Skatteverket senast 31 januari året efter betalningsåret. Begäran ska innehålla org.nr, kunds personnummer, fastighetsbeteckning eller lägenhetsnr + brf-org.nr, antal arbetstimmar, art av arbete, arbetskostnad och debiterad reduktion, samt betalningsdatum (sedan 2015-01-01 efter prop. 2014/15:10).

**Gränsfall.** Endast arbetskostnad; material, resor, maskinhyra ger inte ROT. Nybyggnation av småhus < 5 år ger inte ROT. Ekonomibyggnader, fritidshus där sökanden inte bor, och bostadsrätt där annan än sökanden bor permanent omfattas inte. UE kan utföra arbetet om huvudutförare har F-skatt. SRN 2023-07-19 dnr 83-22/D drog gränsen mellan ROT och skattereduktion för grön teknik (separata utrymmen). Försäkringsersättning utesluter ROT (SKV dnr 131 338276-10/111).

### 4d. Personalliggare, ID06 och kontrollavgift

**Lagrum.** Skatteförfarandelagen (2011:1244) **39 kap. 11 a-11 b §§ och 12 §**, med ikraftträdande 2016-01-01 efter prop. 2014/15:6 (SFS 2014:1474). Anmälningsplikt för byggarbetsplats i 7 kap. 2 a § SFL. Kontrollbesök i 42 kap. 8 §; kontrollavgift i **50 kap. 3-6 §§** med befrielsegrund i 51 kap. 1 §. Tekniska krav i 9 kap. 5 § skatteförfarandeförordningen (2011:1261) och SKVFS 2015:6. Lag (2018:744) är en ändringslag som utvidgade personalliggarplikt till andra branscher: huvudlagen är fortsatt SFL.

**Tröskel och plikt.** Byggherren ska tillhandahålla elektronisk personalliggare endast om **sammanlagd kostnad för byggverksamheten (arbete + material exkl. moms) antas överstiga 4 prisbasbelopp** (39 kap. 11 b § andra stycket). 2025: 4 × 58 800 = **235 200 kr**. Privat byggherre som inte bedriver näringsverksamhet är undantagen. Byggherren kan via skriftligt avtal överlåta ansvaret till general-/totalentreprenör (men ej vid delad entreprenad eller till UE). Uppgifter bevaras 2 år efter beskattningsårets utgång.

**Kontrollavgifter.** 12 500 kr vid bristande personalliggare, +2 500 kr per oregistrerad verksam person på platsen, 25 000 kr om byggarbetsplatsen inte anmälts, 12 500 kr om byggherren inte tillhandahåller utrustning, förhöjd till 25 000 kr vid ny överträdelse inom 1 år. **Kontrollavgift är ej skattemässigt avdragsgill**: bokförs på 6992.

**ID06.** Inget lagkrav, men branschens de facto-standard. ID06 AB är branschägt (Byggföretagen m.fl.). Kortet identifierar individ, kopplar till arbetsgivare och fungerar som inpassering + närvaroregistrering i personalliggaren. ID06-avgifter bokförs på 6991 (inget dedikerat BAS-konto finns).

### 4e. Sektorlagar och standardavtal

**AB 04** (utförandeentreprenad) och **ABT 06** (totalentreprenad), utgivna av Byggandets Kontraktskommitté (BKK), är standardavtal som gäller när de åberopas. Bokföringsmässigt relevanta klausuler: **slutbesiktning** (kap. 7) utgör avlämnande och startpunkt för garantitid + 10-årig ansvarstid; **ÄTA-arbeten** (AB 04 kap. 2 §§ 6-9) ska beställas skriftligen och faktureras separat; **garantitider** är AB 04 = 5 år arbetsprestation + 2 år material, ABT 06 = 5 år hela entreprenaden (med 2 år för beställarspecificerat fabrikat); entreprenörens fordran preskriberas 6 månader efter godkännande (kap. 6 § 19): kritisk deadline för slutfakturering. Innehållna belopp för garantitid ska periodiseras. BKK arbetar på **AB 25 och ABPU 25** med planerad lansering sommaren 2026: verifiera vid uppdatering.

**ABS 18** (allmänna bestämmelser för småhusentreprenader till konsument), Konsumentverket m.fl. 2018, ersatte ABS 09. Kräver **färdigställandeskydd** enligt lag (2014:227). 2-årig garantipresumtion enligt KtjL § 59.

**Konsumenttjänstlagen (1985:716)** vid arbete åt konsument: § 17 reklamation inom skälig tid (max 2 mån alltid i tid; yttersta gräns 3 år lös sak / **10 år för fast egendom**). § 36 **15 %-regeln**: ungefärligt pris får överskridas med max 15 %. §§ 51-61 särregler för småhusentreprenad: § 51 "kunden har alltid rätt"-presumtionen vid otydligt avtal; § 59 2-årig garantipresumtion efter godkänd slutbesiktning; § 60-61 slutbesiktning och 6 mån granskningsfrist. Längre reklamationsfrist för fast egendom motiverar **garantiavsättning** på 2220/6360 vid bokslut.

### 4f. HFD-domar och Skatteverkets ställningstaganden 2020-2026

Området är relativt stabilt: få nya HFD-prejudikat. Mest relevanta: **HFD 2023 ref. 10 (mål 651-22, JM AB)** om byggnadsrörelse och uttagsmoms vid successiv avyttring av ägarlägenheter; **HFD 2022 ref. 28** om gränsdragning vara/tjänst. **RÅ 2010 ref. 50 I/II** förblir ledande för material-i-tjänst-doktrinen; **HFD 2011 ref. 20** för faktureringsmetoden vid löpande räkning; **HFD 2016 ref. 29** för ROT (betalning från annan än köparen). **SRN 2023-07-07 dnr 83-22/D** ROT vs grön teknik. **SRN 2023-07-03** byggnadsrörelse-klassificering av drivmedelsanläggning. För kontrollavgifter avgörs de flesta målen på kammarrätts-nivå utan att nå HFD; befrielsegrunder tolkas restriktivt. Se `references/praxis.md` för full lista.

## 5. De tre vanligaste felmönstren

### 5.1 UE-faktura bokförs med ingående moms i stället för omvänd betalningsskyldighet

**Fel.** Bokföraren tar emot en UE-faktura inom bygg (4 000 kr utan moms, med text "omvänd betalningsskyldighet") och bokför som om det vore ordinär moms: Debet 4010 4 000 / Debet 2641 1 000 (uppfunnen moms) / Kredit 2440 5 000. Konsekvens: säljarens nollmomsfaktura matchas mot uppfunnen ingående moms; ingen utgående förvärvsmoms i ruta 30; avdrag i ruta 48 är ogiltigt. Vid skatterevision återkrävs ingående moms + skattetillägg.

**Rätt.** Säljaren fakturerar 4 000 kr utan moms med hänvisning till 16 kap. 13 § ML. Köparens bokföring: Debet **4425** Inköpta tjänster Sverige omvänd 25 % 4 000 / Kredit **2440** Leverantörsskulder 4 000; samtidigt Debet **2647** Ingående moms omvänd 1 000 / Kredit **2617** Utgående moms omvänd 1 000. Momsdeklaration: beskattningsunderlag i ruta 24, utgående i ruta 30, ingående i ruta 48. Nettot mot Skatteverket är noll vid full avdragsrätt, men måste redovisas. Lagref: 16 kap. 13 § och 17 kap. 24 § ML (2023:200).

### 5.2 ROT-faktura konteras utan delning mellan kund och Skatteverket, eller ROT räknas på materialdelen

**Fel.** Hela fakturan (arbete + material + moms) bokas på 1510 Kundfordringar; när Skatteverket utbetalar bokas det som ny intäkt på 3010, dubbelintäkt. Eller: bokföraren räknar 30 % ROT på hela fakturan inklusive material: för stor begäran om utbetalning leder till delvist avslag och korrigeringsfaktura mot kund.

**Rätt.** Exempel: arbete 24 500 + material x + moms 25 %; ROT-grund = endast arbete; reduktion 30 % × 24 500 = 7 350 (eller 50 % × 24 500 = 12 250 under 2025-05-12 till 2025-12-31). Vid fakturering: Debet 1511 (kundens del exkl. ROT) / Debet **1513** Kundfordringar, delad faktura (ROT-del) / Kredit 2611 (utgående moms 25 %) / Kredit 3011 (arbete) / Kredit 3041 (material). Vid kundens betalning: Debet 1930 / Kredit 1511. Vid Skatteverkets utbetalning: Debet 1930 / Kredit **1513**: saldot på 1513 ska gå mot noll. Lagref: 67 kap. 11-19 §§ IL; lag 2009:194 §§ 6-12. Se `references/rot-faktura-exempel.md` för komplett verifikationsexempel.

### 5.3 Pågående arbeten saknas eller felklassificeras vid bokslut

**Fel.** K3-bolag med entreprenader till fast pris periodiserar inte: endast fakturerat ligger i resultatet, vinster skjuts framåt eller dolda förluster. Eller: K2-bolag med alternativregeln glömmer bruttoredovisa per uppdrag och nettar fel uppdrag mot varandra. Eller: förskott från beställare hamnar på 2420 i stället för 2450 vid PoC-redovisning, vilket bryter mot BR-uppställningen.

**Rätt: K3 huvudregeln/PoC.** Vid bokslut bokas upparbetad-men-ej-fakturerat: Debet **1620** Upparbetad men ej fakturerad intäkt / Kredit eget intäktskonto i 30-/31-serien för uppdragsintäkt. Om beställaren betalat mer än upparbetat: Debet bank / Kredit **2450** Fakturerad men ej upparbetad intäkt. Befarad förlust: Debet **6330** / Kredit avsättning 2220. Lagref: BFNAR 2012:1 K3 punkt 23.18-23.32; ÅRL 4 kap. 10 §.

**Rätt: K2/alternativregeln (färdigställandemetoden).** Aktivera nedlagda utgifter: Debet **1471** / Kredit **4970**. À conto-fakturering: Debet 1510 / Kredit **2431** Pågående arbeten, fakturering (eller 1478 i tillgångsklass beroende på saldo). Bruttoredovisas per uppdrag (Srf U 14). För räkenskapsår som inleds efter 2025-12-31 är kvittning mellan uppdrag uttryckligen förbjuden (BFN-beslut 2025-06-16). Lagref: BFNAR 2016:10 K2 punkt 6.13-6.26; 17 kap. 23, 26, 27 §§ IL.

## 6. Öppna frågor och osäkerheter

Brukstexten i ursprungsuppgiften hade flera fel som denna skill rättar: K3 är **BFNAR 2012:1** inte 2017:1; **1478** är "Pågående arbeten, fakturering" inte "Förskott till leverantörer" (det senare är 1480/1489); **6541** och **7560** finns inte i BAS 2025; **7210** är tjänstemän, kollektivanställda är **7010**; **3232** existerar inte (ROT-fordran går via 1513); **5614** är vakant; den nya ML (2023:200) använder "omvänd betalningsskyldighet" inte "omvänd skattskyldighet" (terminologisk ändring, materiellt oförändrad). HFD-praxis 2020-2026 specifikt på omvänd byggmoms, pågående arbeten och kontrollavgift är **tunn**: området regleras främst genom Skatteverkets ställningstaganden och kammarrätts-domar; revisor bör verifiera vid behov i JUNO/Karnov. Skatteverkets ställningstaganden om ROT-gränsfall 2022-2026 är inte uttömmande täckta här: konsultera `skatteverket.se/rattsligvagledning` listan "Ställningstaganden: Rot- och rutarbete". AB 25 och ABPU 25 förväntas från BKK sommaren 2026: verifiera om de har ikraftträtt och om garantitiderna ändras. ROT-subventionsgraden 50 % avser perioden 2025-05-12 till 2025-12-31; vid ärenden från 2026 verifiera att återgång till 30 % har skett enligt plan. SNI 2007 användes i SCB:s äldre indelning: SCB har 2025 migrerat till SNI 2025 där t.ex. takarbeten flyttats från 43.91 till 43.41; denna skill bygger på SNI 2007 enligt uppgift, men vid integration mot moderna SCB-tjänster kan kodmappning behövas. Verifiera alltid lokala kontoplansavvikelser: företag lägger ofta upp egna underkonton i 1470-/2430-/4600-/4970-serierna.
