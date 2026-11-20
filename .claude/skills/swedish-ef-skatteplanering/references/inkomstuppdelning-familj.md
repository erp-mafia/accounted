# Inkomstuppdelning i Familjen

<!-- toc -->
**Contents**

- [Legal basis](#legal-basis)
- [Purpose](#purpose)
- [Two metoder: Medhjälparfallet vs Gemensam verksamhet](#two-metoder-medhjälparfallet-vs-gemensam-verksamhet)
- [Aktiv eller passiv för medhjälpande make](#aktiv-eller-passiv-för-medhjälpande-make)
- [Lön till barn](#lön-till-barn)
- [7-årsregel (närstående)](#7-årsregel-närstående)
- [Andra än barn och makar](#andra-än-barn-och-makar)
- [Räntefördelning + makar (key planning lever)](#räntefördelning--makar-key-planning-lever)
- [Pension and SGI through inkomstfördelning](#pension-and-sgi-through-inkomstfördelning)
- [Pitfalls](#pitfalls)
- [Implementation checklist for software](#implementation-checklist-for-software)

<!-- /toc -->

## Legal basis

- IL 60 kap (Inkomstuppdelning mellan makar och barn): full chapter
- IL 60 kap 2 §: lön till barn
- IL 60 kap 6 §: F-skattegodkännande för medhjälpande make

## Purpose

In familjeföretag, det skattemässiga resultatet kan ofta delas mellan makar (eller mellan föräldrar och barn over 16 år). When properly motivated, this:
- Reduces total skatt by moving inkomst from a high-skattesats person to a low-skattesats person
- Builds **pensions- och sjukpenninggrundande inkomst** in the recipient
- Crosses **brytpunkten för statlig skatt** to keep both makar under den

The reglerna omfattar make/maka samt sambo med gemensamma barn (jämställd med make), och egna barn under och över 16 år (inkl. styvbarn och fosterbarn).

## Two metoder: Medhjälparfallet vs Gemensam verksamhet

### Medhjälparfallet (uneven roles)

One make has a **ledande ställning** (företagsledande, with relevant utbildning/arbetsuppgifter), the other is medhjälpare.

Test for ledande ställning:
- Utbildning relevant för verksamheten?
- Arbetsuppgifter som kräver expertkompetens?
- Endast den ene har sådan kompetens → denne är företagsledare

Räkneexempel: läkare driver praktik på deltid, andra maken sköter bokföring/administration.
- Andra maken är **medhjälpande** (saknar läkarexamen → ingen ledande roll i kärnverksamheten)
- Om andra maken själv utbildar sig till psykoterapeut → vägledande arbete inom kärnverksamheten → kan klassas som **gemensam verksamhet**

#### Rules for medhjälparfallet

The medhjälpande make may declare an inkomst from the verksamheten, **maximerat to marknadsmässig ersättning**:
- 90 kr/timme + egenavgifter (= ca 118 kr/timme inkl egenavgifter) kan utan motivering anses marknadsmässig
- Higher belopp kan motiveras med branscherfarenhet, utbildning eller kollektivavtal
- Förmåner som den medhjälpande maken har får rymmas inom marknadsmässig ersättning

Plus: medhjälpande maken may declare an **inkomst motsvarande rimlig ersättning på den kapitalinsats** som maken har gjort. Den rimliga ersättningen utgår från räntefördelningens kapitalunderlag: fr.o.m. inkomstår 2025 (prop. 2024/25:1) krävs inte längre att kapitalunderlaget överstiger 50 000 kr för att räntefördela. Räntefördelning får göras så snart kapitalunderlaget är positivt (≥ 0 kr).

**INTE allowed**: fördelning av underskott till medhjälpande maken. Medhjälpande maken kan endast få ersättning om verksamheten gått med överskott.

**INTE allowed**: F-skattegodkännande för medhjälpande maken (bara företagsledaren får detta).

#### Aktiv/passiv classification i medhjälparfallet

- Minst 500-600 arbetstimmar/år → medhjälpande maken's inkomst räknas som **aktiv** (gäller hela inkomsten, inkl räntan på kapital)
- Under 500-600 timmar UTAN ägande: man tittar på om inkomsten är marknadsmässig ersättning för arbetsinsatsen → om så, aktiv
- Under 500-600 timmar MED ägande: bedöms andelen av medhjälpande makens inkomst som hör till avkastning på kapital vs faktisk arbetsinsats
- Om medhjälpande makens inkomst består **uteslutande av kapitalavkastning** → passiv för hela inkomsten

### Gemensam verksamhet (equal roles)

If båda makarna kan anses ha **samma ställning** i verksamheten, det är gemensam verksamhet:
- Båda måste arbeta ungefär **lika mycket** (inte ledningskrav)
- Inte nödvändigtvis lika andel av ägandet, men gärna
- Typiskt: bondejordbruk, frisörsalong, butik där båda jobbar
- **Inget krav på att båda har företagsledande ställning**

#### Rules for gemensam verksamhet

- Resultatet fördelas **efter arbetsinsatsen** (kan dras före schablonavdrag för egenavgifter, räntefördelning, periodiseringsfond, expansionsfond, JSA: eftersom dessa är personliga poster)
- **Även underskott** får fördelas (i motsats till medhjälparfallet)
- F-skattegodkännande: **båda** makarna kan få detta i gemensam verksamhet
- Deklarationen: bara en av makarna behöver fylla i komplett NE-bilaga med alla siffror; andra maken fyller i grunduppgifter på NE + sista delen av NE-bilagan för sin andel
- Räntefördelning, P-fond, expansionsfond beräknas personligt för varje make (egen kapitalunderlag)

## Aktiv eller passiv för medhjälpande make

| Make-pair situation | Klassificering |
|---|---|
| Båda makar aktivt arbetande (gemensam verksamhet) | Båda aktiva |
| Båda makar mest medhjälpande/passiva | Båda passiva |
| Företagsledande make aktiv, medhjälpande inte | Företagsledande maken aktiv; medhjälpande bedöms separat |
| Medhjälpande maken jobbar ≥ 1/3 av heltid (500-600h) | Aktiv (smittar genom huvudsaklighetsregeln) |

Smittoeffekt: medhjälpande maken bedöms i regel på samma sätt som den företagsledande: om företagsledaren är aktiv blir medhjälparen i normalfallet också aktiv (och tvärtom).

## Lön till barn

### Barn under 16 år
- Ersättningar och förmåner till **egna barn under 16 år** beskattas helt och hållet hos den make som deklarerar den **högsta inkomsten** från NV
- Detta är en spärrregel: föräldrarna kan inte få en avdragsgill kostnad genom att betala barnet
- Om makarna har lika stor inkomst, beskattas hos den **äldsta maken**

### Barn som fyllt 16 år
- Barn som fyllt 16 år kan **avlönas** och själv beskattas för beloppet
- Övre gräns för marknadsmässig ersättning: **samma som för medhjälpande make** (90 kr/timme + egenavgifter)
- Den del som överstiger marknadsmässig lön är *inte avdragsgill* för företaget, och inte heller arbetsgivaravgifter på överskjutande
- Det finns **ingen övre åldersgräns**: gäller också vuxna barn
- Det spelar ingen roll om barnet bor hemma
- 16-årsdagen: arbetet ska *utföras efter* att barnet fyllt 16 år, men i praktiken utgår man från avlöningstillfället

### Skatteplanering med barn 16+

This is one of the largest single skattelättnader för en familjeföretagare med tonåringar.

### Decision-mall: anställa barn 16+

Setup: aktiv EF, näringsidkare under brytpunkten, NV-överskott ~800 000 kr. Barn ≥ 16 utan andra inkomster anställs marknadsmässigt (t.ex. 24 000 kr/år för webbjobb).

```
1. Lönekostnad_barn = Bruttolön + AG-avgift (31,42 % × bruttolön)
   Exempel: 24 000 + 7 540 = 31 540 kr/år
2. EF_överskott_nytt = EF_överskott_före − Lönekostnad_barn
3. Skatt_EF_efter = NV-marginalskatt × EF_överskott_nytt
4. Skatt_barn = max(0, lön − grundavdrag) × kommunalskatt
   Barn under grundavdraget: ~0 kr skatt → ren skatteförflyttning
5. Familjebesparing = (Skatt_EF_före) − (Skatt_EF_efter + Skatt_barn)
```

Illustrativ effekt: vid 800 000 kr EF-överskott och 24 000 kr lön till barn (under grundavdraget) → familjebesparing ~10 000 kr/år. Plus barnet bygger PGI livet ut.

Krav: barnet ≥ 16 år **vid avlöningstillfället**, faktiskt arbete utfört, marknadsmässig timlön (90 kr/tim + AG-avgift ofta godtagbart). Lön till barn under 16 är **inte avdragsgill** för EF.

Planeringstips: höj barnets lön så att den hamnar precis över **deklarationsgränsen 0,423 × PBB** (=24 870 kr 2025 / 25 042 kr 2026) → utlöser pensionsrätt från första kronan. Varje krona över gränsen kostar 7 % allmän pensionsavgift för barnet, men ger flera hundra kronor mer i pension varje år livet ut.

### Tröskeleffekt: skattefri inkomst vs PGI

Att hålla barnets lön precis *under* deklarationsgränsen ger skattefri inkomst men **ingen PGI**. Optimalt: precis *över* gränsen → liten direktkostnad mot stor pensionsvinst.

### Krav: faktiskt arbete

För att avdraget ska godkännas måste barnet **verkligen ha utfört arbete** för företaget. Om det är ett fingerat avdrag (lön utan arbete) underkänns av Skatteverket och kan ge skattetillägg.

## 7-årsregel (närstående)

Vid övertagande av verksamhet från **närstående** within **5 år innan** företagsstarten:
- The 5-årsregeln för kvittning av underskott i nystartad verksamhet gäller **endast om den närstående skulle ha fått kvitta** om han eller hon själv hade fortsatt att driva verksamheten
- Övertagande från **förälder** eller **far-/morförälder** genom helt och hållet **köp** (inte gåva, arv eller testamente) räknas som **nystartad** verksamhet → 5-årsregeln gäller normalt

Practical impact: arbeta som anställd hos en närstående i 5 år, ta över verksamheten genom köp → kvittningsregeln gäller på 5 nya år.

## Andra än barn och makar

### Enkelt bolag (konsortium)

Flera enskilda näringsidkare kan samarbeta i ett **enkelt bolag**. Varje delägare deklarerar sin egen andel av intäkter och kostnader. Det enkla bolaget är inte ett skattesubjekt.

Common between syskon som ägar lantbruk/näringsfastighet gemensamt, eller sambor (utan gemensamma barn) som driver verksamhet tillsammans (sambor utan gemensamma barn räknas **inte** som makar för skatteändamål → andra fördelningsregler).

### F-skattegodkännande i enkelt bolag

I gemensam verksamhet kan båda makarna anses som företagsledare och därmed kan **båda få godkännande för F-skatt**. Detta är en stor administrativ fördel jämfört med medhjälparfallet (där bara företagsledaren får F-skatt).

## Räntefördelning + makar (key planning lever)

In gemensam EF där makar tillsammans äger tillgångar och har skulder:
- Each make computes kapitalunderlag på *sin andel* av tillgångar och skulder
- Genom att fördela ägande av tillgångar och skulder kan storleken av räntefördelningsbeloppet styras

> **Notera (2025-reform):** Äldre källor talar om att nå "+50 001 räntefördelningsgräns": den gränsen är **slopad fr.o.m. inkomstår 2025**. Numera går det att räntefördela från första positiva kronan, men storleken på kapitalunderlaget bestämmer fördelningsbeloppet (kapitalunderlag × SLR+6%). Större kapitalunderlag = större belopp som flyttas från NV till kapital (30 % skatt).

Worked example (2025-regler):
- Maskin för 15 000 kr behöver köpas
- Default: båda äger 50/50 → kvinnans kapitalunderlag 40 000 + 7 500 = 47 500 kr → räntefördelningsbelopp 2025 = 47 500 × 7,96 % = 3 781 kr
- Alt: låter kvinnan **köpa hela maskinen**: kvinnans kapitalunderlag 40 000 + 15 000 = 55 000 kr → räntefördelningsbelopp 2025 = 55 000 × 7,96 % = 4 378 kr
- Skillnaden 597 kr × marginalskatte-besparing ≈ 100-200 kr/år för medel-EF; större värde vid större kapitalunderlag

Such omflyttning ska göras civilrättsligt (faktiskt): det räcker inte med en skriftlig fördelningsfiktion.

## Pension and SGI through inkomstfördelning

Inkomstfördelning between makar påverkar:
- **Pensionsgrundande inkomst (PGI)**: 7,5 inkomstbasbelopp tak: om en make är över taket lägs överskottet i hennes inkomstslag onödigt; flytta över till den make som är under taket
- **Sjukpenninggrundande inkomst (SGI)**: **10 prisbasbelopp** tak (höjt från 7,5 PBB 2018; samma tak som föräldrapenning): same logic
- **Föräldrapenninggrundande inkomst**: 10 prisbasbelopp tak

Tips:
- **Make i karriär** (höginkomst, redan över taket): låt henne ta minimal andel av NV-inkomsten
- **Make som ligger lågt** (deltidsanställd eller hemmamake): låt henne ta så stor andel att hon når lägsta inkomstgränsen för PGI (0,423 PBB ≈ 24 870 kr) → får pensionsrätt från första kronan

## Pitfalls

1. **Felaktig medhjälpar-/gemensam-klassificering**: Skatteverket kan omklassificera vid revision, vilket kan upphäva tidigare fördelningar
2. **Underskott fördelat i medhjälparfallet**: INTE tillåtet; måste vara gemensam verksamhet
3. **Lön till barn under 16 år**: INTE avdragsgillt; beskattas hos högsta make
4. **Glömma marknadsmässig gräns för medhjälpande make / barn 16+**: överskridande ej avdragsgillt
5. **Sambor utan gemensamma barn**: räknas EJ som makar; andra fördelningsregler (enkelt bolag)
6. **F-skattegodkännande för medhjälpande make**: INTE tillåtet; bara företagsledare
7. **Förmånsbeskattning av medhjälpande makens förmåner**: måste rymmas inom marknadsmässig ersättning
8. **Stoppregel medhjälpande maken passiv när företagsledare aktiv**: ovanligt: brukar leda till samma klassificering. Software borde varna när detta upptäcks.

## Implementation checklist for software

If you build software for familjeägda EF:
- [ ] Track *vilka makar* and *vilka barn* (med personnummer för F-skattekontroll)
- [ ] Classify the arrangement: medhjälpar vs gemensam (UI question, persistera)
- [ ] Validate that underskott not allocated to medhjälpande make
- [ ] Enforce marknadsmässig ersättning cap (90 kr/h + egenavgifter) for medhjälpande make / barn
- [ ] Track arbetstimmar per make per year (for aktiv/passiv)
- [ ] Compute kapitalunderlag separately för each make (gemensam verksamhet)
- [ ] Generate NE-bilaga primary + supplement layout
- [ ] Flag the 16-årsdagen för barn som ska avlönas
- [ ] Warn at the deklarationsgränsen 0,423 × PBB (≈ 24 870 kr 2025 / 25 042 kr 2026) för barn (pension implications)

See also [[aktiv-passiv-naringsverksamhet]], [[rantefordelning-planning]] (makar-fördelning av tillgångar), [[kvittning-underskott]] (närstående-takeover regel), and [[ackumulerad-inkomst]] (kan båda makar dra ackumulerad inkomst from gemensam verksamhet).
