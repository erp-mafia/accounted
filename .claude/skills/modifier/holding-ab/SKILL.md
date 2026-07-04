---
id: modifier/holding-ab
tier: modifier
title: "Holdingbolag (rena ägar-/förvaltningsbolag)"
description: >
  Modifier for Swedish holding-aktiebolag (typiskt SNI 64.20): rena ägar-/förvaltningsbolag utan operativ omsättning vars resultat domineras av utdelning, koncernbidrag, ränteintäkter på koncerninterna lån och kapitalvinst på näringsbetingade andelar. Aktivera när AB:t har BAS 1310/1312/1330 dominerande i balansen utan 3xxx-omsättning, eller när transaktionerna rör näringsbetingade andelar (IL 24 kap 32-42 §§), koncernbidrag (IL 35 kap), ränteavdragsbegränsning (IL 24 kap 16-29 §§), aktieägartillskott, skalbolag, kupongskatt, holdingbolags momsavdrag eller kvalificerade andelar 3:12. Trigga även utan "holding-AB"-formuleringen: moderbolag, dotterbolag, koncern, förvärvsbolag, M&A-moms, reavinst på dotterbolagsförsäljning eller utdelning från dotter indikerar att modifern ska laddas. Påverkas av HFD 2023 ref. 41 (Volvo), HFD 2024 ref. 18 (Lamiflex), prop. 2025/26:20 (ränteavdrag) och SFS 2025:1361 (3:12).
sni_prefixes: ["64.20"]
trigger_signals:
  ownership: "holding_structure"
  text_patterns:
    - "näringsbetingade andelar"
    - "koncernbidrag"
    - "utdelning dotterbolag"
    - "aktieägartillskott"
    - "ränteavdragsbegränsning"
    - "kapitalförsäkring"
    - "kupongskatt"
    - "underprisöverlåtelse"
    - "skalbolag"
    - "management fee dotterbolag"
  bas_account_signals:
    - "1310"
    - "1312"
    - "1318"
    - "1330"
    - "1385"
    - "1662"
    - "2093"
    - "2860"
    - "8012"
    - "8022"
    - "8072"
    - "8820"
    - "8830"
estimated_tokens: 11000
version: 1
---

# Holding-AB (SNI 64.20): vertikalskill

## 1. När denna skill används

Aktivera när bolaget saknar operativ omsättning (3xxx ≈ 0) och resultatet drivs av 80xx-poster (utdelning från dotter, koncernbidrag, reavinst på andelar, ränta från koncernföretag). Typiskt: enmans-/familjeägt holding över ett eller flera operativa dotterbolag, PE-portföljbolag, eller styrnod i koncerntopp. **Avgränsa mot:** rent investmentföretag (IL 39 kap, kapitalförvaltning för fysiska delägare via värdepappersportfölj, SNI 64.30/64.99, ej koncernbidragsberättigat enligt 35 kap 3 § p. 1); operativt moderbolag med egen omsättning och central stab (faktiska 3xxx-intäkter, fallet faller i branschskill för operativ verksamhet, denna skill används sekundärt för koncernkonton). Skatterättsligt finns ingen särkategori "holding-AB": alla regler nedan är allmänna AB-regler som i praktiken nästan uteslutande aktualiseras för holdingstrukturer.

## 2. Typiska arbetsflöden

**Fakturering:** oftast ingen. Om aktiv förvaltning: månads-/kvartalsvis management fee till dotterbolag (25 % moms, konto 3740 eller motsv. omsättningskonto, motkonto 1510 mot dotter). **Värden måste vara armlängdsmässiga (IL 14 kap 19 §) och tjänsterna faktiskt utförda**: proforma management fee underkänns för både moms (HFD 2024 ref. 34 II) och inkomstskatt. Hyresfakturor om holdingen äger driftsfastighet och hyr ut till dotter (Marle Participations C-320/17 ger momsavdragsrätt).

**Kostnadsrytm:** revisorsarvode (årligen), redovisningsbyrå (löpande), juridisk rådgivning (oregelbundet), M&A-kostnader vid förvärv/avyttring (klumpsummor), finansiella kostnader på förvärvslån (löpande). M&A-moms är momsskillens kärnfråga (sektion 4a).

**Avstämning:** månadsvis avstämning av koncerninterna mellanhavanden (1660-1662 ↔ 2860-2862; 1320 ↔ motpartens 2353; 8260/8462 ↔ motpartens räntepost). Kvartalsvis upprättande av underlag för koncernredovisning om sådan ska upprättas (mindre koncern undantagen, ÅRL 7 kap 3 §, gränsvärden 50 anställda / 40 MSEK balansomslutning / 80 MSEK nettoomsättning per 2026, oförändrade trots SOU 2023:34). Årlig nedskrivningsprövning av andelar (ÅRL 4 kap 5 §; K3 27.3-27.13 indikatorbedömning; K2 19.8 schablon "lägsta av 25 000 kr eller 10 % av EK").

**Lön:** typiskt ingen löpande lön. Styrelsearvode bokförs på 7240/7510. Om ägaren tar lön via holdingen för att uppnå **löneuttagskrav slopas dock från 2026** (IL 57 kap 19 § upphävd via SFS 2025:1361): strategin "lön i holding för 3:12-utrymme" är delvis överspelad; löneunderlaget från dotterbolagens anställda räknas in i moderbolagets gränsbelopp (57 kap 16 §, civilrättslig dotterföretagsdefinition).

