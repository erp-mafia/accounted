# Varulager: Valuation (LVP, anskaffningsvärde, 97 %-regeln, inkurans)

Scope: how to arrive at the closing value of a varulager and book it. Physical counting routines, cut-off and the inventory ledger live in the sibling reference files. **Pågående arbeten för annans räkning** (IL 17 kap 23-32 §§, K2 kap 6, K3 kap 23, BAS **1470**/**1471**/**1478**/**4970**) are explicitly out of scope: route those to `swedish-project-accounting`. Everything below is for goods held for sale or consumption.

---

<!-- toc -->
**Contents**

- [1. The three-question decision table](#1-the-three-question-decision-table)
- [2. Lägsta värdets princip (LVP)](#2-lägsta-värdets-princip-lvp)
- [3. Anskaffningsvärde](#3-anskaffningsvärde)
- [4. Cost-flow assumption](#4-cost-flow-assumption)
- [5. Inkurans](#5-inkurans)
- [6. The 97 % rule (schablonregeln, IL 17 kap 4 §)](#6-the-97--rule-schablonregeln-il-17-kap-4)
- [7. Egentillverkade varor](#7-egentillverkade-varor)
- [8. K2 vs K3: where they actually differ](#8-k2-vs-k3-where-they-actually-differ)
- [9. The small-value simplification (½ prisbasbelopp)](#9-the-small-value-simplification-½-prisbasbelopp)
- [10. BAS 2026 accounts](#10-bas-2026-accounts)
- [11. Ask the user: do not guess](#11-ask-the-user-do-not-guess)
- [12. Sources](#12-sources)

<!-- /toc -->

## 1. The three-question decision table

Run these in order. The answer to Q1 changes the answer to everything else.

| # | Question | Why it decides the outcome |
|---|----------|---------------------------|
| 1 | Which framework: K1 (BFNAR 2006:1), K2 (BFNAR 2016:10) or K3 (BFNAR 2012:1)? | K1 has a lump-sum 3 % write-down and a "skip the stock entirely" rule; K2 hard-codes what may enter anskaffningsvärdet; K3 *requires* indirect production costs when they are material. |
| 2 | Is any item or homogeneous group carried at nettoförsäljningsvärde (i.e. written down below cost)? | If yes, the 97 % rule is unavailable **for the whole stock** (K2 12.5; the same follows from IL 17 kap 4 § read with 3 §). |
| 3 | Is the stock bought-in or egentillverkat? | Self-manufactured goods pull in ÅRL 4 kap 3 § third stycke (indirect production costs), where K2 and K3 diverge sharply. |

| Situation | Value to book | Authority |
|-----------|---------------|-----------|
| Every item's NFV ≥ its cost | Lowest of: cost, or 97 % of total cost | ÅRL 4:9 + IL 17:4 / K2 12.5 |
| At least one item's NFV < its cost | Item-by-item LVP. 97 % rule blocked entirely | K2 12.5 second para |
| Goods physically removed from the stock to be scrapped | Expense the scrapped goods; the remaining stock may still use 97 % | K2 12.18 |
| Goods still lying in the stock at 0 kr | Counts as an inkurans assessment → 97 % rule blocked | K2 12.18 |
| K1 sole trader, total stock ≤ ½ prisbasbelopp | No stock asset at all: expense it | K1 6.47; IL 17 kap 4 a § |
| Råvaror/förnödenheter of minor aggregate value, stable in quantity and mix | Fixed quantity at a fixed value, no count needed | ÅRL 4 kap 12 §; K2 12.6 (±20 % band) |

---

## 2. Lägsta värdets princip (LVP)

**ÅRL 4 kap 9 § första stycket**: "Omsättningstillgångar ska, om inte annat följer av 10, 12, 13 a, 14 a eller 14 e § tas upp till det lägsta av anskaffningsvärdet och nettoförsäljningsvärdet på balansdagen."

- **Nettoförsäljningsvärde** = försäljningsvärdet minus beräknad försäljningskostnad (ÅRL 4:9 tredje stycket). Only costs *directly attributable to the sales transaction* reduce it: rabatter, bonus, provisioner. Normal salaries, storage costs and interest during the storage/credit period do **not** (K2 12.15 and its kommentar).
- **Återanskaffningsvärde** (ÅRL 4:9 fjärde stycket) may replace NFV where there are *särskilda skäl*: typically råvaror and halvfabrikat that the company does not normally sell (K2 12.16; K3 13.13). Compute it the same way as anskaffningsvärde but at balance-sheet-date prices, and still adjust for inkurans.
- Tax floor: **IL 17 kap 3 §**: a lagertillgång "får inte tas upp till lägre värde än det lägsta av anskaffningsvärdet och nettoförsäljningsvärdet, om inte annat följer av 4 eller 4 a §".

### Post för post, not on the whole stock

**ÅRL 2 kap 4 § första stycket 5** requires each component of a balance sheet item to be valued separately. Applied to varulager (K2 12.4 kommentar, K3 13.3 kommentar): *each* article is taken at the lower of its own cost and its own NFV. A fall on one article may **not** be netted against a rise on another.

Collective valuation is allowed only if (K2 12.3, K3 13.3):
- **a)** the goods form a *homogen varugrupp*: interchangeable in every respect relevant to valuation (e.g. raw material of one grade), or
- **b)** individual valuation cannot be justified on cost grounds: judged case by case against the stock's total value, total cost of goods, or turnover.

If it is obvious that NFV exceeds cost for an article or group, NFV need not be computed at all (K2 12.4 second para, BFNAR 2017:7).

**Worked example: why post-för-post matters**

| Article | Qty | Cost/unit | Cost total | Sales price | Direct sales cost | NFV/unit | NFV total | LVP |
|---------|-----|-----------|------------|-------------|-------------------|----------|-----------|-----|
| A-100 | 500 | 200 | 100 000 | 340 | 20 | 320 | 160 000 | **100 000** |
| B-200 | 300 | 150 | 45 000 | 210 | 10 | 200 | 60 000 | **45 000** |
| C-300 | 100 | 350 | 35 000 | 280 | 20 | 260 | 26 000 | **26 000** |
| **Total** | | | **180 000** | | | | **246 000** | **171 000** |

Comparing totals (180 000 vs 246 000) would give 180 000 and overstate the stock by 9 000 kr. The correct figure is 171 000.

Opening balance on **1460** was 165 000, so the closing entry is:

```
Debet  1460 Lager av handelsvaror          6 000
  Kredit 4960 Förändring av lager av handelsvaror   6 000
```

The 9 000 write-down on C-300 is embedded in that figure. Only an *exceptionally large* write-down is broken out separately, in the income-statement post *Nedskrivningar av omsättningstillgångar utöver normala nedskrivningar*: BAS **7740** Nedskrivningar av vissa omsättningstillgångar, reversed on **7790**. K2 kap 4 kommentar: "Posten används endast undantagsvis, t.ex. för exceptionellt stora nedskrivningar på varulager eller kundfordringar."

---

## 3. Anskaffningsvärde

**ÅRL 4 kap 9 § andra stycket**: "Med anskaffningsvärde förstås, om inte annat följer av 11 §, utgifterna för tillgångens förvärv eller tillverkning. Vid bestämmandet av anskaffningsvärdet tillämpas 3 § andra-fjärde styckena."

**ÅRL 4 kap 3 § andra stycket**: "I anskaffningsvärdet för en förvärvad tillgång ska, utöver inköpspriset, utgifter som är direkt hänförliga till förvärvet räknas in."

### Purchased goods: in or out

| Item | In anskaffningsvärdet? | Authority |
|------|------------------------|-----------|
| Inköpspris | Yes | ÅRL 4:3 st 2 |
| Frakt / transport / hantering | Yes | K2 12.7 a; K3 kap 13 kommentar |
| Importavgifter | Yes | K2 12.7 b |
| Tull | Yes | K2 12.7 c |
| Other non-refundable taxes | Yes | K3 kap 13 kommentar ("andra skatter (utom sådana skatter som företaget senare kan återfå)") |
| Lagfart on a lagerfastighet | Yes | K2 12.7 kommentar |
| Cost of making a second-hand item saleable | Yes | K2 12.7 kommentar |
| Varurabatter, bonus, liknande prisavdrag | **Deducted**: also if confirmed after balansdagen but before the årsredovisning is prepared (K2 2.11/2.11A) | K2 12.7 last para |
| Deductible ingående moms | **No**: recoverable, so not an utgift | ÅRL 4:3 st 2; K3 kap 13 kommentar |
| Non-deductible VAT (e.g. goods under VMB) | Yes: it is not recoverable | same |
| Indirect costs on purchased goods | **No** | K2 12.7 kommentar: "Indirekta kostnader ska däremot inte räknas in" |
| Administration, försäljning, lagerhållning, ränta | No | K2 12.12 |
| Offentligt bidrag tied to the acquisition | **Reduces** anskaffningsvärdet; a grant *in the form of* goods gives a cost of 0 kr (e.g. elcertifikat) | K2 9.14 (incl. egentillverkning); K3 24.9 (BFNAR 2025:3) |
| Offentligt bidrag as skattereduktion/skatteavdrag | Does **not** touch anskaffningsvärdet: reduces the year's tax cost | K2 9.14 second para (BFNAR 2025:2) |

Import VAT postings (**2615**/**2645**) and the VMB mechanics behind **1465**/**1466**/**1467** belong to `swedish-vat`; only the cost-inclusion consequence is stated here.

