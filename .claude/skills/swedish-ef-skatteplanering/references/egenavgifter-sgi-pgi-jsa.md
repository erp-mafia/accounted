# Egenavgifter, SGI, PGI, Jobbskatteavdrag: Interaction Effects

<!-- toc -->
**Contents**

- [Legal basis](#legal-basis)
- [Egenavgifter: base rates](#egenavgifter-base-rates)
- [Generell nedsättning av egenavgifter: 7,5 %](#generell-nedsättning-av-egenavgifter--75)
- [Schablonavdrag för egenavgifter på NE-bilaga](#schablonavdrag-för-egenavgifter-på-ne-bilaga)
- [Underlag för aktivitets-/sjukpenning (SGI)](#underlag-för-aktivitets-sjukpenning-sgi)
- [Underlag för pensionsgrundande inkomst (PGI)](#underlag-för-pensionsgrundande-inkomst-pgi)
- [Jobbskatteavdrag (JSA): skattereduktion för aktiva NV](#jobbskatteavdrag-jsa-skattereduktion-för-aktiva-nv)
- [Interaktionsmatris: påverkan på underlag](#interaktionsmatris-påverkan-på-underlag)
- [Egenavgifter-effekt för aktiv vs passiv vs pensionär](#egenavgifter-effekt-för-aktiv-vs-passiv-vs-pensionär)
- [Underlag för nedre och övre PGI-gräns](#underlag-för-nedre-och-övre-pgi-gräns)
- [Pitfalls](#pitfalls)
- [Implementation checklist](#implementation-checklist)

<!-- /toc -->

## Legal basis

- Socialavgiftslagen (SAL) 2000:980: egenavgifter
- Lagen (1990:659) om särskild löneskatt på vissa förvärvsinkomster
- IL 67 kap 5-9 §§: jobbskatteavdrag (skattereduktion)
- SFB (Socialförsäkringsbalken) 2010:110: SGI, sjukpenning, föräldrapenning
- IL 59 kap: pensionssparavdrag

This reference covers the **interaction effects** between social charges, SGI, PGI, JSA and de skatteplanerings-instrument (P-fond, expansionsfond, räntefördelning, avskrivningar) som påverkar dessa underlag.

## Egenavgifter: base rates

### Pensionärsåldersgränsen: höjs successivt

Pensionärsstatus (10,21 % ålderspensionsavgift istället för full egenavgift) inträder året **efter** ett visst åldersfyllande. Gränsen följer den höjda pensionsåldersreformen:

| Inkomstår | Full egenavgift t.o.m. året då man fyller | Pensionärsavgift fr.o.m. året då man fyller |
|---|---|---|
| 2022 och tidigare | 65 år | 66 år |
| 2023 | 66 år | 67 år (höjning av riktåldern) |
| 2025 | **66 år** | 67 år |
| 2026 | **67 år** (höjning från 1 jan 2026) | 68 år |

Äldre källor anger ofta 65 år som gräns: det är inaktuellt sedan riktåldern höjdes 2023, och vidare 2026. Verifiera mot Skatteverkets Belopp och procent för aktuellt år.

### Standard rates (2025 och 2026, oförändrade procentsatser)

| Group | Rate |
|---|---|
| Active näringsidkare, **7 karensdagar** (standard) | **28,97 %** |
| Active, 1 karensdag | ~29,2 % (slightly higher) |
| Active, 14 karensdagar | ~28,8 % |
| Active, 30 karensdagar | ~28,4 % |
| Active, 60 karensdagar | ~27,9 % |
| Active, 90 karensdagar | ~27,4 % |
| Passive näringsidkare (SLP) | **24,26 %** |
| Pensionär (året efter åldersgränsen, eller hel pension hela året) | **10,21 %** (bara ålderspensionsavgift) |
| Född 1937 eller tidigare | **0 %** |
| Pensionär som är passiv | **24,26 %** (SLP, ingen nedsättning till 10,21 %) |

### Karensval

- Default: 7 karensdagar
- Val of 1, 14, 30, 60 eller 90 karensdagar görs hos Försäkringskassan på blankett
- Anmälan inom uppsägningstid: ny karens börjar gälla efter motsvarande antal dagar efter anmälan
- Inte tillåtet att byta till kortare karens om man redan är inne i en sjukperiod
- Försäkran krävs att inte ha någon pågående sjukdom (eller upplysa om den)
- Karensvalet ändras hos Försäkringskassan, inte Skatteverket

### Ingen nedsättning för pensionärer eller +65

Pensionärer (som redan betalar 10,21%) får **ingen** generell nedsättning. Likewise +62-åringar som tagit ut hel allmän pension hela året.

### Regional nedsättning (stödområde A: Norrlands inland)

10% extra nedsättning av avgiftsunderlaget upp till 180 000 kr → max 18 000 kr/year.

Stödområdet = mest Norrlands inland. Lista finns hos Tillväxtverket.

### Hel sjuk- eller aktivitetsersättning

Helt eller delvis under året: bara ålderspensionsavgift (10,21%) på överskott av aktiv NV.

## Generell nedsättning av egenavgifter: 7,5 %

Skatteverket benämner detta "generell nedsättning":

- **7,5 procentenheter** nedsättning av egenavgifter
- Cap: max **15 000 kr/år** (= 7,5% av 200 000 kr underlag)
- Underlag = överskott av **aktiv** NV (efter schablonavdrag för egenavgifter; exklusive sjukpenning)
- Krav: överskottet **överstiger 40 000 kr** (= ca 50 000-52 000 kr i överskott före schablonavdrag)
- Beräknas automatiskt av Skatteverket: du ska INTE begära den i deklarationen
- Bara aktiva näringsidkare: ej för pensionärer (redan 10,21%) eller passiva (SLP utan nedsättning)

### Nedsättningens beräkning: KORREKT formel (Skatteverket)

Nedsättningen beräknas som **7,5 % av hela avgiftsunderlaget**, dock max 15 000 kr/år. Förutsättning: full egenavgift betalas (28,97 %), aktiv NV och **överskottet överstiger 40 000 kr**.

```
nedsättning = min(0,075 × underlag, 15 000)   när underlag > 40 000
nedsättning = 0                                 när underlag ≤ 40 000
```

**Inget 40 000-belopp dras av från underlaget**: hela underlaget multipliceras med 7,5 %. Den formulering man ofta ser, `7,5 % × (överskott − 40 000)`, är felaktig, 40 000-gränsen är en *tröskel* för att nedsättningen ska utgå, inte ett avdragsbelopp.

Exempel:
- Underlag 100 000 kr → nedsättning = 0,075 × 100 000 = **7 500 kr**
- Underlag 200 000 kr → nedsättning = 0,075 × 200 000 = **15 000 kr** (taket)
- Underlag 300 000 kr → fortfarande max 15 000 kr (full nedsättning på de första 200 000, ingen marginalfördel över)

### Tröskeleffekt vid 40 000 kr

Regeln ger en **omvänd marginalskatt** vid tröskeln. Underlag på 40 000 kr ger 0 i nedsättning; underlag på 40 001 kr ger nedsättning på hela underlaget (≈ 3 000 kr). En obetydlig höjning utlöser alltså en betydande skattesänkning.

Software bör flagga överskott precis under 40 000 kr: en krona över triggar nedsättningen.

### Maxbelopp 200 000 kr (15 000 kr in nedsättning)

Vid underlag 200 000 kr nås maxavdraget 15 000 kr. Über 200 000 är det ingen marginalfördel.

## Schablonavdrag för egenavgifter på NE-bilaga

- **R43**: avdrag för beräknade egenavgifter
- **Max 25%** av överskott före schablonavdrag (aktiv standard)
- **20%** för passiv (SLP)
- **10%** för pensionärer
- Tipsbart minska avdraget om man vill ha högre pensionsgrundande/sjukpenninggrundande inkomst
- Sista året före nedläggning: gör **exakt** schablonavdragsberäkning baklänges från beräknad faktisk egenavgift för att slippa en avstämningspost året därpå

### Avstämning nästa år

Beräknat schablonavdrag stämmer aldrig exakt med faktiska egenavgifter. Differensen rättas till i nästa års deklaration:
- **R40** = föregående års medgivna schablonavdrag (fjolårets R43, läggs tillbaka som intäkt)
- **R41** = påförda egenavgifter / SLP enligt slutskattebeskedet (dras av)

Net effect: schablonavdraget är ett genuint avdrag för året, men korrigeras nästa år mot verkligheten.

### "Höja inkomsten" via lägre schablonavdrag

Skäl att höja deklarerad inkomst genom att sänka schablonavdraget:
- Utnyttja ROT/RUT-avdrag (kräver tillräckligt med skatt att reducera)
- Höja PGI för pensionsrätt
- Höja SGI (Försäkringskassan justerar inte bort schablonavdrag: det är inte en disposition)

Skatteverket kan vägra schablonavdragsändringar som verkar bedrägeriska. Om det avsatta beloppet skiljer sig så markant att det kan antas att näringsidkaren försökt uppnå en obehörig förmån, kan avdraget rättas.

But: rimliga adjustments medges. Bara om man yrkar **noll** schablonavdrag eller mycket litet bör SKV granska.

## Underlag för aktivitets-/sjukpenning (SGI)

### Calculation

SGI is computed by **Försäkringskassan** based on årsinkomst av arbete. För enskilda näringsidkare baseras SGI på:
- Beräknad inkomst av aktiv NV
- Bortser från **skattemässiga dispositioner**: avsättning/återföring av P-fond, expansionsfond
- Bortser också från insättning/uttag på skogskonto, upphovsmannakonto
- **Räntefördelning räknas** (men positiv minskar SGI eftersom NV-inkomsten minskar)
- **Avskrivningar räknas** (höjda avskrivningar minskar SGI)
- **Schablonavdrag för egenavgifter räknas** (men FK justerar: om du minskar schablonavdraget, FK ökar tillbaka motsvarande)

### Tak och nedre gräns

| Threshold | 2025 | 2026 |
|---|---|---|
| Prisbasbelopp (PBB) | 58 800 kr | 59 200 kr |
| Förhöjt PBB | 60 000 kr | 60 500 kr |
| Inkomstbasbelopp (IBB) | 80 600 kr | 83 400 kr |
| Lägsta SGI (0,24 PBB) | 14 112 kr | 14 208 kr |
| Lägsta för pensionsintjänande PGI (0,423 PBB) | 24 870 kr | 25 042 kr |
| Max SGI (10 PBB) | 588 000 kr | 592 000 kr |
| Max PGI (7,5 IBB) | 604 500 kr | 625 500 kr |
| Avgiftstak (8,07 × IBB, pensionsgrundande tak) | 650 442 kr | 673 038 kr |
| Max föräldrapenninggrundande (10 PBB) | 588 000 kr | 592 000 kr |
| Max för 7,5 %-nedsättning egenavgifter (200k underlag) | 200 000 kr | 200 000 kr |
| Halva PBB (förbrukningsinventarier-gräns) | 29 400 kr | 29 600 kr |

Sjukpenning = 77,6% (80% × 0,97) av SGI. Föräldrapenning likewise.

### "Framåtriktad" SGI bedömning

Försäkringskassan bedömer SGI **framåt** (vad antar de att näringsidkaren kommer tjäna nästa år), inte bakåt. Vid sjukdom:
- För nystartade EF (inom första 24-36 månaderna, "uppbyggnadsskedet") jämförs med en motsvarande anställd inkomst
- För etablerade EF: senaste års redovisade NV-inkomst används som proxy

### Höjda SGI-strategies (om man har en känd kommande sjukdomsperiod / föräldraledighet)

Saker som höjer SGI (men kostar i annan riktning):
- Avstå från positiv räntefördelning → höjer NV-inkomsten
- Avstå från eller minska avskrivningar på inventarier (de återkommer senare som mindre avskrivningar)
- Mindre schablonavdrag för egenavgifter (FK skulle ofta justera, men inte alltid)
- Negativ räntefördelning räknas full mot SGI (höjer den)

OBS: P-fond avsättning/återföring påverkar INTE SGI (Försäkringskassan bortser).

## Underlag för pensionsgrundande inkomst (PGI)

### Differences from SGI

PGI **påverkas** av:
- Avsättning/återföring P-fond
- Avsättning/återföring expansionsfond
- Insättning/uttag skogskonto, upphovsmannakonto
- Räntefördelning (positiv minskar, negativ höjer)
- Avskrivningar
- Schablonavdrag egenavgifter

Praktisk skillnad: P-fond kan användas för PGI-utjämning (jämna ut PGI över åren), men INTE för SGI-utjämning.

### Tak

- Max: 7,5 inkomstbasbelopp ≈ **604 500 kr 2025**, **625 500 kr 2026**
- Belopp över taket → ingen extra pension, men full egenavgift för aktiv NV. Den delen av socialavgifterna fungerar som ren skatt och förs inte till pensionssystemet utan till statsbudgeten.

### Lägsta gräns

- 0,423 PBB ≈ 24 870 kr 2025
- Om du når denna gränsen → full PGI från första kronan
- Pension built varje krona under taket → strävan att alltid komma över 24 870 kr

### Pensionärer (≥ 65 år)

- Pensionärer betalar 10,21% egenavgifter på aktiv NV, but **får ändå full pensionsintjäning** (= the 10,21% is dedicated to ålderspensionsavgift, hela summan går till pension)
- Hela livet räknas → man kan fortfarande bygga pensionspoäng efter pension
- → starkt argument att fortsätta jobba aktivt efter 65

## Jobbskatteavdrag (JSA): skattereduktion för aktiva NV

### Det är en skattereduktion, inte ett avdrag

JSA är inte ett avdrag du gör i din deklaration. Det är en **skattereduktion** som beräknas automatiskt av Skatteverket → minskar din skatt.

Underlag × kommunalskattesats = skattereduktion (jobbskatteavdrag).

### Endast på inkomst av aktiv NV

This is one of the largest specific incentives för aktiv-classification:

- Pension, föräldrapenning, sjukpenning, a-kassa, sjuk-/aktivitetsersättning, livskaderänta → **ger inte rätt till JSA**
- Anställningsinkomster → JA
- Aktiv NV inkomst → JA
- Passiv NV inkomst → NEJ

### Beräkning (för personer under 65 år)

| Inkomstskikt (arbetsinkomst) | Underlag (× kommunalskattesats) |
|---|---|
| ≤ 0,91 PBB | Arbetsinkomsten minus grundavdrag |
| 0,91-3,24 PBB | 0,91 PBB + 34,05% av arbetsinkomst i detta skikt, minus grundavdrag |
| 3,24-8,08 PBB | 1,703 PBB + 12,8% av arbetsinkomst i detta skikt, minus grundavdrag |
| 8,08-13,54 PBB | 2,323 PBB minus grundavdrag |
| > 13,54 PBB | 2,323 PBB minus grundavdrag, sedan reduceras med 3% av arbetsinkomster över 13,54 PBB |

### 2025/2026 förstärkningar: JSA har höjts varje budget sedan 2022

Äldre tabeller (≤ 2021) är inaktuella; JSA har förstärkts vid varje budgetproposition 2022-2026.

- **Inkomstår 2025**: max ~47 300 kr/år (≈ 3 941 kr/månad) för personer under pensionsåldersgränsen (66 år 2025).
- **Inkomstår 2026** (prop. 2025/26:32 "Sänkt skatt på arbetsinkomster, pension och sjuk- och aktivitetsersättning"): max ~52 400 kr/år (≈ 4 366 kr/månad) för låg-/medelinkomsttagare med arbetsinkomst mellan ~191 800 och 478 300 kr/år (3,24-8,08 PBB).
- Marginalskattesänkning för pensionärer höjs också 2026.

Använd alltid Skatteverkets aktuella jobbskatteavdragsräknare i implementationen: beloppen är dynamiska.

### Förhöjt JSA för pensionärer (åldersgräns)

Personer som vid beskattningsårets ingång har fyllt **66 år** (gäller 2025 och 2026, IL 67 kap 8 §) får utökat JSA. En höjning av åldersgränsen till 67 år fr.o.m. 2027 är bara föreslagen (promemoria "Höjd åldersgräns och förstärkning av jobbskatteavdraget för seniorer", maj 2026), inte beslutad. Strukturen nedan beskriver kalkylgrunden: exakta belopp justeras varje budget och bör hämtas från Skatteverket vid implementation:

- 20 % av arbetsinkomsten upp till 100 000 kr (= max ~20 000 kr extra)
- 5 % av arbetsinkomster mellan 100 000-300 000 kr (= max ~10 000 kr extra)
- 30 000 kr på arbetsinkomster mellan 300 000-600 000 kr (= max ~30 000 kr extra)
- 30 000 kr på arbetsinkomster > 600 000 kr, minus 3 % av arbetsinkomster över 600 000 kr

Pensionärer som är aktiva i NV får ett **avsevärt större** JSA än under-pensionsåldersgränsen-personer, but only on aktiv arbetsinkomst (inte pensionen själv). IL 67 kap 8 § ändrades inte för 2026 (senaste lydelse SFS 2024:1131); 2026 års förstärkning gällde JSA enligt 7 § (under 66 år).

### Arbetsinkomster: definition

Arbetsinkomster = anställningsinkomster minskade med kostnader för inkomsterna i tjänst, samt allmänna avdrag (t.ex. pensionssparande), samt inkomst av **aktiv NV**.

Inte räknas: pension, sjukpenning, föräldrapenning (även om dessa baseras på din aktiva NV).

### Interaktion med allmänt avdrag (kvittning av underskott)

Allmänt avdrag (kvittning av nystartad NV-underskott mot tjänst) **minskar** underlag för JSA. Net effekt:
- Kvittning sparar marginalskatt + statlig skatt (~32-52%)
- Men minskar JSA-reduktion → marginell motverkning

This is why **rullning ofta är bättre än kvittning**: rullning minskar både egenavgifter och inkomstskatt på framtida intäkt, utan att äta JSA.

## Interaktionsmatris: påverkan på underlag

Quick reference för software:

| Disposition | NV-inkomst | SGI | PGI | JSA-underlag | Egenavgifter | Egenavgifter-nedsättning |
|---|---|---|---|---|---|---|
| Positiv räntefördelning | Sänker | Sänker | Sänker | Sänker | Sänker | Underlag minskar → nedsättning minskar |
| Negativ räntefördelning | Höjer | Höjer | Höjer | Höjer | Höjer | Underlag ökar |
| P-fond avsättning | Sänker | INGEN (FK bortser) | Sänker | Sänker | Sänker | Underlag minskar |
| P-fond återföring | Höjer | INGEN | Höjer | Höjer | Höjer | Underlag ökar |
| Expansionsfond avsättning | Sänker | INGEN | Sänker | Sänker | Sänker (men 20,6% expansionsfondsskatt) | Underlag minskar |
| Expansionsfond återföring | Höjer | INGEN | Höjer | Höjer | Höjer | Underlag ökar |
| Avskrivningar (höjda) | Sänker | Sänker | Sänker | Sänker | Sänker | Underlag minskar |
| Schablonavdrag (mindre) | Höjer | INGEN (FK adjusts back) | Höjer | Höjer | Höjer | Underlag ökar |
| Pensionssparavdrag | Sänker | INGEN | Sänker | Sänker | Inget effekt direkt | Underlag minskar |
| Allmänt avdrag (kvittning) | (utanför NV) | INGEN (FK adjusts) | Sänker (allmänna avdrag) | Sänker | INGEN (tjänsteinkomst) | INGEN |

## Egenavgifter-effekt för aktiv vs passiv vs pensionär

Comparing effective social charges:

| Group | Direkt avgift | Generell nedsättning | Schablonavdrag | Effektiv avgift |
|---|---|---|---|---|
| Active, underlag 200 000 kr | 28,97% | -7,5% (max 15 000 kr) | 25% | ~21,5% effektivt |
| Active, underlag 100 000 kr | 28,97% | -7,5% (15k cap progressive) | 25% | ~24,5% |
| Passive, any underlag | 24,26% | 0% | 20% | ~24,26% |
| Pensionär, aktiv | 10,21% | 0% | 10% | ~10,21% |
| Pensionär, passiv | 24,26% | 0% | 20% | ~24,26% |

Insight: A passive näringsidkare and an active näringsidkare may end up at similar effective rates (~24% each) due to nedsättning-effekten. But aktiv har **JSA on top** (~6-10% reduktion of marginalskatt at 200k income) → aktiv vinner generellt med 15-17 000 kr/år.

## Underlag för nedre och övre PGI-gräns

### Lägsta inkomstgräns (PBB-baserad)

- 0,423 PBB = ca 24 870 kr 2025
- Om du når detta → full PGI **från första kronan**
- Strategy: ALWAYS get up to denna gränsen, even genom att lägre schablonavdrag for egenavgifter

### Skattefri inkomst (för barn)

- 0,423 PBB = ca **24 870 kr (2025) / 25 042 kr (2026)** = samma som lägsta PGI-gräns
- Inkomst under denna gräns behöver inte deklareras (med vissa undantag) och är skattefri
- Frestelse: hålla barnets lön precis under → helt skattefri inkomst
- **Bättre planeringsval**: gå precis över. Barnet får då full pensionsintjäning för året (kostar 7 % allmän pensionsavgift, men ger pension hela livet)

## Pitfalls

1. **Pensionärer som räntefördelar**: vanligen sämre netto-utfall. Pensionärsavgift (10,21 %) är redan lägre än räntefördelningens kapitalskatt (30 %), så ompostering till kapital blir oftast en förlust.
2. **Förvirring av nedsättningar**: generell (7,5%, max 15k) ≠ regional (10%, max 18k) ≠ pensionär-rate (10,21% i stället för 28,97%)
3. **P-fond för SGI-höjning**: fungerar INTE; Försäkringskassan bortser från P-fond
4. **P-fond för PGI-höjning vid utbetalningsåret**: DOES work; FK does not adjust for P-fond when computing PGI
5. **JSA-effekt av allmänt avdrag glömd**: kvittning sparar inkomstskatt men äter JSA → net effekt mindre än förväntat
6. **Schablonavdrag för pensionärer**: bara 10% (inte 25%)
7. **Schablonavdrag för SLP/passiv**: 20% (inte 25%)
8. **Glömma att F-skatten redan inkluderar uppskattad egenavgift**: checkA-konto blir negativt om man **också** drar schablonavdrag mentalt utan att förstå att SKV redan beaktar
9. **Tröskeleffekten vid 40 000 kr**: vinst 40 001 ger ~3 000 kr lägre skatt än 40 000 → uppmana till small overshoot om planeringsbart

## Implementation checklist

- [ ] Detect grupp: active under-65, active 65+, pensionär (tagit ut hel pension), passive
- [ ] Apply rätt egenavgift-rate (28,97/24,26/10,21/0%)
- [ ] Apply generell nedsättning 7,5% conditional on aktiv + > 40 000 underlag + cap 15 000 kr
- [ ] Apply regional nedsättning if i stödområde A
- [ ] Compute SGI based on aktiv NV-inkomst, ignoring P-fond/expansionsfond dispositions
- [ ] Compute PGI including all dispositions
- [ ] Compute JSA per skiktreglerna (under-65 vs 65+)
- [ ] Warn vid underlag < 40 001 kr (lose nedsättning) eller < 24 870 kr (lose PGI)
- [ ] Surface advice: "Höja inkomsten över 40 001 kr ger 3 000 kr lägre skatt; rekommendation: minska schablonavdrag eller P-fond avsättning"
- [ ] Track per-year underlag history för SGI bedömning av FK (uppbyggnadsskede inom första 36 mån)

See also [[aktiv-passiv-naringsverksamhet]] (the gateway to all of this), [[rantefordelning-planning]] (the most subtle interaction), [[periodiseringsfond-expansionsfond-ef]] (PGI-leveling tool), and [[ef-vs-ab-breakeven]] (interaction of these med AB-alternativet).