## 3. BAS 2025-konton för holding-AB

Verifierat mot bas.se/kontoplaner/bas-2025. Ingen ändring i koncern-/holding-relevanta konton mellan BAS 2024 och BAS 2025; reformerna i BAS 2025 avser endast moms-formulering, delägarlån (1360/1369/1685) och periodiseringsfondsår (2126/2136 ny, 2127/2137 borttagna).

| BAS 2025 | Officiellt namn | Holding-AB-specifik användning |
|---|---|---|
| **1310** | Andelar i koncernföretag | Samlingskonto. Vid första förvärv av dotter: D 1310 mot K likvida. |
| **1312** | Aktier i onoterade svenska koncernföretag | **Det dominerande tillgångskontot** i typisk svensk holding. |
| **1314** | Aktier i onoterade utländska koncernföretag | Onoterat utländskt dotter (LP, GmbH, Ltd). |
| **1318** | Ackumulerade nedskrivningar av andelar i koncernföretag | Krediteras vid bestående värdenedgång; ackumulerat mot 1310-serien. |
| **1320** | Långfristiga fordringar hos koncernföretag | Reverslån till dotter > 12 mån (cash pool, förvärvsfinansiering). |
| **1330** | Andelar i intresseföretag, gemensamt styrda företag och övriga företag som det finns ett ägarintresse i | 20-50 % ägande utan koncernrelation. |
| **1336** | Andelar i övriga företag som det finns ett ägarintresse i | < 20 % strategiskt ägande (ej ren finansiell placering). |
| **1338** | Ackumulerade nedskrivningar av andelar i intresseföretag … | Nedskrivningskonto 1330-gruppen. |
| **1350** | Andelar och värdepapper i andra företag | Långsiktig portfölj utan ägarintresse (passiv placering). |
| **1380** | Andra långfristiga fordringar | Övriga reverser, depositioner, ej värdepapper. |
| **1385** | Kapitalförsäkring | Standardkontot för KF i holding (premiumvärdet, anskaffningsvärdesmetod enligt RedR 9). |
| **1660** | Kortfristiga fordringar hos koncernföretag | Samlingskonto. Motkonto vid mottaget koncernbidrag innan reglering. |
| **1662** | Kortfristiga fordringar hos dotterföretag | **Centralt i moder**: fordran på dotter för utdelning/koncernbidrag innan kontant reglering. |
| **2093** | Erhållna aktieägartillskott | I bolaget som tar emot tillskott. Klassificeras under fritt eget kapital. |
| **2350** | Andra långfristiga skulder till kreditinstitut | Bankfinansierat förvärvslån > 12 mån. |
| **2860** | Kortfristiga skulder till koncernföretag | Motkonto i givande bolag för lämnat koncernbidrag (D 8830 / K 2860). |
| **2862** | Kortfristiga skulder till dotterföretag | I moder om kortfristig skuld nedåt. |
| **8010 / 8012** | Utdelning på andelar i koncernföretag / dotterföretag | **Huvudintäktskontot.** Krediteras mot 1662/likvida. |
| **8020 / 8022** | Resultat vid försäljning av andelar i koncernföretag / dotterföretag | Reavinst/-förlust på dotterbolagsförsäljning. **Vinst skattefri, förlust ej avdragsgill** (IL 25 a kap 5 §). |
| **8070 / 8072** | Nedskrivningar av andelar i och långfristiga fordringar hos koncernföretag / dotterföretag | **Bokföringsmässigt avdragsgill, skattemässigt ej** för andelar (skattemässig justering i INK2 ruta 4.7 b). |
| **8080 / 8082** | Återföringar av nedskrivningar … / dotterföretag | Reversering enl. ÅRL 4 kap 5 § 3 st / K3 27.13. |
| **8260 / 8262** | Ränteintäkter från långfristiga fordringar hos koncernföretag / dotterföretag | Ränta på 1320-reverser. Måste vara armlängdsmässig (IL 14 kap 19 §). |
| **8460 / 8462** | Räntekostnader till koncernföretag / dotterföretag | Speglar motpartens 8260/8262. **Avdragsrätt prövas mot IL 24 kap 18-19 §§ + 21-29 §§.** |
| **8820** | Erhållna koncernbidrag | Krediteras mot 1662/likvida i mottagande bolag. Bokslutsdisposition. |
| **8830** | Lämnade koncernbidrag | Debiteras mot 2860/likvida i givande bolag. Bokslutsdisposition. |
| **2091** | Balanserad vinst eller förlust | Ackumulerade utdelningsbara medel, typiskt stor post i etablerad holding. |
| **2098** | Vinst eller förlust från föregående år | Föregående års resultat före stämmobeslut. |

**Vanliga BAS-felval i holding-AB** (sett i Fortnox/Visma/Bokio-data): 8423 används felaktigt för "ränta till koncern": det är ränta på skattekontot; korrekt är **8460/8462**. 8077 används felaktigt som "återföring nedskrivning": det är *nedskrivning av lån till dotter*; återföring av nedskrivning av aktier i dotter är **8082**. 1380 används felaktigt för "långfristiga värdepappersinnehav": det är **1350** (1380 = övriga långfristiga fordringar).

## 4. Reglerande särfall: högsta värdedensiteten

### 4a. Moms: när är holdingbolaget skattskyldigt?