**Retail shortcut (K2 12.8, K3 kommentar, K1 6.51)**: detaljhandels- and handelsföretag may derive cost from the selling price excluding VAT less either the mark-up used in the price calculation or the gross margin for that article/group. If the selling price or the margin has moved since purchase, adjust: the schablon must land at roughly the same value as actual figures.

**Schablon add-ons (K2 2.9, K3 13.4)**: a standing freight percentage, for example, is allowed if there is relevant and reliable underlying data, it is applied consistently, and it gives approximately the same value as the year's actual costs. Compare the schablon against actual outcomes at each bokslut and adjust the percentage.

**K3 only: financing component (13.6)**: goods bought on credit terms that deviate from the normal reduce anskaffningsvärdet by the financing component, which is expensed as interest over the financing period. K2 has no equivalent.

---

## 4. Cost-flow assumption

**ÅRL 4 kap 11 §**: "Anskaffningsvärdet för varulager av likartade tillgångar får beräknas enligt först-in-först-ut-principen, enligt vägda genomsnittspriser eller enligt någon annan liknande princip. **Sist-in-först-ut-principen får inte tillämpas.**"

| Method | Allowed? | Conditions |
|--------|----------|-----------|
| FIFU (först-in-först-ut) | Yes: the main rule | Goods remaining on balansdagen are deemed to be the most recently acquired or manufactured |
| Vägda genomsnittspriser | Yes | Only for *likartade tillgångar*, i.e. interchangeable goods (K3 13.5). One uniform method per group of goods with similar nature and use |
| "Annan liknande princip" | Yes | Must be a similar principle; a consistent method applied per group |
| Standardkostnad (standard cost) | Yes under K3 | Only via the schablon gate in K3 13.4: relevant and reliable basis, consistent application, approximately the same result as actual figures. K3 kommentar: the standard cost is based on a normal situation for material, labour, productivity and capacity utilisation, and "ska omprövas regelbundet och revideras när det är nödvändigt" |
| Specific identification | Required where goods are not interchangeable or are held apart for particular projects (K3 13.5 kommentar) | |
| LIFO / sist-in-först-ut | **Forbidden** | ÅRL 4:11 last sentence, and separately blocked for tax by IL 17 kap 3 § andra stycket |

