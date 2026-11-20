# Periodiseringsfond and Expansionsfond: EF Perspective

<!-- toc -->
**Contents**

- [Legal basis](#legal-basis)
- [Quick comparison: P-fond AB vs P-fond EF](#quick-comparison-p-fond-ab-vs-p-fond-ef)
- [Periodiseringsfond EF mechanics](#periodiseringsfond-ef-mechanics)
- [Expansionsfond mechanics](#expansionsfond-mechanics)
- [Sjukpenninggrundande and pensionsgrundande inkomst effects](#sjukpenninggrundande-and-pensionsgrundande-inkomst-effects)
- [Bokföringsförbudet (K1 / BFNAR 2006:1)](#bokföringsförbudet-k1--bfnar-20061)
- [Interactions with each other](#interactions-with-each-other)
- [Common pitfalls](#common-pitfalls)
- [Recommended planning sequence per inkomstår](#recommended-planning-sequence-per-inkomstår)
- [Multi-year planning horizon](#multi-year-planning-horizon)
- [Skatteflyktslagen and audit triggers for EF](#skatteflyktslagen-and-audit-triggers-for-ef)

<!-- /toc -->

## Legal basis

- IL 30 kap: Periodiseringsfond (P-fond)
- IL 34 kap: Expansionsfond
- BFNAR 2006:1: K1 (förbjuder bokföring av P-fond/expansionsfond för EF)

For an AB-perspective on periodiseringsfond, see `swedish-tax-planning/references/periodiseringsfond.md`. The mechanics differ enough that they should be treated as separate systems.

## Quick comparison: P-fond AB vs P-fond EF

| Property | AB | EF |
|---|---|---|
| Max avsättning | 25% av skattemässigt överskott | **30%** av skattemässigt överskott |
| Booked in räkenskaperna? | YES (8811/21xx): formellt samband | **NO** (NE-bilaga only) |
| Schablonintäkt | YES (SLR × IB av P-fonder, min 0,5%) | **NO** |
| Antal parallella fonder | 6 | 6 |
| Maximal carry | 6 år (FIFO återföring senast år 7) | 6 år (FIFO) |
| Uppräkning på återföring (fonder från före 2021) | YES (106 % för fonder före 2019, 104 % för 2019-2020, 100 % fr.o.m. 2021) | No equivalent (gäller bara juridiska personer) |

The most important EF-specific facts:
1. **30%** (not 25%): markedly more aggressive than AB
2. **NO schablonintäkt**: the deferred tax sits genuinely 0%-räntefri for 6 years
3. **NEVER booked in räkenskaperna**: only on NE-bilagan. Bokföring av P-fond gör avdraget ogiltigt för EF (omvänt mot AB!)

## Periodiseringsfond EF mechanics

### Avsättning

- Max **30% of resultat efter räntefördelning, efter återföring av tidigare P-fond, och före egen P-fond avsättning och ändring av expansionsfond**
- Each year creates its own fund (e.g., "periodiseringsfond 2025": separately tracked)
- Up to 6 fonder samtidigt

### Återföring

- Senast **år 7** (= 6:e året efter avsättningsåret) **måste** äldsta fond återföras
- Återföringen är frivillig in earlier years
- Tvingande återföring av samtliga fonder vid:
  - Verksamhetens upphörande
  - Skattskyldighetens upphörande vid utvandring utanför EU/EES
  - Konkurs
  - A-kassa (om man slutar för att få a-kasseersättning, då återförs)

Vid flytt till EU/EES-land kan kontinuitet medges (EU-rätten).

### Reporting on NE

- Ruta **R32**: Återföring av periodiseringsfond
- Ruta **R33**: Överskott före avsättning till periodiseringsfond (= caps R34)
- Ruta **R34**: Avsättning till periodiseringsfond (max 30 % av R33)
- Upplysning U1 in förenklat årsbokslut: sammanlagda P-fonder vid årets slut

### Pitfall: P-fond utan likvid reserv

Scenario: P-fond-avsättning år 1-6 (totalt N kr), pengarna används i drift (inga kontanter kvar). År 7+ tvingande återföring av äldsta P-fond → skattebördan kan vara 40-50 % av återfört belopp utan motsvarande kassaflöde.

**Reserveringsregel**: vid varje P-fond-avsättning, sätt av 30-35 % av beloppet på separat konto (likvid reserv för framtida skattebörda).

**Mitigation om man hamnat där**: fortsätt verksamheten i liten skala, gör partial återföring + ny avsättning varje år (t.ex. återför 200 000 / sätt av 30 000 → 170 000 nettoåterförs och beskattas årligen) → sprider skattebelastningen över år 7-13.

### Combining with räntefördelning at nedläggning

Sparat fördelningsbelopp (positiv räntefördelning som sparats) får användas vid nedläggning för att kvitta återförd P-fond OCH expansionsfond. Detta är den **enskilt största planeringsmöjligheten** för en EF vid avveckling: se sparat-fördelningsbelopp-mekaniken i [[rantefordelning-planning]].

### Tillfällig regel 2019 (COVID)

For inkomstår 2019, 100% av vinsten fick avsättas till P-fond (one-time relief). Possible to retroactively use via omprövning of 2019 deklaration within 6 years (= until inkomstår 2025 deklaration filing window) if not already done.

### SOU 2020:50 proposal: P-fond delarna **EJ genomförda**

Höjningen från 30% till 40% och förlängd carry till 10 år låg på utredningens bord. **Inte enacted** via prop. 2024/25:1 (som främst genomförde RF-reformen: se [[rantefordelning-planning]] för det som faktiskt blev lag). Bevaka för framtida reformpaket.

- Höjd från 30% till **40%**
- Förlängd carry från 6 till **10 år**
- P-fond äldre än 6 år FÅR INTE överföras till AB vid ombildning (would be återförda direkt at takeover)

## Expansionsfond mechanics

### Purpose

Expansionsfond gives EF the equivalent of an AB's ability to retain earnings at corporate-tax-rate. The fonderade vinsten beskattas with **20,6% expansionsfondsskatt** (same as bolagsskatt) and may be reinvested in verksamheten utan ytterligare beskattning. At återföring, the 20,6% credits back against that year's tax (so the net effect is just regular inkomstskatt on the återförda beloppet).

### Avsättning rules

- Skatt: **20,6%** expansionsfondsskatt (synkad med bolagsskatten)
- Tak: expansionsfonden får vara **högst 125,94% av kapitalunderlaget** vid årets utgång (= 1 / (1 − 0,206) = 100 / 79,4: gross-up-faktorn som säkerställer att fondens netto-värde efter expansionsfondsskatt = kapitalunderlaget)
- Ökning av expansionsfond may NOT cause underskott in NV
- Ökning beräknas på resultat efter räntefördelning, efter ändring av P-fond, och före ändring expansionsfond

### Kapitalunderlag for expansionsfond

Conceptually identical to kapitalunderlag for räntefördelning, with one key difference:
- **Räntefördelning**: kapitalunderlag at *föregående* års utgång (= ingång aktuella året)
- **Expansionsfond**: kapitalunderlag at *aktuella* årets utgång

Practical tip: the year 2 expansionsfond kapitalunderlag will be similar to the year 3 räntefördelning kapitalunderlag, so the same beräkning may be reused with a one-year offset.

### Återföring

- May happen voluntarily at any point
- Vid återföring ökar skattemässig inkomst, men 20,6% expansionsfondsskatt återbetalas
- Vid förlustår: återföringen kan vara **skattefri** (the 20,6% återbetalas och resultatet blir 0 eller negativt → no extra inkomstskatt)
- Vid kapitalunderlags-minskning under fondens nivå → tvingande återföring (delvis)
- Vid företagets upphörande → all återförs samma år

### NE-bilaga fields

- Ruta **R35**: Överskott före ökning av expansionsfond (= caps R36)
- Ruta **R36**: Ökning av expansionsfond (högst R35) → INK1 p.12.1
- Ruta **R37**: Minskning (återföring) av expansionsfond → INK1 p.12.2
- Hjälpblankett **SKV 2196** (Räntefördelning och expansionsfond): used för kapitalunderlagsberäkning. **Lämnas INTE in** till Skatteverket; behåll som arbetspapper. Beräknade belopp överförs till NE och INK1.
- Upplysning U2 in förenklat årsbokslut: expansionsfond vid årets slut

### Expansionsfond: breakeven-exempel (siffror illustrativa)

Setup: aktiv EF under pensionsåldersgränsen, NV-vinst 800 000 kr, kapitalunderlagstak 400 000 kr → max-avsättning 400 000 × 1,2594 = ~503 000 kr.

| Variabel | Utan expansionsfond | Med 100 000 kr avsättning |
|---|---|---|
| NV-beskattad inkomst | 800 000 | 700 000 |
| Skatt + egenavgifter på NV-delen | ~236 000 | ~189 500 |
| Expansionsfondsskatt (20,6 % × 100 000) | 0 | 20 600 |
| **Total skatt år 1** | **~236 000** | **~210 100** |
| **Sparat år 1** | - | **~25 900 kr** |

Avsättning binder upp 100 000 kr i verksamheten (kan återföras senare → 20,6 % återbetalas mot återföringsårets skatt). Lönsamt när NV-marginalskatt år 1 > 20,6 %.

### Carry-forward of skatt

The 20,6% expansionsfondsskatt is paid in the year of avsättning. **It is NOT a deferral of inkomstskatt**: it's a final-tax on the avsättning. At återföring, the 20,6% credits back.

### When expansionsfond is *not* worth it

Same logic as räntefördelning:
- Pensionärer (10,21% egenavgifter): low marginal NV tax may already be UNDER 20,6%
- För inkomster under brytpunkten, marginalskatten kan vara så låg att expansionsfondsskatten 20,6% är högre

**Heuristik**: only use expansionsfond when *current year* marginal skatt inkl egenavgifter > 20,6% AND *expected future return year* marginal skatt < current year marginal skatt.

### Två-stegs beskattning vid utlöp

If you build up expansionsfond at 20,6% and later take ut pengarna (instead of reinvesting):
- Recovery → 42% (statlig + kommunal) − 20,6% = **21,4% extra skatt + egenavgifter** at återföringsåret

So total skatt mot vad det vore som direkt löneuttag är samma, **bara om utbetalningen sker över brytpunkten i återföringsåret**. Under brytpunkten the math may favor expansionsfond (cheap retention) or löneuttag (cheap immediate).

### Tvingande återföring

- Vid upphörande av verksamheten (all of it)
- Vid utvandring till icke-EES-land
- Vid konkurs
- Vid kapitalunderlagsminskning under fondens nivå
- Vid byte av företagsform: kan överföras till AB *under förutsättning att samtliga realtillgångar överförs* OCH att tillgångar med skattemässigt värde ≥ 79,4% av expansionsfondens belopp överförs (motsvarar 100% − 20,6%)

### SOU 2020:50 proposal: expansionsfond-delarna **EJ genomförda**

Slopningen av expansionsfond ingick i den större "näringsfond"-idén som SOU föreslog. **Inte enacted**: prop. 2024/25:1 begränsade sig till RF-reformen (se [[rantefordelning-planning]]). Expansionsfond består tills vidare.

- Expansionsfond föreslås **slopad** (avskaffad)
- Befintliga fonder återförs med minst 10% per år under högst 10 år
- Återföring beläggs med inkomstskatt men 20,6% återbetalas
- Höjd P-fond (30 → 40%) som kompensation
- Worth flagging as "watch this space"

## Sjukpenninggrundande and pensionsgrundande inkomst effects

This is the most subtle interaction. Försäkringskassan bortser från de skattemässiga dispositionerna **periodiseringsfond och expansionsfond** vid beräkning av sjukpenninggrundande inkomst (SGI) och föräldrapenninggrundande inkomst: men de slår igenom på den pensionsgrundande inkomsten (PGI).

| Disposition | SGI effekt | PGI effekt |
|---|---|---|
| Avsättning P-fond | INGEN (FK adjusts back) | Sänker PGI |
| Återföring P-fond | INGEN (FK adjusts back) | Höjer PGI |
| Avsättning expansionsfond | INGEN | Sänker PGI |
| Återföring expansionsfond | INGEN | Höjer PGI |
| Räntefördelning | Påverkar (positiv sänker, negativ höjer) | Påverkar |
| Avskrivning på inventarier | Påverkar (höjd avskrivning sänker SGI och PGI) | Påverkar |
| Mindre schablonavdrag egenavgifter | Höjer (paradoxalt) | Höjer |

**Implication**: a näringsidkare with ojämn inkomst may use P-fond strategically to **smooth out PGI** (höja den i låga år, sänka i höga år) but NOT to smooth SGI (which Försäkringskassan adjusts back).

PGI-tak (7,5 IBB): 2025 = 604 500 kr / 2026 = 625 500 kr. Inkomst över taket → 0 extra pension, full egenavgift (= ren skatt utan pensionsavkastning).

PGI-utjämnings-strategy:
```
höginkomstår: avsätt (förväntad_PGI − tak) till P-fond → PGI sänks till exakt taket
låginkomstår: återför P-fond → höjer PGI mot taket
```

PGI-beräkning: PGI = NV-resultat efter schablonavdrag (25 % aktiv / 20 % SLP / 10 % pensionär). Vid 800 000 kr brutto aktiv NV → PGI-grund 600 000 kr (under 2025/2026-taket, ingen avsättning behövs). Vid större brutto → räkna ut delta mot taket och avsätt motsvarande.

## Bokföringsförbudet (K1 / BFNAR 2006:1)

EF must **NOT** book P-fond or expansionsfond in räkenskaperna: only as upplysning U1/U2 in förenklat årsbokslut, and via NE-bilagan. This is the **opposite** of AB (which MUST book P-fond).

The reason: K1 is designed to keep redovisning aligned with real ekonomisk ställning, not skattemässig disposition. Latent skatteskuld is disclosed via U-poster, not booked.

BAS 2018 Förenklat årsbokslut har konton 2080 Periodiseringsfonder och 2050 Avsättning till expansionsfond för EF som *vill* spegla skattemässiga reserver i sin redovisning, men de är för **informationssyfte only**: får INTE debiteras/krediteras mot resultatkonton (förbudet ovan).

**Undantag: ersättningsfond (IL 31 kap).** Till skillnad från P-fond och expansionsfond **skall** ersättningsfondsavsättningen bokföras via resultaträkningen (debit 8xxx, credit **2060 Ersättningsfond**) för att avdraget ska vara giltigt. Detta gäller även för EF under K1. Se [[ersattningsfond]] för detaljer. Undantag: ersättningsfond för mark behöver inte bokföras enligt BFNAR 2006:1.

## Interactions with each other

P-fond and expansionsfond are computed **in a specific order**:

1. Compute skattemässigt resultat (R12 bokfört resultat + R13-R28 justeringar = R29 överskott före räntefördelning)
2. Apply **räntefördelning** (R30 positiv → decrease, R31 negativ → increase)
3. Apply **återföring av P-fond** (R32) → increase result
4. Compute **30% cap for new P-fond avsättning** = 30% of the *för periodiseringsfond justerade positiva resultatet* (IL 30 kap 6 §): the result before P-fond avsättning, **increased by** avdrag för egenavgifter (16 kap 29 §), pensionsförsäkringspremie och inbetalning på pensionssparkonto med SLP (16 kap 32 §) and **avdrag för avsättning till expansionsfond (34 kap)**, and **decreased by** sjukpenning och liknande (15 kap 8 §), återfört avdrag för egenavgifter and **återfört avdrag för avsättning till expansionsfond**
5. Apply **avsättning ny P-fond** (R34) → decrease result
6. Compute **expansionsfond ökning room** = R35 (result after step 5; ökning may not cause underskott)
7. Apply **ökning expansionsfond** (R36) → decrease result, or **minskning** (R37) → increase result
8. Then pensionssparavdrag (R38-R39), avstämning egenavgifter (R40-R41), R42 överskott före avdrag för egenavgifter, schablonavdrag (R43), sjukpenning (R44), and final överskott/underskott (R47/R48)

The exact ordering is enforced by NE-blankett layout. Note that the result *after* P-fond avsättning is the cap for expansionsfond ökning, so the two tools partly compete (every kr more in P-fond is one kr less expansionsfond room).

### SOU 2020:50 proposes reversing the order: räntefördelning would be applied *last*, after P-fond. **Not enacted** (prop. 2024/25:1 ändrade RF-trösklarna men inte beräkningsordningen).

## Common pitfalls

1. **Booking P-fond in EF räkenskaperna**: invaliderar avdraget (oppositional to AB where it's required)
2. **Forgetting tvingande återföring** at upphörande: Skatteverket återför automatiskt and may apply skattetillägg
3. **Calculating expansionsfond tak using prior year kapitalunderlag**: must be *current year's* utgång, not prior year's
4. **Misunderstanding 125,94 % multiplier**: it represents 1 / (1 − 0,206) = 100 / 79,4 ≈ 1,2594 = the gross-up factor that ensures the net-of-tax expansionsfond equals exactly kapitalunderlaget. Equivalent statement: expansionsfond *net of skatt* ≤ 100 % av kapitalunderlag. Äldre källor (före 2021) använder 128,21 % baserat på den dåvarande 22 % bolagsskatten; korrekt multiplikator vid nuvarande 20,6 % expansionsfondsskatt är 125,94 %.
5. **Skipping U1/U2 upplysning** in förenklat årsbokslut: formal compliance requirement under BFNAR 2006:1
6. **Forgetting expansionsfond may NOT cause underskott**: software should clip ökning at the level that leaves NV result ≥ 0

## Recommended planning sequence per inkomstår

1. Compute provisional resultat
2. Compute kapitalunderlag for räntefördelning (ingång) and expansionsfond (utgång)
3. Decide whether positiv räntefördelning is net beneficial (see [[rantefordelning-planning]] decision tree)
4. Decide P-fond avsättning to:
   - Hit PGI tak (7,5 IBB ≈ 511 500 / 604 500 depending on year)
   - Reserve for known future förlustår or låginkomstår
5. Decide expansionsfond ökning to:
   - Retain working capital for verksamheten
   - Lower current marginal skatt below brytpunkten
6. Sanity-check: total egenavgifter underlag still > 40 000 kr to qualify for nedsättning 7,5%
7. Compute schablonavdrag egenavgifter (R43) and submit

See also [[ackumulerad-inkomst]] for handling the upphörande year återföring lump sum, [[egenavgifter-sgi-pgi-jsa]] for nedsättning rules, and [[ef-vs-ab-breakeven]] for the comparison with corporate periodiseringsfond.

## Multi-year planning horizon

The most valuable patterns for EF:
1. **Build kapitalunderlag steadily**: every kr of varaktig egen insättning grows räntefördelning room *and* expansionsfond tak in perpetuity
2. **Use P-fond for sjukpenninggrundande inkomst leveling**: note P-fond does NOT affect SGI calculation (Försäkringskassan bortser från dispositioner) but DOES affect PGI; see [[egenavgifter-sgi-pgi-jsa]]
3. **Aktiv classification is gold**: fight for it via timesheet, since it unlocks jobbskatteavdrag (worth up to ~30 000 kr/year), kvittning mot tjänst, lägre egenavgifter, pensionsrätt
4. **Consider EF→AB transition around brytpunkten**: under brytpunkten EF is usually cheaper than AB; over brytpunkten AB starts to win (see [[ef-vs-ab-breakeven]])

## Skatteflyktslagen and audit triggers for EF

EF skatteplanering can raise scrutiny under Lag 1995:575 om skatteflykt when:
- Switching aktiv/passiv classification opportunistically (e.g., to abuse 5-year kvittningsregeln)
- Inkomstuppdelning between makar that doesn't reflect actual arbetsinsats or kapitalinsats
- Sudden growth of kapitalunderlag through tillfälliga kapitaltillskott (only varaktiga tillskott count, IL 33 kap 6 §)
- Large expansionsfond avsättning followed by quick liquidation of verksamheten