**Lagrum:** ML (2023:200), ikraft 2023-07-01 (ersätter ML 1994:200). Materiella regler oförändrade för holdingbolag. **4 kap 2 § ML** definierar beskattningsbar person (motsv. art. 9.1 momsdirektivet). **13 kap 6 § ML** reglerar avdrag (motsv. art. 168). **4 kap 7-14 §§ ML** reglerar mervärdesskattegrupp (motsv. gamla 6 a kap ML 1994:200).

**Tre lägen:**

| Profil | Status | Avdragsrätt |
|---|---|---|
| Passivt holding: enbart andelsinnehav, ingen fakturering till dotter | Ej beskattningsbar person (C-60/90 Polysar; C-28/16 MVM; HFD 2024 ref. 34 II) | **Noll.** Ingående moms bokförs som kostnad (inkl. moms på 6420 Revisor, 6530 Juridik, M&A-kostnader). |
| Aktivt holding: fortlöpande momspliktig management fee, hyresupplåtelse, IT/HR/ekonomi-tjänster mot ersättning till dotter (eller dotterdotter, HFD 2024 ref. 18 Lamiflex) | Beskattningsbar person (C-142/99 Floridienne; C-320/17 Marle) | **Full**, även på M&A-kostnader och försäljningskostnader om de inte övervältras på köparen (HFD 2023 ref. 41 Volvo AB; C-16/00 Cibo). |
| Blandat: vissa dotter aktiva, andra passiva, eller även PE-investeringsverksamhet | Delvis beskattningsbar | **Proportionell efter skälig grund** (Sonaecom C-42/19 p. 47; KRNG mål 5919-5220-23 efter återförvisning HFD 2023 ref. 41). |

**M&A-kostnader vid förvärv:** avdragsrätt förutsätter **avsikt vid förvärvstillfället** att aktivt förvalta målbolaget (C-16/00 Cibo; HFD 2024 ref. 18). Avbrutet förvärv: avdrag kvarstår om avsikt styrkt (Ryanair C-249/17; Sonaecom C-42/19) men **faktisk skattefri användning av kapitalet (t.ex. lån vidare till koncern) går före ursprunglig avsikt** (Sonaecom p. 53-69).

**Försäljningskostnader vid avyttring av dotter:** undantagen finansiell tjänst enl. 10 kap 33 § ML. Direkt hänförliga kostnader ej avdragsgilla (C-4/94 BLP). Men: HFD 2023 ref. 41 fastslår att kostnader vid avyttring är **allmänna omkostnader** med full avdragsrätt om syftet är att effektivisera kvarvarande verksamhet och kostnaderna inte övervältras på köparen.

**Mervärdesskattegrupp (4 kap 7-14 §§ ML):** kräver (a) endast deltagare under FI-tillsyn med finansiella/försäkringsundantagna tjänster eller kommissionärsförhållande (4 kap 8 §); (b) svenskt fast etableringsställe (4 kap 9 §; jfr Skandia C-7/13, Danske Bank C-812/19); (c) alla tre samband: finansiellt + ekonomiskt + organisatoriskt (4 kap 10 §). **Passivt holding kan inte ingå** (är ej beskattningsbar person). Sällsynt utanför bank/försäkring.

**Management fee-prissättning:** efter **C-808/23 Högkullen (3 juli 2025)** och **HFD 2026-01-27 mål 3217-21** kan Skatteverket inte schablonmässigt omvärdera management fee till självkostnadsbas. Koncerninterna förvaltningstjänster är **inte ett enda odelbart tillhandahållande**; marknadsvärde ska bestämmas per tjänst med jämförbar marknadstransaktion som första metod (8 kap ML; art. 80 momsdirektivet). Skatteverkets ställningstagande 190430 (dnr 202 195456-19/111) om självkostnadsmetod är överspelat i sin schablonmässiga del. Sexåriga omprövningsbara perioder bör granskas.

**Skatteverket Rättslig vägledning:** "Holdingbolag: avdragsrätt för mervärdesskatt" (dnr 202 377677-17/111, uppdaterad 2024-03-21 efter HFD 2024 ref. 18): `skatteverket.se/rattsligvagledning/365766.html`.

### 4b. Bokföring: andelsvärdering, tillskott, koncernbidrag

**Andelar i koncern/intresse, anskaffningsvärdemetoden:** ÅRL 4 kap 3 § + K2 BFNAR 2016:10 kap 11, 19 / K3 BFNAR 2012:1 kap 11. **Kapitalandelsmetoden får inte användas i juridisk person under K3** (endast i koncernredovisning, K3 14.3-14.5). Under K2 är kostnadsmetoden enda alternativet.

**Nedskrivning:**
- **K2 (19.8):** schablonregel: nedskrivning krävs om värdet understiger redovisat värde med mer än det lägsta av **25 000 kr eller 10 % av eget kapital vid årets ingång**. Värde noll → alltid ned till noll.
- **K3 (kap 27):** **återvinningsvärde = max(nyttjandevärde, verkligt värde − försäljningskostnader)**. Nedskrivning till återvinningsvärde när detta understiger redovisat värde. Reversering tillåten (27.13), utom för goodwill.
- ÅRL 4 kap 5 § 2 st: finansiell anläggningstillgång *får* skrivas ned till lägre värde på balansdagen även om värdenedgången inte är bestående (lägsta värdets princip).
- **Skatterättsligt:** nedskrivning av andelar är **ej avdragsgill** om andelarna är näringsbetingade (justeras i INK2 ruta 4.7 b "Bokförda kostnader som ej ska dras av"). Återföring av sådan nedskrivning är **ej skattepliktig** (4.5 b).

