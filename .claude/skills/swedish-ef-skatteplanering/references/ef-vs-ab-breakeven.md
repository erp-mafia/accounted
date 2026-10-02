# EF vs AB: Skattemässig Jämförelse och Brytpunkter

<!-- toc -->
**Contents**

- [Purpose](#purpose)
- [Den fundamentala olikheten](#den-fundamentala-olikheten)
- [Marginalskatt + total skatt: kvalitativ struktur](#marginalskatt--total-skatt-kvalitativ-struktur)
- ["Kvar efter skatt på 100 kr": kvalitativ jämförelse EF vs AB](#kvar-efter-skatt-på-100-kr-kvalitativ-jämförelse-ef-vs-ab)
- [När EF generellt är förmånligare än AB](#när-ef-generellt-är-förmånligare-än-ab)
- [När AB generellt är förmånligare](#när-ab-generellt-är-förmånligare)
- ["Både och"-strategy (parallell EF + AB)](#både-och-strategy-parallell-ef--ab)
- [Skiljd hantering vid sjukpenning](#skiljd-hantering-vid-sjukpenning)
- [Inlåning till AB: and parallel concept i EF](#inlåning-till-ab-and-parallel-concept-i-ef)
- [Uthyrning till AB](#uthyrning-till-ab)
- [Tantieme: inte tillgängligt i EF](#tantieme-inte-tillgängligt-i-ef)
- [Föräldraledighet och föräldrapenninggrundande inkomst](#föräldraledighet-och-föräldrapenninggrundande-inkomst)
- [Ombildning EF → AB: when to switch](#ombildning-ef--ab-when-to-switch)
- [Tabell: snabbjämförelse vid olika vinstnivåer](#tabell-snabbjämförelse-vid-olika-vinstnivåer)
- [Anställning vs EF + bisyssla](#anställning-vs-ef--bisyssla)
- [Pitfalls](#pitfalls)
- [Implementation checklist for software](#implementation-checklist-for-software)

<!-- /toc -->

## Purpose

This reference helps decide when an enskild näringsidkare should:
1. Stay as EF
2. Ombilda till AB
3. Run **both EF and AB parallellt** (the "både och" strategy)

The decision involves marginalskatt jämförelser, sociala avgifter, riskhantering, pension/SGI-byggande, och administrativ komplexitet.

For AB-specific skatteplanering (3:12-regler, periodiseringsfond AB, koncernbidrag), use `swedish-tax-planning` (sister skill).

## Den fundamentala olikheten

| Aspekt | EF | AB |
|---|---|---|
| Juridisk person | Nej (= du själv) | Ja |
| Skattesubjekt | Nej (personlig deklaration) | Ja (egen INK2) |
| Ansvar för skulder | Obegränsat personligt | Begränsat till aktiekapital (25k min) |
| Föreningssamhetsstruktur | En person (eller makar gemensamt) | 1+ ägare med skilda andelar |
| Inkomstskatt | Personlig progressiv (29-65% inkl egenavgifter) | Bolagsskatt 20,6% + ägarbeskattning |
| Socialavgift | Egenavgifter 28,97% (aktiv) / SLP 24,26% (passiv) | Arbetsgivaravgifter 31,42% på lön |
| Periodiseringsfond | 30%, ingen schablonintäkt, ej bokförd | 25%, schablonintäkt, ska bokföras |
| Expansionsfond | 20,6%, ger lågbeskattad retention | (Inte tillämpligt: använd retention) |
| Räntefördelning | Tillämpligt (IL 33 kap) | Inte tillämpligt |
| Inlåning till AB | (Ej tillämpligt) | Tillåtet, ränta 30% kapital |
| 3:12-regler | (Ej tillämpligt) | Tillämpligt vid kvalificerade andelar |
| Personligt ansvar | Du själv är firman | Knivskarp skiljelinje |
| Förbudet mot lån från företaget | Ej tillämpligt: du och firman är samma juridiska person, alla uttag är dina egna pengar | **Förbjudna lån** till aktieägare/närstående enligt ABL 21 kap (smitta hela bolaget, brott mot låneförbudet) |
| Revisor | Aldrig krav | Krav om 2 av: omsättning > 3 MSEK, 3 anställda, balansomslutning > 1,5 MSEK |
| Bokslut form | Förenklat årsbokslut (K1) om < 3 MSEK | Årsredovisning (K2/K3) alltid |
| Bolagsstämma | Inte tillämpligt | Krav även för enmans-AB |
| Sjukpenning | Direkt från Försäkringskassan dag 15+ | Bolaget måste betala sjuklön dag 1-14 |
| Tantieme | Inte möjligt | Möjligt: flyttar resultat mellan år |

## Marginalskatt + total skatt: kvalitativ struktur

Konkreta procentsatser per inkomstnivå varierar mellan inkomstår (JSA-förstärkningar, ändrade brytpunkter, kommunalskattevariationer). Bygg implementationen mot **Skatteverkets aktuella tabeller** + jobbskatteavdragsräknare för exakta värden: det följande är en kvalitativ guide.

### Icke-pensionärer (aktiv EF, 7 karensdagar, 28,97 % egenavgifter, kommun ~32 %)

```
total_skatt_andel(vinst) växer gradvis från ~24 % vid 100 000 kr → ~45 % vid 1 000 000 kr
marginalskatt(vinst):
  under skiktgränsen:                 ~32-46 % (lägst vid lägsta inkomster pga JSA)
  precis över skiktgränsen:           ~46 % + 20 % statlig = ~58-63 %
  i JSA-utfasningsintervallet (>13,54 PBB):  ~62-65 %  ← marginalskatten "hoppar"
```

**Praktisk tröskel**: marginalskatten gör ett tydligt hopp uppåt nära 800 000 kr (kombinerad effekt av statlig skattegräns + JSA-utfasning). Över ca 800 000 kr platsar marginalen ~62-65 %.

### Pensionärer (samma EF, men 10,21 % ålderspensionsavgift)

Markant lägre total skatt på samma vinstnivå: typiskt **8-12 procentenheter lägre total skatt** än icke-pensionärer i samma inkomstskikt. Detta är ett av de starkaste skälen att hålla EF i drift även efter pensionsåldersgränsen.

### Brytpunkter och skiktgräns (aktuella)

Se tabellen i [[egenavgifter-sgi-pgi-jsa]] för 2025/2026-värden:
- Skiktgräns 2025: 625 800 kr / 2026: 643 000 kr (beskattningsbar inkomst)
- Brytpunkt 2025: ~643 100 kr / 2026: ~660 400 kr (gross-inkomst före grundavdrag)
- Pensionärer: högre effektiv skiktgräns p.g.a. förhöjt grundavdrag

## "Kvar efter skatt på 100 kr": kvalitativ jämförelse EF vs AB

Alla värden ungefärliga, för icke-pensionär under brytpunkten:

| Inkomstmetod | Kvar efter skatt per 100 kr | Notering |
|---|---|---|
| EF-vinst under brytpunkten | **60-68 kr** | egenavgifter + kommunal, jobbskatteavdrag |
| EF + positiv räntefördelning (när tillämpligt) | ~70 kr | flyttar del till kapital (30 %) |
| AB-lön under brytpunkten | **53-58 kr** | arbetsgivaravgifter 31,42 % + kommunal + jobbskatteavdrag |
| AB-utdelning inom K10 gränsbelopp | ~62 kr | 20,6 % bolagsskatt + 20 % kapital |
| AB-utdelning över gränsbelopp (tjänstebeskattad) | ~50 kr | 20,6 % bolagsskatt + marginal-tjänst |

Pensionärer (10,21 % egenavgift): upp till ~75 kr kvar per 100 kr på låga-medel-inkomster, oavsett EF eller AB-lön. Födda 1937 eller tidigare (0 % avgift): närmare 80 kr kvar.

**Tolkning**:
- Under brytpunkten: EF vinner över AB-lön med ~7-10 kr per 100 kr (~10 % bättre netto)
- EF med utnyttjad positiv RF: jämförbart med AB:s K10-utdelning
- Över brytpunkten: AB med K10-utdelning vinner, eftersom statlig skatt 20 % slår igenom på EF-vinst men inte på kapitalbeskattad utdelning

## När EF generellt är förmånligare än AB

1. **Vinst under brytpunkten** (icke-pensionär)
2. **Pensionär** med aktiv NV (mycket lägre egenavgifter än AB:s arbetsgivaravgifter)
3. **Kombinerad förlustverksamhet och vinstverksamhet**: automatisk kvittning inom EF (se [[kvittning-underskott]] för räkneexempel)
4. **Kulturarbetarverksamhet**: fri kvittning av underskott mot tjänst, ingen 5-årsgräns
5. **Ny start**: kvittning mot tjänst första 5 åren (100k/år)
6. **62-64-åringar**: har specialgyl: hel allmän pension under hela året → lägre 10,21% egenavgifter även före 65

## När AB generellt är förmånligare

1. **Vinst över brytpunkten** (statlig skatt 20% extra slår igenom)
2. **Behov av att samla på sig sparat utdelningsutrymme (K10)**: för framtida säljbar verksamhet
3. **Behov av begränsat personligt ansvar** (kommersiella skäl)
4. **Flera ägare som inte är makar/sambor** (EF passar bara en person eller makar)
5. **Behov av extern finansiering**: bank/investerare ser hellre AB
6. **Behov av att kapitalisera ABFP, försäljning av aktier till externa**
7. **Inlåning av privata medel till verksamheten**: ABs kan göra inlåning, ge sig själv marknadsmässig ränta (~SLR+1) som beskattas i kapital (30%); EF har bara räntefördelning, vilket är mindre flexibelt

## "Både och"-strategy (parallell EF + AB)

I många fall är det bästa alternativet att driva både EF och AB parallellt: kombinationen ger fördelar som ingetdera ensamt erbjuder.

### Use cases

#### Hybridmodell 1: Bygga gränsbelopp innan AB tas i bruk fullt

- Start verksamheten i EF (utnyttja 5-årsregeln för kvittning, samla på dig kompetens)
- Start AB parallellt → börja samla på dig sparat utdelningsutrymme (K10 förenklingsregeln 2,75 IBB / 4 IBB)
- Om några år: ombilda hela verksamheten till AB med ackumulerat utdelningsutrymme i hand

#### Hybridmodell 2: Konsult i AB + hyresfastighet i EF

- AB driver konsultverksamheten (hög inkomst, K10 + lön kombo)
- EF driver hyresfastighet (passiv → SLP 24,26%, ingen JSA, eller om aktiv-status: full system)
- Inkomstkvittning mellan AB och EF är dock inte möjligt direkt: men:
  - AB:s utgifter och EF:s utgifter är separata; ingen blandning
  - Personlig deklaration kombinerar dock allt → AB-utdelning + EF-vinst slås ihop för progressivskalan
  - **Lägg lågmarginalskatt-aktiviteten i EF**, högmarginalskatt-aktiviteten i AB

#### Hybridmodell 3: Kulturarbetare med sidoverksamhet

- Kulturarbetarverksamheten i EF (för kulturarbetarkvittning)
- Sidoverksamheten (e.g., konsulthantering) i HB → får 5-årsregeln igen
- AB om man har stor andel ägande och flera samarbetspartner

#### Hybridmodell 4: 62+ med komplementverksamhet

- Lön/pension från eget AB
- EF parallellt → drar nytta av låga egenavgifter (10,21% från 62 om hel pension hela året, annars 28,97% till 65)
- Pension är inte JSA-grundande, men aktiv NV-inkomst är → även små belopp aktiv NV ger förhöjt JSA

## Skiljd hantering vid sjukpenning

A subtle but real fördel för EF:

- **AB-ägare**: AB:et måste betala sjuklön första 14 dagarna ur egen ficka. Försäkringskassan tar över dag 15+. Försäkringskassan granskar AB:ens ekonomi för att bedöma rimlig SGI → kan vara restriktiva för hög lön
- **EF-ägare**: Försäkringskassan betalar sjukpenning direkt från dag 8 (efter karenstid 7 dagar). Aldrig sjuklönsperiod ur EF-ekonomin. SGI baseras på NV-inkomsten over senare år.

För AB-anställda baseras sjukpenningen normalt direkt på månadslönen, men Försäkringskassan kan granska bolagets ekonomi för att bedöma om ett ovanligt högt löneuttag är uthålligt: det kan leda till nedjusterad SGI om resultatet inte motsvarar lönenivån.

## Inlåning till AB: and parallel concept i EF

### AB

- Ägaren får låna ut pengar till AB:et
- AB betalar marknadsmässig ränta → beskattas hos ägaren i inkomstslaget kapital (**30% skatt**)
- Marknadsmässig ränta för ett AB med 25 000 kr aktiekapital ≈ SLR + 1 procentenhet (knappast värt besväret)
- Ej lönebeskattning på räntan; ingen arbetsgivaravgift

### EF

- Ingen motsvarighet: det är **du själv** som driver firman; du kan inte låna ut till dig själv
- Närmast: räntefördelning (kapitalbeskattning 30% av schablonräntan på kapitalunderlaget)
- Räntefördelning är dock obligatorisk (alltid beräknas), och kommer med vissa begränsningar (kapitalunderlag-tröskel, etc)

## Uthyrning till AB

EF har en **specifik nackdel** vs AB här:

- Som ägare till ett AB kan du hyra ut **lokal i din bostad** till AB:et och få marknadsmässig hyra som beskattas i inkomstslaget kapital (30%)
- Som EF-ägare får du INTE hyra ut lokal i din bostad till din EF
- Istället: schablonavdrag (2 000 / 4 000 kr per år beroende på upplåtelseform) eller faktiska merkostnader

## Tantieme: inte tillgängligt i EF

I AB kan ägaren styra resultatet genom **tantiemavsättning** (vinstrelaterad löneökning, beskattas hos ägaren året efter bolagsstämman):
- Reducerar AB:ens beskattningsbara resultat aktuella året
- Beskattas hos ägaren först nästa år (vid utdelningstillfället)

I EF: ingen motsvarighet. Resultatet beskattas alltid hos näringsidkaren personligen samma år.

## Föräldraledighet och föräldrapenninggrundande inkomst

- EF: inkomst av aktiv NV → föräldrapenninggrundande (tak 10 PBB = 588 000 kr 2025)
- AB: lön + förmåner → föräldrapenninggrundande
- Hybridfördel: AB-ägare kan dra upp sin lön innan föräldraledighet för att maxa föräldrapenningen (FK kan dock granska)

## Ombildning EF → AB: when to switch

Triggers för att ombilda till AB:
- **Vinst regelbundet över 800 000 kr**: marginalskatten i EF når 61-63% medan AB-bolagsskatt + K10-utdelning ger 36-40% effektiv
- **Verksamhet ska säljas i framtid**: AB-aktier kan säljas; EF kan inte
- **Externa investerare** behöver
- **Personligt ansvar oacceptabelt**: t.ex. byggverksamhet med stora kontrakt
- **Flera ägare som inte är makar**: EF passar bara en person + makar; HB möjligt men ofta inte attraktivt
- **Anställning skapas**: formellt anställningsförhållande lättare i AB
- **Skenmänsklig profilering**: AB ofta uppfattas som mer seriös av kunder

### Praktisk ombildning

Hela verksamheten överförs till AB. Periodiseringsfonder får överföras (om hela verksamheten eller en verksamhetsgren går över) → aktiekapital måste tillskjutas motsvarande P-fondernas sammanlagda storlek. Expansionsfond kan föras över under specifika villkor (79,4% av fondbeloppet i realtillgångar måste föras med).

Underskott i EF kan **INTE** föras över till AB. Restriktion: tillgångarna förs ut till underpris → uttagsbeskattning frångås → slutligt underskott begränsas.

Detaljerade regler för ombildning EF → AB (kontinuitetsregler, kvarvarande P-fond/expansionsfond, övertagande av räkenskapsenlig avskrivning, tröskeleffekter) ligger utanför scope för denna skill.

## Tabell: snabbjämförelse vid olika vinstnivåer

Per intjänad krona, ungefär (under 65, aktiv, kommunalskatt 32%):

| Vinst (årlig) | EF (vinst) | AB (lön) | AB (utdelning inom K10) |
|---|---|---|---|
| 100 000 | 76 kr/100 | 50 kr/100 | (ej K10-möjlighet ofta) |
| 300 000 | 69 kr/100 | 53 kr/100 | 62 kr/100 (om K10 finns) |
| 500 000 | 64 kr/100 | 55 kr/100 | 62 kr/100 |
| 700 000 | 54 kr/100 | 48 kr/100 | 62 kr/100 |
| 900 000 | 37 kr/100 | 42 kr/100 | 62 kr/100 |

(Approximate: actual depends on specific deduction utilizations.)

Crossover for EF advantage: roughly **at brytpunkten** (~640 000 kr 2025). Below it, EF wins. Above it, AB with K10 wins.

## Anställning vs EF + bisyssla

Subtilt mönster: en näringsidkare med AB-konsultverksamhet (~520 000 kr vinst) **plus** parallell EF med passiv hyresfastighet (~100 000 kr förlust/år).

```
option_A: behåll AB+EF separat
  AB-vinst beskattas högt → ~299 000 kr efter skatt
  EF-förlust rullas (kan inte kvittas mot AB-vinst)
  netto efter att täcka förlusten ur beskattade pengar: ~199 000 kr

option_B: avveckla AB, slå ihop allt i EF
  sammanlagd EF-vinst = 520 000 − 100 000 = 420 000 kr
  skatt+egenavgifter ≈ 167 000 kr → ~253 000 kr kvar

besparing ≈ 54 000 kr/år genom intern kvittning mellan delverksamheter i EF
```

## Pitfalls

1. **Förutsätta att AB alltid är bättre vid hög vinst**: under brytpunkten EF är ALMOST ALWAYS bättre
2. **Glömma "både och" möjligheten**: ofta bästa lösningen
3. **Konvertering till AB innan brytpunkten passerats**: för tidig konvertering kostar K10-uppbyggnad och frivillig administration
4. **Inte överväga 62-årsgyl**: pensionärer (även 62-åringar med hel pension) har drastiskt lägre egenavgifter i EF
5. **Stoppa allt arbete vid 65**: fortsätt aktiv NV → utökat JSA, fortsatt pensionsintjäning
6. **Glömma att EF-underskott från olika delverksamheter automatiskt kvittas**: ofta inte rimligt att sätta upp separata AB
7. **Aktiekapital 25 000 kr som "lätt"**: i praktiken blir AB-ägare ofta personligt ansvariga via borgensavtal → personligt ansvar finns redan
8. **Ansvarsgenombrott**: staten kan kräva betalning från AB-ägare för obetalda skatter/avgifter; ej helt riskfritt

## Implementation checklist for software

If you build software that helps users choose between EF and AB:

- [ ] Ask: vinst-prognos per år nästa 3-5 år
- [ ] Ask: ålder, pension-status
- [ ] Ask: behöver begränsa personligt ansvar?
- [ ] Ask: flera ägare? Make/sambo?
- [ ] Ask: planerar sälja verksamheten framöver?
- [ ] Ask: kulturarbetarverksamhet?
- [ ] Ask: behöver SGI för planerad föräldraledighet?
- [ ] Compute total effektiv skatt per year under EF-alt och under AB-alt med olika löne/utdelning-mixer
- [ ] Surface "både och" som rekommendation om scenariot passar
- [ ] Warn vid premature konvertering (under brytpunkten)
- [ ] Warn att underskott i EF inte kan föras över till AB

See also `swedish-tax-planning` (AB-specifik planering), [[aktiv-passiv-naringsverksamhet]] (gateway), [[periodiseringsfond-expansionsfond-ef]] (jämförelse med AB:s P-fond), [[rantefordelning-planning]] (motsvarighet till AB:s inlåning).