**Why LIFO is not available**: ÅRL 4:11 forbids it outright in the accounts, and **IL 17 kap 3 § andra stycket** independently forbids it for tax: "När anskaffningsvärdet bestäms, ska de lagertillgångar som finns kvar i lagret vid beskattningsårets utgång anses vara de som anskaffats eller tillverkats senast", i.e. FIFU is mandatory for the tax value. The same FIFU requirement is repeated in **inventeringslagen (1955:257) 1 §**.

Method choice is bound by **ÅRL 2 kap 4 § första stycket 2** (konsekvent tillämpning). K2's kommentar to kap 12 is explicit: the same calculation must be used each year unless operations or purchasing routines have actually changed; buying a stock system that enables purchase-price valuation is a valid reason to switch away from a selling-price-derived method.

---

## 5. Inkurans

Inkurans = the goods have lost value because they are damaged, obsolete (omoderna) or overstocked (övertaliga) (K2 12.14 kommentar; K3 kap 13 kommentar). It is not a separate valuation rule: it enters through the *försäljningsvärde* leg of NFV: "Hänsyn ska tas till inkurans" (K2 12.14, K3 13.10).

| Route | What it is | Evidence required | Tax treatment |
|-------|-----------|-------------------|---------------|
| Item-by-item write-down to NFV | Genuine LVP application | The reduced price the goods are judged sellable at. For övertaliga goods, sales and stock statistics, sales plans | Deductible: it *is* the IL 17:3 floor. Blocks the 97 % rule for the whole stock (K2 12.5) |
| Inkuranstrappa (schablon by age band) | Schablonmässig estimate of övertalighet | Reliable underlying data, consistent application, approximately the same result as an individual assessment, re-evaluated at intervals. A group- or industry-wide trappa does **not** automatically transfer to the individual company (K2 12.14 kommentar; K3 kap 13 kommentar) | Deductible only to the extent it is a substantiated NFV assessment; it is an LVP write-down, so it too blocks the 97 % rule |
| 3 % schablon (97 %-regeln) | A flat tax allowance on the collective cost, not an inkurans assessment | None beyond a correct cost per post in the inventory list | See section 6 |
| Kassation (scrapping) | Goods physically removed from the stock with the intention of discarding them | Physical separation, documented in the period they are scrapped | Expensed in the period of scrapping (K2 12.18); the remaining stock **may still** use the 97 % rule |
| Zero-valued goods left in the stock | Treated as an inkurans assessment | - | Blocks the 97 % rule for every article in the stock (K2 12.18) |