**Aktieägartillskott, ovillkorat:**
- **Givaren:** D 1310/1312 (ökar anskaffningsvärdet på andelarna, K2 19.5; K3 11.10-11.12) / K likvida eller 2860. Skattemässigt: ökar omkostnadsbeloppet vid framtida avyttring (44 kap 14 § IL).
- **Mottagaren:** D likvida / K **2093 Erhållna aktieägartillskott** (fritt eget kapital). Skattefritt.
- Återbetalning = vinstutdelning (kräver utdelningsbara medel, ABL 17-18 kap; utdelningsbeskattas hos ägaren).

**Aktieägartillskott, villkorat:**
- **Givaren:** D 1380 (fordran, inte ökning av andelsvärde) / K likvida. Förlust avdragsgill om verklig och definitiv (RÅ 2008 ref. 24), inte fångad av aktiefållan i 48 kap 26 § IL.
- **Mottagaren:** identiskt med ovillkorat (K 2093).
- Återbetalning skattefri hos givaren intill omkostnadsbeloppet (RÅ 1988 ref. 65; RÅ 2009 ref. 41).
- **Omvandling villkorat → ovillkorat = avyttring** skattemässigt (RÅ 2009 ref. 41).
- **NY REGEL från räkenskapsår 2026:** Utfästelse om tillskott måste lämnas **senast på balansdagen** för att tillskottet ska redovisas på det året (BFN beslut 2025-06-16; tidigare regel om utfästelse mellan balansdag och årsredovisningens upprättande borttagen).
- BFN U 97:2 är **upphävt** och inarbetat i K2/K3.

**Koncernbidrag, redovisning:**
- **Givare:** D 8830 Lämnade koncernbidrag / K 2860 alt. likvida.
- **Mottagare:** D 1660/1662 alt. likvida / K 8820 Erhållna koncernbidrag.
- Klassificeras som **bokslutsdisposition** i RR (under finansiella poster, efter resultat efter finansiella poster). Alternativ redovisning direkt mot fritt eget kapital är tillåten enligt RFR 2 för noterade men i icke-noterad K3-miljö är 8820/8830 standard. K2 har enbart bokslutsdispositionsalternativet.
- **Civilrättsligt krav:** koncernbidrag = värdeöverföring enl. ABL 17 kap 1 § + 3 § (beloppsspärr + försiktighetsregel). Kräver formellt beslut (oftast bolagsstämma); styrelseyttrande enl. ABL 18 kap 4 § är obligatoriskt och kan inte avtalas bort (NJA 2015 s. 359; HD T 5171-23, 2024).

**Koncernredovisning ÅRL 7 kap:** mindre koncerner undantagna (7 kap 3 §). **Gränsvärden 2026 (oförändrade): 50 anställda / 40 MSEK balansomslutning / 80 MSEK nettoomsättning**: koncern är "större" om mer än ett av villkoren uppfyllts två räkenskapsår i följd. Interna fordringar/skulder elimineras vid mätning. Subkoncern: 7 kap 2 § ger undantag om EES-moder upprättar konsoliderad redovisning enligt direktiv 2013/34/EU. **K2 förbjuder koncernredovisning** (BFNAR 2016:10 p. 1.1): holding som är moder i större koncern måste tillämpa K3.

**Kapitalförsäkring i holding-AB:** FAR RedR 9. Anskaffningsvärdesmetoden: premier bokförs som finansiell anläggningstillgång (1385); löpande värdestegring redovisas inte. Uttag intäktsförs som finansiell intäkt (8350 alt.). Avkastningsskatt enl. AvPL (skattepliktig i bolaget, ej moms). **NY REGEL 2026:** särskild löneskatt på pensionsåtagande säkerställt av KF beräknas på KF:s marknadsvärde om detta överstiger åtagandets redovisade värde (K2 16.17, K3 28.12A, BFN-ändring 2025-06-16).

### 4c. Inkomstskatt: kärnan av denna skill

**Näringsbetingade andelar, IL 24 kap 32-42 §§** (SFS 2003:224 ikraft 2003-07-01; numrering ändrad SFS 2018:1206 ikraft 2019-01-01):
- **24 kap 32 § IL**, Definition: andel i AB/ek.för. ägd av svenskt AB som ej är investmentföretag, motsvarande EES-bolag, m.fl.
- **24 kap 33 § IL**, Villkor (kapitaltillgång + ett av): (a) **onoterad andel** automatiskt näringsbetingad (inget röst-/innehavskrav); (b) marknadsnoterad andel kräver **≥ 10 % av rösterna**; (c) andel betingad av rörelse hos ägaren eller närstående företag.
- **24 kap 35 § IL**: Utdelning på näringsbetingad andel tas inte upp till beskattning.
- **24 kap 40 § IL**: Marknadsnoterad andel måste ha innehafts **≥ 1 år** vid utdelnings-/avyttringstillfället. Onoterad har inget innehavskrav.

**Kapitalvinst, IL 25 a kap:**
- **25 a kap 5 § IL**: Kapitalvinst på näringsbetingad andel tas inte upp; **kapitalförlust är aldrig avdragsgill** (med smala undantag i 5 § 2 st).
- **25 a kap 19 § IL**: Avdragsförbud för förlust på tillgång vars underliggande tillgång är näringsbetingad andel. **HFD 2023 ref. 1**: gäller inte kapitalförlust på köpeskillingsrevers som uppkommit vid tidigare avyttring av näringsbetingade andelar (fordringen är inte själv underliggande näringsbetingad andel).

