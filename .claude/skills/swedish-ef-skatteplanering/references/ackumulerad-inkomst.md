# Ackumulerad Inkomst

<!-- toc -->
**Contents**

- [Legal basis](#legal-basis)
- [Purpose](#purpose)
- [Terminologi: skiktgräns vs brytpunkt](#terminologi-skiktgräns-vs-brytpunkt)
- [Spärregler (cumulative: all must be true)](#spärregler-cumulative-all-must-be-true)
- [Fördelningstiden (allocation period)](#fördelningstiden-allocation-period)
- [Skatteberäkningen i praktiken](#skatteberäkningen-i-praktiken)
- [Typer av inkomster som kan vara AI](#typer-av-inkomster-som-kan-vara-ai)
- [Worked example: strukturell](#worked-example-strukturell)
- [Pitfalls](#pitfalls)
- [Implementation checklist for software](#implementation-checklist-for-software)
- [Combination strategies](#combination-strategies)
- [Pensionssparavdrag: relaterad fråga för EF](#pensionssparavdrag-relaterad-fråga-för-ef)

<!-- /toc -->

## Legal basis

- IL 66 kap (Särskild skatteberäkning för ackumulerad inkomst): full chapter
- Gäller endast fysiska personer och dödsbon, inte juridiska personer

## Purpose

Ackumulerad inkomst (AI) is en **särskild skatteberäkning** för att undvika tröskeleffekter vid den progressiva beskattningen of inkomster som tjänats in över flera år men betalats ut **ett enstaka år**.

Utan AI får en näringsidkare som upphör med verksamheten och måste återföra 600 000 kr i periodiseringsfonder hela återföringen beskattad det året: med total marginalskatt som ofta hamnar runt 52 % inklusive **statlig inkomstskatt 20 % över skiktgränsen** + kommunalskatt + egenavgifter. Med AI sprids beloppet tillbaka till åren det "egentligen" tjänats in, och statliga skatten beräknas som om det fördelats över de åren.

Note that AI **does NOT spread the income across years for SGI/PGI**: those use the actual deklarerade inkomsten av NV in each respektive year. AI affects only **statlig inkomstskatt** (20 %-skiktet), inte kommunal, egenavgifter, eller socialavgifter.

## Terminologi: skiktgräns vs brytpunkt

- **Skiktgräns**: gränsen i **beskattningsbar förvärvsinkomst** (efter grundavdrag) där statlig inkomstskatt 20 % börjar tas ut. 2025: **625 800 kr**. 2026: **643 000 kr**.
- **Brytpunkt**: motsvarande gräns i **bruttoinkomst** (före grundavdrag): vad lönen faktiskt behöver vara för att du ska börja betala statlig skatt. 2025: ca 643 100 kr. 2026: ca 660 400 kr.
- AI-spärregeln nedan använder **beskattningsbar inkomst** (alltså skiktgränsen, inte brytpunkten).

## Spärregler (cumulative: all must be true)

1. **Något av fördelningsåren ska ha haft beskattningsbar inkomst UNDER skiktgränsen för statlig inkomstskatt** under det aktuella året. If you were over skiktgränsen hela fördelningstiden, AI saves nothing.
2. **Den beskattningsbara inkomsten inklusive den ackumulerade inkomsten måste överstiga skiktgränsen med minst 50 000 kr** under det aktuella året (= you actually paid statlig skatt på minst 50 000 kr extra)
3. **Den ackumulerade inkomsten måste vara minst 50 000 kr**

Skiktgränsen 2025: **625 800 kr**. 2026: **643 000 kr**.

For pensionärer (fyllt 66 år vid beskattningsårets ingång 2025 och 2026; 67 år fr.o.m. 2027, IL 63 kap 3 a §), skiktgränsen är högre pga förhöjt grundavdrag. Beräkningen anpassas till deras höjda brytpunkt.

## Fördelningstiden (allocation period)

The ackumulerade inkomsten is divided by **antal år** som den intjänats för:
- Min: 2 år (om bara delar av två år)
- Max: **10 år**
- Om svårt att utreda → presumeras **3 år**

If the inkomsten har tjänats över t.ex. 7 år, divisorn är 7. Inkomsten delas i 7 lika delar (en per år), och dessa läggs på den **genomsnittliga förvärvsinkomsten** för alla 7 fördelningsåren. På denna nya totalinkomst beräknas statlig skatt; skatteminskningen vs scenario utan AI är AI-effekten.

Skattetabellsåren justeras efter skiktgränsens förändring i tiden, but skattesatsen för **aktuella beskattningsåret** används.

## Skatteberäkningen i praktiken

Skatteverket gör **inte** beräkningen automatiskt. Du måste **begära** ackumulerad inkomst:
- Antingen vid den ordinarie deklarationen (skriv under *Övriga upplysningar* eller på särskild bilaga)
- Eller via begäran inom 5 år efter deklarationsåret (om man missar tillfället)
- Innehåll: vad slags inkomst, beloppet, antal år som inkomsten hör till samt motivering varför

If the deklarerad inkomst senare ändras (eftertaxering, omprövning) → ansökan om AI kan lämnas inom **ett år från det beslutet** lämnades.

## Typer av inkomster som kan vara AI

### Före eller efter ordinarie utbetalning

AI omfattar inkomster du har fått:
- **I efterskott** (t.ex. ett engångsbelopp för en pensionsförmån som hör till tidigare år)
- **I förskott** (t.ex. en engångsroyalty för flera framtida år)

Inkomsten **måste höra till flera år**. En inkomst som hör till ett enda år, även om utbetalningen sker ett senare år, är inte AI.

> "Om en inkomst har tjänats in under ett visst år men har betalats ut (eller kan disponeras) först under ett senare år, är det inte ackumulerad inkomst."

### Vetenskaplig, litterär eller konstnärlig verksamhet

- Författare, konstnärer, vetenskapsmän, arkitekter (knutna till person)
- Inkomster som inte satts in på upphovsmannakonto
- Royaltybelopp för flera år utbetalda på en gång
- Försäljning vid utställning där produktionstiden flera år

Inte AI för: regulier royalty varje år, tantieme per bok varje år.

### Försäljning av rättigheter

- Hyresrätt-överlåtelse (med kontant ersättning)
- Varumärken-, företagsnamns-, goodwill-rättigheter
- Engångsersättning för att flytta från lokal i förtid

### Försäljning eller utrangering av inventarier vid avveckling

- Försäljning av inventarier som del av avveckling av verksamheten
- Försäkringsersättning jämställs om ersättningsfond inte används

### Periodiseringsfond och ersättningsfond: vid upphörande

- Återföring av P-fond pga verksamhets-upphörande får räknas som AI **om de återförda P-fonderna hör till minst 2 beskattningsår**
- Återföring av ersättningsfond pga överlåtelse / nedläggning samma sak

### Expansionsfond: vid nedläggning till noll

- Om expansionsfond minskas till noll och denna avveckling sker pga verksamhets-upphörande → den NV-inkomst som detta medför kan räknas som AI
- Krav: expansionsfonden hör till minst 2 beskattningsår

### Stipendier (begränsat)

Stipendier av kulturell prägel = oftast inte AI (engångserkänsla, inte arbetsinsats). Pliktstipendier som betalas högst 2 år i rad är **skattefria** alltid (då blir AI inte aktuellt).

### Ingenjörer m.fl.

Engångsersättning vid överlåtelse av patenträtt kan vara AI om royalty utbetalts för flera år på en gång.

### Skadestånd / försäkringsutbetalningar

Avbrottsförsäkring som ersätter förlust av inkomst för flera år: AI möjligt.

## Worked example: strukturell

Setup: vid avveckling återförs P-fonder på 600 000 kr (intjänade över 6 år). Lön samma år: 350 000 kr. Total förvärvsinkomst aktuellt år: 950 000 kr.

```
utan_AI:
  beskattningsbar_inkomst ≈ 950 000 − grundavdrag → tydligt över skiktgränsen 625 800 kr (2025)
  statlig_skatt = 20 % × (beskattningsbar − skiktgräns) ≈ 65 000 kr (extra)
  + kommunalskatt + egenavgifter på återföringen
  total ≈ 380 000 kr

med_AI (fördelningstid 6 år):
  per_år = 600 000 / 6 = 100 000 kr
  hypotetisk_årsinkomst = 350 000 + 100 000 = 450 000 kr  → under skiktgränsen alla 6 åren
  statlig_skatt_per_år = 0 (under skiktgräns)
  totalt: kommunalskatt + egenavgifter på återföringen oförändrade
  besparing = ~40 000-60 000 kr (= helt statlig skatt-bortfall)
```

Princip: AI är värt-att-räkna-på närhelst (a) ackumulerad inkomst ≥ 50 000 kr, (b) ett eller flera fördelningsår låg under skiktgränsen, OCH (c) aktuella året + ackumulerade beloppet driver över skiktgränsen med minst 50 000 kr. AI påverkar bara statlig skatt, inte kommunal eller egenavgifter.

## Pitfalls

1. **Inte begärt AI**: Skatteverket gör inte beräkningen automatiskt
2. **Inkomsten hör bara till ett år**: då är AI inte tillämplig (vanligt fel)
3. **Skiktgränsen ej justerad för pensionärer**: pensionärer (fyllt 66 år vid årets ingång 2025/2026, 67 år fr.o.m. 2027) har förhöjt grundavdrag → högre effektiv skiktgräns
4. **Glömt att SGI/PGI inte påverkas**: AI är skattetekniskt; sociala avgifter beräknas på faktisk redovisad inkomst per år
5. **5-årsregeln för efteransökan missad**: efter 5 år är AI-rätten förlorad
6. **AI på återförda P-fonder som hör till bara 1 år**: kräver minst 2 års fonder

## Implementation checklist for software

- [ ] Track origin years for each P-fond/expansionsfond (för fördelningstid)
- [ ] Compute provisional skatt with and without AI for verksamhets-upphörande year
- [ ] Surface AI-recommendation when sum of återförda fonder ≥ 50 000 kr AND user has been under brytpunkten in any of last 10 years
- [ ] Generate text-snippet for "Övriga upplysningar" i deklarationen with AI-begäran
- [ ] Save AI-beräkning som dokumentation för revision
- [ ] Allow re-running for ändrade förhållanden (omprövning inom 5 år)

## Combination strategies

The **strongest** planning use of AI är ihop med:

### Verksamhets-upphörande

- Avveckla over many years (avveckla successivt) → kan göra successiv återföring av P-fond + ny avsättning, så skatten skjuts up successivt → mindre AI-behov men längre stretchning
- Alternativt: avveckla på en gång → större toppinkomst → AI utnyttjar mer

### Sparat fördelningsbelopp (räntefördelning)

- Vid nedläggning kan sparat räntefördelningsbelopp användas mot återförd P-fond och expansionsfond
- This reduces the NV income from the lump återföring → may eliminate AI-need entirely if sparat fördelning fully covers
- See [[rantefordelning-planning]] (sparat fördelningsbelopp-mekanik vid nedläggning)

### Income leveling över flera år

- Better than waiting for AI är att **utjämna inkomsten** över åren via P-fond avsättningar/återföringar
- AI är en räddningsplanka för dåligt planerade upphöranden eller plötsliga inkomster
- Software borde uppmana till **proaktiv** utjämning rather than reaktiv AI

## Pensionssparavdrag: relaterad fråga för EF

Aktiva näringsidkare får göra **pensionssparavdrag** för pensionssparande, vilket också kan användas för att utjämna inkomst.

### Storlek

- **35% av årets eller föregående års inkomst** (max 10 prisbasbelopp ≈ 588 000 kr 2025)
- Underlaget: inkomsten av aktiv NV **efter räntefördelning, P-fond och expansionsfond**
- Krav: aktivt bedriven verksamhet *under beskattningsåret*
- Avdraget får inte överstiga avsättning till pensionsförsäkring eller IPS

### Särskild löneskatt 24,26% på avdraget

På det avdragna beloppet betalas SLP 24,26% (för pensionsförmåner är detta intäkten för Pensionsmyndigheten).

### NE-rad

- R38 = Avdrag för egna pensionspremier / inbetalning på pensionssparkonto (endast aktiv NV; förs även till INK1 p.10.6 som underlag för särskild löneskatt)
- R39 = Avdrag för särskild löneskatt (24,26 %) på pensionssparavdraget i R38
- R47/R48 = slutligt överskott/underskott (→ INK1 p.10.1-10.4)

### Pensionssparavdrag: breakeven-exempel

Setup: aktiv EF, underlag (efter RF, P-fond, expansionsfond) ~834 000 kr, redan över PGI-taket.

| Variabel | Utan pensionssparavdrag | Med 35 % avdrag |
|---|---|---|
| NV-beskattad inkomst | 834 000 | 834 000 − 292 000 = 542 000 |
| Skatt + egenavgifter NV-delen | ~364 000 | ~169 000 |
| Särskild löneskatt 24,26 % × 292 000 | 0 | ~70 800 |
| **Total skattekostnad** | **~364 000** | **~239 800 + sparade pengar** |

Effekt: ~33 % sänkning av skatt+egenavgifter på året, mot priset att 292 000 kr binds i pensionssparande (utbetalas vid pension, beskattas som tjänsteinkomst då). PGI påverkas inte om man redan slår i taket. Lönar sig sällan p.g.a. fondavgifter: se varning nedan.

### Caveat: pensionssparavdrag lönar sig sällan

Pensionsförsäkringar bär två avgiftsskikt: avgifter i de underliggande fonderna och en förvaltningsavgift för själva försäkringen (oftast kapitalbaserad). Vid låga avkastningsmiljöer kan avgifterna äta upp eller överstiga avkastningen, vilket gör nettotillväxten negativ.

Recommendation: pensionssparavdrag is en sista utväg om man **inte** har annat sätt att spara med samma skattefördelar.

### Ingen pensionssparavdrag i passiv NV

Bara aktiv NV ger pensionssparavdrag. En annan anledning att klassificera sig som aktiv.

### Sparat avdrag

If avdragsutrymmet (35%) inte används till fullo i ett år, resterande del **kan sparas till nästa år** (engångseffekt: kan bara sparas ett år, sedan förloras).

### Köpa ikapp vid nedläggning

Vid nedläggning av verksamheten kan Skatteverket medge **högre pensionssparavdrag** ("köpa ikapp pension") om man inte haft betryggande pensionsskydd. Dispens krävs. Max: 10 PBB × antalet år driftsamhället bedrivits (högst 10 år).

See also [[periodiseringsfond-expansionsfond-ef]] (interaction with underlag för pensionssparavdrag), [[egenavgifter-sgi-pgi-jsa]] (SLP 24,26%: kostnaden of pensionssparavdrag), and [[ef-vs-ab-breakeven]] (pension as a planning alternative).