**Negative NFV (K2 12.17)**: if NFV is negative because of a commitment: a non-cancellable sales contract where costs to complete or to sell exceed the contracted price, carry the goods at 0 kr and book the negative amount as a kortfristig skuld under *Upplupna kostnader och förutbetalda intäkter* (**2990**).

**Evidence rule that decides whether any of this survives an audit**: **inventeringslagen (1955:257) 1-3 §§**. Every post must be inventoried and listed with the value taken up under IL 17 kap; the taxpayer signs a försäkran *på heder och samvete* that nothing was omitted (2 §); and if the law is not followed, "de lämnade uppgifterna om varulagrets värde [ska] inte godtas vid inkomstbeskattningen" (3 §). Crucially, **if the 97 % rule is claimed, the anskaffningsvärde of each individual post must appear in the list** (1 § last sentence). Assets valued under ÅRL 4:12 (fixed quantity/fixed value) are exempt from the listing requirement.

---

## 6. The 97 % rule (schablonregeln, IL 17 kap 4 §)

**IL 17 kap 4 §**: "Lagret får tas upp till lägst 97 procent av lagertillgångarnas sammanlagda anskaffningsvärde. Detta gäller dock inte lager av 1. fastigheter och liknande tillgångar, 2. aktier, obligationer, lånefordringar och liknande tillgångar, 3. elcertifikat, samt 4. utsläppsrätter, utsläppsminskningsenheter och certifierade utsläppsminskningar."

Four things an agent must get right about it:

1. **It is a tax rule applied to the collective.** Unlike LVP it is not run post för post: it is 3 % off the *sammanlagda* anskaffningsvärde of the stock.
2. **It is capped by LVP.** K2 12.5: the stock may be taken up at 97 % "under förutsättning att detta värde inte är högre än det värde som en värdering enligt lägsta värdets princip ger". If LVP gives a lower figure than 97 % of cost, the lower figure applies.
3. **All-or-nothing.** K2 12.5 kommentar: "Värderas någon vara eller varugrupp till nettoförsäljningsvärde får inte 97-procentsregeln tillämpas på någon del av varulagret."
4. **It has to be in the books.** Lagervärdering sits inside det kopplade området. **IL 14 kap 4 § första stycket**: "Om räkenskaper förs för näringsverksamheten, ska dessa läggas till grund för beräkningen av resultatet när det gäller beskattningstidpunkten." Second stycke: "Reserv i lager och liknande ska beaktas bara vid tillämpning av 17 kap. 4 och 5 §§ samt 27 § andra stycket." There is therefore **no free-standing declaration adjustment** for the 3 %: book it, or lose it. Both K2 (12.5) and K3 (13.14, "I juridisk person får varor i lager värderas enligt inkomstskattelagen") open the accounting door for exactly this.

Continuity: **IL 14 kap 3 §**: the closing value becomes next year's opening value ("Värdet av ingående lager och andra balansposter ska tas upp till samma belopp som värdet vid det föregående beskattningsårets utgång"). The 3 % is a timing difference, not a permanent one.

### Worked example: the 97 % rule wins

Same AB one year later, K2, FY 2026 = calendar year. Every article's NFV is clearly above its cost, so no article is written down.

| | Amount |
|---|---|
| Sammanlagt anskaffningsvärde, all posts, FIFU | 180 000 |
| LVP post för post (no article below cost) | 180 000 |
| 97 % of 180 000 | **174 600** |
| Reduction taken | 5 400 |
| Ingående balans **1460** | 171 000 |
| Increase to book | 3 600 |

```
Debet  1460 Lager av handelsvaror          3 600
  Kredit 4960 Förändring av lager av handelsvaror   3 600
```

Tax effect: **no line in INK2S**. The 5 400 already reduced the booked result, so the 20,6 % bolagsskatt saving of 1 112 kr comes through the ordinary result. What the agent must verify instead is that the inventeringsförteckning states the anskaffningsvärde per post (inventeringslagen 1 §): that, not a declaration entry, is what supports the claim.