**Skalbolagsregler, IL 25 a kap 9-18 §§ + SFL 27 kap 2 §:**
- **25 a kap 9 §**: Vid avyttring av andel i skalbolag (eller återköp enl. 18 §) bortfaller skattefriheten: hela ersättningen tas upp som kapitalvinst.
- Skalbolagsdefinition: marknadsvärdet av likvida tillgångar > **jämförelsebeloppet** (halva ersättningen vid avyttring av samtliga andelar).
- **25 a kap 12 § "ventilen"**: undantag om väsentligt inflytande inte går över eller särskilda skäl föreligger (skatten betalas, koncernbidragsrätt köpare/säljare).
- **Skalbolagsdeklaration:** inom **60 dagar** från avyttring (SFL 27 kap 4 §); säkerhet för slutlig skatt kan krävas.

**Koncernbidrag, IL 35 kap:**
- **35 kap 1 § IL**: Avdrag hos givare, intäkt hos mottagare; **värdeöverföring senast på inkomstdeklarationsdagen** (kodifierat SFS 2016:1239 ikraft 2017-01-01).
- **35 kap 2 § IL**: Moderföretag = svenskt AB/ek.för./sparbank/öms.försäkr./skattepliktig stiftelse-ideell förening som äger **> 90 %** av dotter.
- **35 kap 2 a § IL**: EES-bolag som motsvarar svenskt jämställs om skattskyldigt i Sverige för verksamheten (svensk filial).
- **35 kap 3 § IL**, Förutsättningar: ej privatbostadsföretag/investmentföretag; öppen redovisning; **dotter helägt under hela båda bolagens beskattningsår** (eller sedan verksamhet inleddes); mottagare ej hemvist utanför Sverige enligt skatteavtal; vid DF→MF: utdelning från DF får inte vara skattepliktig hos MF.
- **35 kap 4-6 §§**: Slussning mellan systerbolag via MF; fusionsregel.
- **Civilrättslig grund:** ABL 17 kap 1 § + 3 § (beloppsspärr + försiktighetsregel); ABL 18 kap 4 § styrelseyttrande obligatoriskt (NJA 2015 s. 359; HD T 5171-23, 2024).

**Ränteavdragsbegränsning, IL 24 kap (SFS 2018:1206, ikraft 2019-01-01):**

Generell EBITDA-regel:
- **24 kap 21 § IL**, Tillämpningsområde: jur. pers. och svenska HB (HB med enbart fysiska ägare undantagna).
- **24 kap 23 § IL**: Negativt räntenetto = avdragsgilla ränteutgifter − skattepliktiga ränteinkomster.
- **24 kap 24 § IL**: **30 % av avdragsunderlag** (resultat före ränta, skatt, av- och nedskrivningar = "skattemässigt EBITDA"). Förenklingsregel 3 st: **5 MSEK** av negativt räntenetto får alltid dras av (per intressegemenskap; vid tillämpning får inget kvarstående räntenetto sparas).
- **24 kap 26 § IL**: Carry forward **6 år**.
- **24 kap 27-29 §§**: Beräkning, ägarförändringseffekter.

Riktade regler (koncerninterna lån), IL 24 kap 16-20 §§:
- **24 kap 18 § 1 st**: Avdragsrätt om mottagaren hör hemma inom EES eller beskattas ≥ 10 % (tioprocentsregeln).
- **24 kap 18 § 2 st "undantagsregeln"**: Ej avdrag om skuldförhållandet **uteslutande eller så gott som uteslutande** uppkommit för väsentlig skatteförmån.
- **24 kap 19 § "förvärvsregeln"**, Skuld för koncerninternt förvärv av delägarrätt: avdrag bara om förvärvet är **väsentligen affärsmässigt motiverat** (organisatoriska skäl räcker ej, HFD 2022 ref. 49).
- **EU-rätt:** **C-484/19 Lexel (20 jan 2021)** underkände 2013 års undantagsregel; **HFD 2021 ref. 68** underkände 2019 års lydelse på samma grund; **HFD 2024 ref. 6 (22 jan 2024)** underkände 24 kap 19 § (förvärvsregeln) som EU-rättsstridig när koncernbidragsrätt funnits om båda bolagen varit svenska.
- **2026 års reform:** prop. 2025/26:20 (bet. SkU8): ny **24 kap 19 a § IL** för skuldförhållanden inom EES; omformulerade 18 § 2 st och 19 §; ikraft 2026-01-01.

**Kupongskatt, KupL (1970:624):**
- **5 §**: 30 % på utdelning till begränsat skattskyldig fysisk/jur. person; reduceras genom skatteavtal (vanligen 15 %, 5 % eller 0 %).
- **4 § 5 st**, Undantag enligt moder/dotterbolagsdirektivet 2011/96/EU: EU-juridisk person med ≥ 10 % andelskapital och som uppfyller direktivets art. 2.
- **4 § 6-7 st**: Undantag för EES-bolag som motsvarar svenskt AB enligt IL 24 kap 32 § 1-4 och 33 § 1 st 1 eller 2; innehavstid ≥ 1 år.

**Förbjudna lån, ABL 21 kap + IL 11 kap 45 §:**
- **ABL 21 kap 1 §**: Förbud mot lån till aktieägare/närstående.
- **ABL 21 kap 2 § 1 st p. 2**, **Koncernundantaget**: lån till annat företag i samma koncern är tillåtet (moder→dotter, dotter→moder, syster↔syster). Koncerndefinition ABL 1 kap 11 §. **2 st utvidgar till EES-moder.**
- **IL 11 kap 45 §**: Fysisk låntagare beskattas för hela lånebeloppet i inkomstslaget tjänst. **IL 15 kap 3 §**: annan juridisk person än AB tar upp lånebeloppet som näringsverksamhet. **AB som låntagare är generellt undantagna** (SFS 2009:1412).

**CFC, IL 39 a kap:**
- **39 a kap 5 § IL**: Lågbeskattad om utländsk jur. pers. beskattas < 55 % av svenskt AB (med 20,6 % bolagsskatt → tröskel **≈ 11,33 %**).
- **39 a kap 7 § + bilaga 39 a**, "Vita listan": undantagna områden/inkomstkategorier.
- **39 a kap 7 a § IL**: EES-bolag undantas om de utgör **verklig etablering** med affärsmässigt motiverad verksamhet (efter C-196/04 Cadbury Schweppes, kodifierat SFS 2007:1254).

**Omstruktureringar, IL 23, 37, 38, 38 a, 42, 48 a, 49 kap:**
- **IL 23 kap** Underprisöverlåtelser (NB: i 23 kap, inte 53 kap, 53 kap reglerar överlåtelser till utländska företag från fysiska personer).
- **IL 37 kap** Kvalificerade fusioner och fissioner.
- **IL 38 kap** Verksamhetsavyttring; **IL 38 a kap** Partiella fissioner.
- **IL 42 kap 16 § Lex ASEA**: skattefri utdelning av samtliga aktier i dotterbolag om utdelande moder är marknadsnoterad och övriga villkor uppfyllda.
- **IL 48 a kap** Framskjuten beskattning vid andelsbyten (fysiska); **IL 49 kap** Uppskovsgrundande andelsbyten (juridiska).

**IL 35 a kap Koncernavdrag (slutliga förluster i EES-dotter)**: kodifiering av Marks & Spencer-doktrin (C-446/03), ikraft 2010-07-01 (SFS 2010:353). Krav: > 90 % helägt, **direkt ägt** (HFD 2019 not. 38 Holmen), inom EES, slutligt avvecklat, MF ej investmentföretag. Snäv praktisk tillämpning.

**3:12, kvalificerade andelar IL 57 kap, STOR REFORM SFS 2025:1361 ikraft 2026-01-01:**
- **57 kap 4 § IL**, Smitta mellan dotterbolag via holdingbolag: ägare verksam i ett dotter → holdingens andelar kvalificerade. "Samma eller likartad verksamhet"-rekvisitet smittar via överförda vinstmedel/kapital (RÅ 2010 ref. 11 I-V; HFD 2023 ref. 11 Intersport/Adelis; HFD 2024 ref. 51).
- **57 kap 16 § IL (ny lydelse 2026)**: Löneunderlag = kontant ersättning till anställda i företaget **och dess dotterföretag** (civilrättslig definition); löner i dotterbolag räknas in i holdingens gränsbelopp (proportionerligt vid < 100 % ägande).
- **57 kap 16 a § IL (ny 2026)**: Schablonavdrag **8 IBB per delägare** från löneunderlaget (≈ 644 800 kr 2026 baserat på IBB 80 600 kr).
- **57 kap 17 § IL**: Lönebaserat utrymme = **50 %** av löneunderlaget efter schablonavdrag.
- **57 kap 19 § IL UPPHÄVD 2026**: **Löneuttagskravet för delägaren slopas**. Ingen lägstanivå för ägares eller närståendes löneuttag krävs.
- **Grundbelopp 4 IBB (322 400 kr 2026)** per företag fördelat efter ägarandel. Räntebaserat utrymme: SLR + 9 % på omkostnadsbelopp **överstigande 100 000 kr**. Uppräkning av sparat utdelningsutrymme **slopad**. Karenstid förkortad från 5 → 4 år (gäller utlösande händelser från 2027). 4 %-spärren (kapitalandelskravet) slopad.

### 4d. HFD och Skatteverket: senaste 5 åren (urval för holding-AB)