Had one article been written down to NFV by even one krona, the whole 5 400 would be unavailable and the stock would be carried at its LVP figure.

### Alternative presentation: lagerreserv

A K3 company in juridisk person may instead carry the stock at full LVP and present the tax-only reduction as an obeskattad reserv (K3 kap 13, Noter, kommentar: "Ett större företag kan uppfylla upplysningskravet i 5 kap. 26 § andra stycket ÅRL avseende skattemässiga värdejusteringar genom att redovisa de ackumulerade skattemässiga värdejusteringarna som en obeskattad reserv och förändringen som en bokslutsdisposition"):

```
Debet  8896 Förändring av lagerreserv      5 400
  Kredit 2196 Lagerreserv                          5 400
```

**2196** sits under **2190** Övriga obeskattade reserver; **8896** sits under **8890** Övriga bokslutsdispositioner. Split it 79,4 % equity / 20,6 % latent skatteskuld in any analytical balance sheet, like every other obeskattad reserv.

**ÅRL 5 kap 26 § andra stycket**: a *larger* company whose omsättningstillgång "varit föremål för en värdejustering uteslutande av skatteskäl" must disclose that, with the size of the adjustment. Third stycke: if the cost computed under 4:11 deviates materially from NFV on balansdagen, disclose the difference, allocated to the balance sheet posts.