| Avgörande | Område | Holding |
|---|---|---|
| HFD 2021 ref. 33 ("Hoist") | Skalbolag / underskott | Skatteflyktslagen ej tillämplig på förvärv av underskottsbolag finansierat via övertagen säljarskuld; ledde till stopplag prop. 2021/22:93. |
| HFD 2021 ref. 40 ("Valedo") | 3:12 / PE-strukturer | Aktieslagsuppdelning A/B + ägaravtal → särskilda skäl mot utomståenderegeln. |
| HFD 2021 ref. 66 | Koncernbidrag | Ändrad ägarstruktur inom koncern utlöser ej koncernbidragsspärr enl. 40 kap 10 § 3 st om bestämmande inflytande består. |
| HFD 2021 ref. 68 | Ränteavdrag | 2019 års undantagsregel 24 kap 18 § 2 st EU-stridig vid svensk koncernbidragsrätt. |
| HFD 2021 not. 10 | Ränteavdrag | Tillämpar Lexel C-484/19 på 2013 års regel. |
| HFD 2022 ref. 49 | Ränteavdrag | 24 kap 19 § förvärvsregel: organisatoriska skäl räcker ej som affärsmässighet. |
| HFD 2022 not. 3 | Näringsbetingade | Andelar i Liechtenstein-Anstalt näringsbetingade trots lågbeskattning: formell skattskyldighet räcker. |
| HFD 2023 ref. 1 | Näringsbetingade | Köpeskillingsrevers efter avyttring av nb-andelar omfattas inte av 25 a kap 19 § avdragsförbud. |
| HFD 2023 ref. 11 ("Adelis") | 3:12 / utomståenderegeln | Förvärv genom nyemission i annat fåmansföretag → inte "samma eller likartad verksamhet" om vinstmedel ej överförts. |
| HFD 2023 ref. 41 (Volvo AB) | Moms / aktieförsäljning | Aktivt holding har avdragsrätt för moms på försäljningskostnader om kostnaderna inte övervältras på köparen: allmänna omkostnader. |
| HFD 2024 ref. 6 | Ränteavdrag | 24 kap 19 § förvärvsregel EU-stridig vid svensk koncernbidragsrätt → 2026-reform. |
| HFD 2024 ref. 18 (Lamiflex) | Moms / aktieförvärv | Avdragsrätt vid förvärv av "rent" holding där förvaltningstjänster levereras till dotterdotter. |
| HFD 2024 ref. 34 I-II | Moms / scheinmanagement | Bolag som inte fakturerar dotter och inte vidarefakturerar saknar ekonomisk verksamhet → ingen avdragsrätt; momsregistrering ger inte berättigade förväntningar. |
| HFD 2024 ref. 51 | 3:12 / smitta | "Samma eller likartad verksamhet": vinstmedel överförda från Z AB till Y AB → kvalificerade andelar i Y AB. |
| HFD 2026-01-27 mål 3217-21 (Högkullen) | Moms / management fee | Underkänner Skatteverkets schablonmässiga omvärdering av management fee, efter EUD C-808/23. |
| HD T 5171-23 (2024) | Koncernbidrag civilrätt | Försiktighetsregeln tillämpas med återhållsamhet; styrelseyttrande ABL 18 kap 4 § kan inte avtalas bort. |

**Skatteverkets ställningstaganden:**
- "Holdingbolag: avdragsrätt för mervärdesskatt", dnr 202 377677-17/111 (uppdaterat 2024-03-21 efter HFD 2024 ref. 18).
- "Avsnitt 4.2.4 om riskkapitalbolag upphör att gälla", 2024-02-02, dnr 8-2756161: PE-investeringsverksamhet = icke-ekonomisk verksamhet.
- "När motsvarar en utländsk juridisk person ett svenskt AB vid tillämpning av reglerna om näringsbetingade andelar", 2022-10 (ersätter äldre); SICAV med variabelt kapital motsvarar ej svenskt AB; Jersey/Liechtenstein-Anstalt OK efter HFD 2022 not. 3.
- "Koncernbidrag mellan svenskt företag och utländskt bolags fasta driftställe i Sverige när det utländska bolaget hör hemma utanför EES": kräver diskrimineringsförbud i skatteavtal motsv. OECD-modellen art. 24.3.
- "Förluster på fordringar på eget bolag", dnr 131 440547-09/111: omvandling fordran ↔ villkorat tillskott = avyttring.

## 5. De tre vanligaste felmönstren

**Felmönster 1: Passivt holding drar av ingående moms på revisor och M&A-kostnader.**
*Fel:* Holdingbolaget bokför ingående moms på 6420 Revisor, 6530 Juridik, M&A-konsulter på 2641 trots att bolaget aldrig fakturerar dotter (ingen management fee, ingen hyresupplåtelse). Skatteverket återkallar avdrag och påför skattetillägg.
*Rätt:* Utan momspliktig omsättning är holdingbolaget **inte beskattningsbar person** (4 kap 2 § ML; C-60/90 Polysar; HFD 2024 ref. 34 II). Hela kostnaden inklusive moms bokförs på kostnadskontot: ingen del på 2641. Om avsikt finns att börja fakturera dotter måste det styrkas redan vid kostnadens uppkomst (HFD 2024 ref. 18).
*Referens:* ML (2023:200) 4 kap 2 §, 13 kap 6 §; HFD 2024 ref. 34 I-II; Skatteverkets ställningstagande dnr 202 377677-17/111.

**Felmönster 2: Skattemässigt avdrag för kapitalförlust på näringsbetingade andelar.**
*Fel:* Moderbolag säljer dotter för 1 SEK efter förluståret, bokför kapitalförlust 4 200 000 SEK på 8022 och låter den slå igenom i skattepliktigt resultat. Eller skriver ned 1310 med 8072 och drar av nedskrivningen.
*Rätt:* Kapitalförlust på näringsbetingad andel är **aldrig avdragsgill** (IL 25 a kap 5 § 2 st). Återlägg i INK2 ruta 4.7 b "Bokförda kostnader som ej ska dras av". Detsamma gäller nedskrivning. Spegelbild: kapitalvinst tas inte upp (4.7 a). Undantag finns för kapitalförlust på köpeskillingsrevers (HFD 2023 ref. 1) som faller utanför avdragsförbudet i 25 a kap 19 §.
*Referens:* IL 25 a kap 5 § (SFS 2003:224); IL 25 a kap 19 §; HFD 2023 ref. 1.