> **Osäkert**: BFN does not state whether a K2 company may use the **2196**/**8896** presentation instead of writing the 3 % into the lager value. K2 12.5 puts the reduction in the lager value itself, and K2 15.3 admits an obeskattad reserv only where tax law requires the amount to be booked for deductibility. Treat the lager-value route as the K2 default and ask before departing from it.

---

## 7. Egentillverkade varor

**ÅRL 4 kap 3 § tredje stycket**: "I anskaffningsvärdet för en tillverkad tillgång får, utöver sådana kostnader som direkt kan hänföras till produktionen av tillgången, en skälig andel av indirekta tillverkningskostnader räknas in." Fjärde stycket allows interest on capital borrowed to finance the manufacture, to the extent it relates to the manufacturing period.

| Cost | K1 (6.48-6.50) | K2 (12.9-12.12) | K3 (13.7-13.9) |
|------|----------------|-----------------|----------------|
| Material (inköpspris) | **Must** | **Must** (12.10 a) | **Must** |
| Own and employees' labour | **Must not** (6.48) | **Must**: lön + arbetsgivaravgifter for staff and hired-in staff working on manufacture (12.10 b) | **Must** (direct labour) |
| Avtalsbaserade avgifter and SLP on pension costs | n/a | May be left out for simplicity (12.10 kommentar) | Ordinary rules |
| Freight/import/tull on inputs | If > 5 000 kr per delivery (6.49/6.50) | **Must** (12.10 c → 12.7) | **Must** |
| Other direct costs (e.g. depreciation on a machine used only for one product) | No | **May** (12.10 second para) | **Must** if material |
| Indirect production overhead | No | **May**: never must (12.11) | **Must** where it is "mer än en oväsentlig del av den sammanlagda utgiften ... eller uppgår till mer än ett obetydligt belopp" (13.7) |
| Ränteutgifter | No | **Forbidden** (12.12 a) | Permitted by ÅRL 4:3 st 4; governed by K3 kap 25 (låneutgifter) |
| Lagerhållningskostnader | No | **Forbidden** (12.12 b) | Excluded unless necessary in the production process before a later step |
| Administrationsomkostnader | No | **Forbidden** (12.12 c) | Excluded where they do not bring the goods to their present location and condition |
| Försäljningsomkostnader | No | **Forbidden** (12.12 d) | Excluded |
| Forsknings- och utvecklingskostnader | No | **Forbidden** (12.12 e) | Ordinary K3 rules; not an inventory cost |
| Onormalt spill / onormalt höga arbetskostnader | No | Not a direct cost | **Excluded**, expensed in the year (13.7 kommentar) |

**Capacity (the trap in both frameworks)**

- **K2 12.11**: indirect production costs are computed on *normalt kapacitetsutnyttjande*. Under- or over-capacity does not change the pålägg: **except** that if utilisation exceeds normal and this affects the cost of the *whole* stock by more than **10 %**, the stock value must be reduced.
- **K3 13.9**: fixed production overhead is allocated on normal production capacity; variable overhead on actual production. In periods of abnormally high production the amount allocated per unit must be reduced so goods are not carried above cost. Unallocated overhead is expensed in the year it relates to.
- **K3 13.8**: where two or more products are manufactured together and costs cannot be separated, allocate logically and consistently; an immaterial by-product is valued at NFV and that amount deducted from the main product's cost.

**Worked example: K2 vs K3 on the same production run**

1 000 units produced, 200 in stock at 2026-12-31. Direct material 400 000, direct labour incl. arbetsgivaravgifter 300 000, indirect production overhead at normal capacity 150 000, administration 100 000, selling 80 000, R&D 50 000, interest 20 000.

| | K2 minimum (12.10 only) | K2 with overhead (12.11) | K3 (13.7, overhead material) |
|---|---|---|---|
| Cost per unit | 700 | 850 | 850 |
| 200 units in stock | **140 000** | **170 000** | **170 000** |

K2 may legitimately land on 140 000 or 170 000; K3 has no choice once the 150 000 is more than an immaterial part of total manufacturing cost. Administration, selling, R&D and interest stay out under both.

Booking, assuming an opening balance of 120 000 on **1450**:

```
Debet  1450 Lager av färdiga varor          50 000
  Kredit 4950 Förändring av lager av färdiga varor  50 000
```

Under K2 the year's own manufacturing costs remain in their natural income-statement posts: *Råvaror och förnödenheter*, *Övriga externa kostnader* and *Personalkostnader*, and only the stock movement goes to *Förändring av lager av produkter i arbete, färdiga varor och pågående arbete för annans räkning* (K2 12.13).

---

## 8. K2 vs K3: where they actually differ

| Topic | K2 (BFNAR 2016:10 kap 12) | K3 (BFNAR 2012:1 kap 13) |
|-------|---------------------------|--------------------------|
| Post för post | Required; collective only for homogena varugrupper or on cost grounds (12.3) | Same rule, same two exceptions (13.3) |
| Indirect production costs | **Optional** (12.11) | **Mandatory** when more than immaterial (13.7) |
| Ränta in cost | **Forbidden** (12.12 a) | Allowed, per ÅRL 4:3 st 4 and K3 kap 25 |
| Financing component on abnormal credit terms | Not addressed | Reduces cost, expensed as interest (13.6) |
| By-products / joint production | Not addressed | Explicit allocation rules (13.8) |
| Offentligt bidrag on stock | Reduces cost; grant *as* an asset gives 0 kr (9.14, amended BFNAR 2025:2) | Same effect in juridisk person, as an option (24.9, BFNAR 2025:3) |
| Standardkostnadsmetod | Not named; only the general schablon rule 2.9 | Named explicitly in the kap 13 kommentar, via 13.4 |
| Retail selling-price method | Explicit (12.8) | Explicit in kommentar (gross margin deduction) |
| 97 % rule | Written into the allmänna rådet (12.5) | Via 13.14: juridisk person may value under IL |
| Fixed quantity/fixed value | ±20 % band quantified (12.6) | ÅRL 4:12 quoted, no band quantified |
| Scrapping vs zero-valuing | Explicit consequence for the 97 % rule (12.18) | Not addressed |
| Negative NFV | Carry at 0, book a liability (12.17) | Not addressed as a separate rule |
| Notes | K2's simplified note regime | Valuation principles and method; pledged stock; ÅRL 5:26 disclosures for larger companies |

**BFNAR 2025:2 (K2, FY beginning after 2025-12-31)**: chapter 12 is **not amended**. No point in 12.1-12.20 carries a (BFNAR 2025:2) marker in the consolidated vägledning dated 2025-06-16. What reaches inventory work comes from the amended general chapters that kap 12 leans on:

- **9.14** now states that a bidrag in the form of a skattereduktion or skatteavdrag does *not* reduce anskaffningsvärdet but reduces the year's tax cost. The rest of 9.14 stands: other offentliga bidrag tied to an acquisition: including acquisition by egentillverkning, reduce the cost, and a grant received *as* an asset gives a cost of 0 kr.
- **2.9** (schablonmässig värdering), the gate for freight add-ons, inkuranstrappor and selling-price-derived cost.
- **2.11/2.11A** (händelser efter balansdagen), which govern rabatter and bonus confirmed after balansdagen (K2 12.7).
- **2.4/2.4A/2.4B** (the 7 000 kr accrual threshold): relevant to cut-off, not to valuation as such.

On the K3 side, **BFNAR 2025:3** amended 24.9: in juridisk person an offentligt bidrag relating to an omsättningstillgång may reduce the cost, and a grant in the form of lagertillgångar may be carried at 0 kr. The K2 chapter 6 rules on pågående arbeten were also amended (6.24): that belongs to `swedish-project-accounting`.

---

## 9. The small-value simplification (½ prisbasbelopp)

**IL 17 kap 4 a §** (as amended by Lag 2024:1131): "Om en enskild näringsidkare upprättar ett förenklat årsbokslut enligt 6 kap. 6 § bokföringslagen (1999:1078), behöver något värde på lagertillgångarna inte tas upp om lagrets sammanlagda värde uppgår till högst ett halvt prisbasbelopp."

**K1 punkt 6.47** (BFNAR 2025:1) mirrors it: "Ett lager som har ett sammanlagt värde som uppgår till högst ett halvt prisbasbelopp behöver inte tas upp i balansräkningen utan får redovisas som kostnad."

| | Value |
|---|---|
| Prisbasbelopp 2026 | **59 200 kr** |
| Half prisbasbelopp 2026 | **29 600 kr** |
| Prisbasbelopp 2025 (comparison) | 58 800 kr → 29 400 kr |

Source: Skatteverket, *Belopp och procentsatser för inkomståret 2026* (2026-01-07). Förhöjt prisbasbelopp 2026 is 60 500 kr and is **not** the one used here.

Three constraints an agent must apply before using this:

- **Only enskild näringsidkare with a förenklat årsbokslut** (K1, BFNAR 2006:1). It is not available to an AB, and not to a sole trader who prepares a full årsbokslut or årsredovisning. The amended wording applies first for beskattningsår beginning after 2024-12-31 (Lag 2024:1131, övergångsbestämmelse p. 3); the previous limit was a fixed kronbelopp.
- **The limit is per person, not per business.** K1 kap 1 kommentar: "Beloppsgränserna ett halvt prisbasbelopp i punkterna 6.38 och 6.47 ... gäller för den fysiska personens samtliga verksamheter totalt."
- **It is a threshold, not an allowance.** At exactly 29 600 kr the stock may be omitted; at 29 601 kr the whole stock is recognised.

K1's own valuation rules, for stock above the threshold: cost = invoice price plus other external acquisition costs only if those exceed 5 000 kr per delivery (6.49/6.50); own and employees' labour is excluded (6.48); the last normal invoice price may be used as cost (6.51); and **6.53** gives the same 3 % schablonmässigt beräknad värdenedgång, with **6.54-6.55** requiring a real post-för-post write-down where the actual fall in value is clearly much larger.

---

## 10. BAS 2026 accounts

Verified against the BAS 2026 kontoplan (v 1.1) published on bas.se. Numbers in column A/C, names in B/D; none of the accounts below carries the **#** marker, so all are available under K2.

| Account | Name | Use |
|---------|------|-----|
| **1410** | Lager av råvaror | Raw materials |
| **1419** | Förändring av lager av råvaror | Balance-sheet-side change account |
| **1420** | Lager av tillsatsmaterial och förnödenheter | Consumables used in production |
| **1429** | Förändring av lager av tillsatsmaterial och förnödenheter | |
| **1440** | Produkter i arbete | WIP goods (not customer contracts) |
| **1449** | Förändring av produkter i arbete | |
| **1450** | Lager av färdiga varor | Own manufactured finished goods |
| **1459** | Förändring av lager av färdiga varor | |
| **1460** | Lager av handelsvaror | Bought-in goods for resale |
| **1465** | Lager av varor VMB | Vinstmarginalbeskattade goods |
| **1466** | Nedskrivning av varor VMB | |
| **1467** | Lager av varor VMB förenklad | |
| **1469** | Förändring av lager av handelsvaror | |
| **1480** | Förskott för varor och tjänster | Supplier prepayments: not stock |
| **1490** | Övriga lagertillgångar | |
| **1491** | Lager av värdepapper | Excluded from the 97 % rule (IL 17:4 p. 2) |
| **1492** | Lager av fastigheter | Excluded from the 97 % rule (IL 17:4 p. 1) |
| **1493** | Djur som klassificeras som omsättningstillgång | IL 17 kap 5 §, 85 %-regeln |
| **2196** | Lagerreserv | Under 2190 Övriga obeskattade reserver |
| **2990** | Övriga upplupna kostnader och förutbetalda intäkter | Negative NFV liability (K2 12.17) |
| **4000/4010** | Inköp av handelsvaror (gruppkonto) / i Sverige | |
| **4090** | Erhållna rabatter (Handelsvaror) | Reduces anskaffningsvärdet (K2 12.7) |
| **4310** | Inköp av råvaror och material i Sverige | |
| **4900** | Förändring av lager (gruppkonto) | |
| **4910** | Förändring av lager av råvaror | P&L counterpart to 1410 |
| **4920** | Förändring av lager av tillsatsmaterial och förnödenheter | |
| **4940** | Förändring av produkter i arbete | |
| **4950** | Förändring av lager av färdiga varor | P&L counterpart to 1450 |
| **4960** | Förändring av lager av handelsvaror | P&L counterpart to 1460 |
| **7740** | Nedskrivningar av vissa omsättningstillgångar | Only for exceptionally large write-downs |
| **7790** | Återföring av nedskrivningar av vissa omsättningstillgångar | |
| **8896** | Förändring av lagerreserv | Under 8890 Övriga bokslutsdispositioner |

**There is no 1430 in BAS 2026.** Halvfabrikat go to **1440** Produkter i arbete (or **1410** if they are still input material). **1470**-**1479** and **4970**-**4977** are pågående arbeten: `swedish-project-accounting`.

Sign convention for the 49xx accounts: an **increase** in the stock is credited (Debet 14xx / Kredit 49xx) and reduces the year's cost; a **decrease** is debited (Debet 49xx / Kredit 14xx).

---

## 11. Ask the user: do not guess

| Ask | Why |
|-----|-----|
| K1, K2 or K3? | Decides whether indirect production costs are optional or mandatory, whether interest may be capitalised, and whether the ½-PBB skip exists at all. |
| Has an inventering been performed at balansdagen, and is there a signed förteckning with a value per post? | Without it the reported value is not accepted for tax (inventeringslagen 3 §). If the count was before balansdagen, ask how the roll-forward to balansdagen was done (1 § third stycke). |
| Do you want to apply the 97 % rule this year? | It cannot be combined with *any* NFV write-down (K2 12.5). Ask before writing anything down, and confirm the list shows anskaffningsvärde per post (inventeringslagen 1 §). |
| Are there obsolete, damaged or overstocked goods, and were any physically scrapped before balansdagen? | Scrapping preserves the 97 % rule; zero-valuing in place destroys it (K2 12.18). |
| If an inkuranstrappa is used: what is it based on, and when was it last evaluated against actual outcomes? | A group or industry trappa does not transfer automatically (K2 12.14, K3 kap 13 kommentar). |
| Is any of the stock fastigheter, värdepapper, elcertifikat or utsläppsrätter? | Excluded from the 97 % rule (IL 17:4 p. 1-4); animals follow IL 17 kap 5 § (85 % of average production cost). |
| For self-manufactured goods: what is normal capacity, and what was actual output? | K2 12.11's 10 % rule and K3 13.9's over-capacity reduction both bite here. |
| Which cost-flow method was used last year? | ÅRL 2:4 st 1 p. 2: switching needs an actual change in circumstances. |
| Is the company a *större företag*? | Triggers ÅRL 5 kap 26 § disclosures: interest capitalised in an omsättningstillgång, tax-only value adjustments, and material FIFU-vs-NFV differences. |
| Enskild firma claiming the ½-PBB skip: what is the total across *all* the person's businesses? | The limit is per person, not per verksamhet (K1 kap 1 kommentar). |

---

## 12. Sources

- **ÅRL (1995:1554)** 2 kap 4 §, 4 kap 3 §, 4 kap 9 §, 4 kap 11 §, 4 kap 12 §, 5 kap 26 §: rkrattsbaser.gov.se
- **IL (1999:1229)** 14 kap 2-4 §§, 17 kap 2 §, 3 §, 4 §, 4 a §, 5 §, 22 § (kontraktsnedskrivning), 23-32 §§ (pågående arbeten, out of scope): rkrattsbaser.gov.se
- **Lag (1955:257) om inventering av varulager för inkomstbeskattningen** 1-3 §§
- **BFNAR 2016:10 (K2)**, vägledning *Årsredovisning i mindre företag*, updated 2025-06-16: kap 12 punkterna 12.1-12.20, kap 2 punkt 2.9, kap 4 (RR-poster), kap 9 punkt 9.14, kap 15 punkt 15.3
- **BFNAR 2012:1 (K3)**, vägledning *Årsredovisning och koncernredovisning*, consolidated 2025-12-15: kap 13 punkterna 13.1-13.14, kap 24 punkt 24.9, kap 25 punkt 25.2
- **BFNAR 2006:1 (K1)**, vägledning *Enskilda näringsidkare som upprättar förenklat årsbokslut*, consolidated 2025: punkterna 6.45-6.55, kap 1 kommentar
- **BAS 2026 kontoplan v 1.1**, bas.se (`BAS_kontoplan_2026_v2.xlsx`)
- **Skatteverket**, *Belopp och procentsatser för inkomståret 2026*, dated 2026-01-07: prisbasbelopp 59 200 kr