**Felmönster 3: Ränteavdragsbegränsning ignoreras vid förvärvslån.**
*Fel:* Holdingbolaget tar förvärvslån 50 MSEK (extern bank eller koncernintern) för att köpa dotter, betalar ränta 2,5 MSEK/år och bokför fullt avdrag på 8410/8460 utan beräkning av räntenetto, EBITDA-tak eller förvärvsregelns affärsmässighet. Vid revision av Skatteverket återförs miljonbelopp.
*Rätt:* Beräkna negativt räntenetto enl. 24 kap 23 §. Pröva först **förenklingsregeln 5 MSEK** (24 kap 24 § 3 st): om räntenettot är under tröskeln behövs ingen EBITDA-beräkning. Annars beräkna **avdragsunderlaget** (≈ skattemässigt EBITDA) och tillämpa **30 %-taket**. Vid **koncerninternt** lån: pröva ytterligare 24 kap 18 § (tioprocentsregel + skatteförmånsundantag) och 24 kap 19 § (förvärvsregel, "väsentligen affärsmässigt motiverat"). Beakta EU-rättens utveckling (Lexel C-484/19; HFD 2021 ref. 68; HFD 2024 ref. 6) och **nya 24 kap 19 a §** ikraft 2026-01-01 för EES-långivare. Kvarstående negativt räntenetto sparas 6 år (24 kap 26 §).
*Referens:* IL 24 kap 21-29 §§ + 16-20 §§ (SFS 2018:1206 ikraft 2019-01-01); prop. 2025/26:20 (SkU8) ikraft 2026-01-01.

## 6. Öppna frågor: flagga för mänsklig granskning

1. **2026 års ränteavdragsanpassning (prop. 2025/26:20, SkU8, nya 24 kap 19 a § IL).** Ikraftträdandet 2026-01-01 är bekräftat men Skatteverkets vägledning är ännu inte färdiguppdaterad per maj 2026; tillämpning på pågående lån från före 2026 kräver granskning av övergångsregler.
2. **Skatteverkets omvärderingsställningstagande för koncerninterna tjänster (dnr 202 195456-19/111) efter Högkullen.** EUD C-808/23 (3 juli 2025) och HFD 2026-01-27 mål 3217-21 underkänner schablonmetoden men ny vägledning saknas. Omprövning av tidigare beslut inom 6-årsfristen bör övervägas men osäker praxis.
3. **3:12-reformen SFS 2025:1361: tillämpning första året.** Ikraftträdande 2026-01-01, men nya löneunderlagsregeln (civilrättslig dotterföretagsdefinition + schablonavdrag 8 IBB) saknar etablerad praxis; särskilt för holding med utländska dotterbolag (löner i utländska dotter, räknas de in?). Karenstidsförkortning 5→4 år gäller först från 2027.
4. **PE-fonder / riskkapitalbolag som holding-AB.** Skatteverket har 2024-02-02 (dnr 8-2756161) återkallat tidigare ställningstagande och behandlar PE-investeringsverksamhet som icke-ekonomisk (begränsad momsavdragsrätt). Fördelningsnyckel mellan ekonomisk/icke-ekonomisk verksamhet är inte standardiserad: kostnadsbaserad fördelning godtas (KRNG mål 5919-5220-23 efter HFD 2023 ref. 41) men inget bindande prejudikat.
5. **Höjda gränsvärden för "större företag/koncern" (SOU 2023:34).** Förslag finns men inte ikraftträtt per maj 2026. Påverkar valet K2 vs K3 för moderbolag och koncernredovisningsplikt.

## Overflow-referenser

För djupare detaljer hänvisas till följande filer i `references/`:

- `references/naringsbetingade-andelar.md`: full §-genomgång IL 24 kap 32-42 §§ och 25 a kap inklusive skalbolagsdetaljer, ventilbedömning, jämförelsebeloppsberäkning.
- `references/koncernbidrag.md`: IL 35 kap kompletta villkor (helägt, slussning, EES-filial), ABL 17-18 kap värdeöverföringsmekanik, NJA 2015 s. 359 + HD T 5171-23.
- `references/ranteavdrag.md`: IL 24 kap 16-29 §§ beräkningsexempel (EBITDA-tak, förenklingsregel, kvarstående räntenetto), Lexel-doktrinens utveckling, ny 24 kap 19 a § 2026.
- `references/moms-holdingbolag.md`: EU-praxis (Polysar→Högkullen), avdragsrätt vid förvärv/avyttring/avbrutet förvärv, mervärdesskattegrupp, Skatteverkets ställningstagande dnr 202 377677-17/111 i sin helhet, omvärdering management fee post-C-808/23.
- `references/aktieagartillskott.md`: ovillkorat vs villkorat, RÅ 2009 ref. 41 omvandling, K2/K3-redovisning 2026, fordringsförluster.
- `references/312-holding.md`: IL 57 kap reformen SFS 2025:1361 i detalj, smittobedömning via dotterbolag, löneunderlagsberäkning med schablonavdrag.
- `references/kupongskatt-cfc.md`: KupL (1970:624) struktur, moder/dotterbolagsdirektivet implementering, IL 39 a kap CFC inklusive bilaga 39 a-uppdateringar.
- `references/omstrukturering.md`: IL 23, 37, 38, 38 a, 42, 48 a, 49 kap för paketeringsförsäljningar och Lex ASEA.
