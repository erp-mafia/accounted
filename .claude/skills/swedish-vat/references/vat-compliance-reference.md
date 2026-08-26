# Swedish VAT (Moms) Complete Compliance Reference

## Table of Contents

1. [Momsredovisning Periods, Thresholds, Deadlines](#1-momsredovisning-periods-thresholds-and-deadlines)
2. [EU VAT Rules in Sweden](#2-eu-vat-rules-in-sweden)
3. [Representation Moms Rules](#3-representation-moms-rules-for-2024-2026)
4. [Mixed Verksamhet / Proportional Deduction](#4-mixed-verksamhet-and-proportional-deduction)
5. [Jämkning of Input VAT on Capital Goods](#5-jämkning-of-input-vat-on-capital-goods)
6. [Frivillig Skattskyldighet for Property Rental](#6-frivillig-skattskyldighet-for-property-rental)
7. [Momsdeklaration Field-to-BAS Account Mapping](#7-momsdeklaration-field-to-bas-account-mapping)
8. [Complete BAS 26xx Account Series](#8-complete-bas-26xx-account-series)
9. [Common Error Patterns and Penalties](#9-highest-frequency-error-patterns)
10. [Key Law References](#10-key-law-references)

---

## 1. Momsredovisning Periods, Thresholds, and Deadlines

Swedish VAT reporting periods are governed by SFL 26 kap. 10-11 §§. The determining factor is the company's beskattningsunderlag (taxable base excluding VAT), specifically excluding unionsinterna förvärv and imports.

### Threshold structure

| Beskattningsunderlag per year | Default period | Alternatives |
|------|------|------|
| ≤ 1 million SEK | Full beskattningsår (annual) | Quarterly or monthly (voluntary) |
| > 1M - ≤ 40 million SEK | Kalenderkvartal (quarterly) | Monthly (voluntary) |
| > 40 million SEK | Kalendermånad (monthly) | None |

Unchanged since 2008 (Prop. 2007/08:25). VAT registration exemption threshold raised from 80,000 SEK to 120,000 SEK effective 1 January 2025 (Prop. 2023/24:149).

### Filing deadlines: Monthly filers

**Beskattningsunderlag ≤ 40M SEK:** Deadline is the 12th of the second month after period ends. In January and August, deadline shifts to the 17th (26 kap. 26 § SFL).

**Beskattningsunderlag > 40M SEK:** Deadline is the 26th of the month after period ends, with 27th applying in December (26 kap. 30 § SFL).

### Filing deadlines: Quarterly filers

12th of the second month after quarter-end, with 17th in August.

| Quarter | Deadline |
|------|------|
| Jan-Mar | 12 May |
| Apr-Jun | 17 August |
| Jul-Sep | 12 November |
| Oct-Dec | 12 February (following year) |

### Filing deadlines: Annual filers

Enskild näringsidkare without EU trade: 12 May following year (byråanstånd to 26 June). With EU trade: 26 February. Juridiska personer: varies by räkenskapsår end-date and filing method (26 kap. 33-33b §§ SFL).

Weekend/holiday deadlines move to the next business day. Payment must reach Skattekontot by filing deadline (62 kap. 3 § SFL).

### Switching periods

Any business can request a shorter period (26 kap. 13 § 1st para, point 1 SFL). 24-month lock-in before switching back to longer period (26 kap. 13 § 2nd para SFL). Switch to quarterly takes effect after current quarter ends (26 kap. 15 § SFL). Turnover threshold crossings require Skatteverket notification (7 kap. 4 § SFL).

### Accounting method interaction

Faktureringsmetoden (accrual) required for omsättning > 3 million SEK. Bokslutsmetoden (cash) available for ≤ 3M SEK; VAT recognized on payment except at year-end.

---

## 2. EU VAT Rules in Sweden

### 2.1 Omvänd skattskyldighet (reverse charge)

Buyer self-assesses both output and input VAT. Applies in two contexts:

**EU cross-border:** Intra-community goods acquisitions, B2B service purchases under main rule, purchases from non-EU suppliers.

**Domestic:** Byggtjänster (construction, between VAT-registered construction businesses), avfall och skrot (scrap metal), guldmaterial (≥ 325 thousandths), mobiltelefoner/datorer/spelkonsoler (invoice > SEK 100,000, since April 2021).

**BAS accounts and booking for reverse charge:**

| Account | Role | Momsdeklaration |
|------|------|------|
| 2614 | Utgående moms, omvänd betalningsskyldighet 25% | Ruta 30 |
| 2624 | Utgående moms, omvänd betalningsskyldighet 12% | Ruta 31 |
| 2634 | Utgående moms, omvänd betalningsskyldighet 6% | Ruta 32 |
| 2645 | Beräknad ingående moms på förvärv från utlandet | Ruta 48 |
| 2647 | Ingående moms, omvänd betalningsskyldighet varor/tjänster i Sverige | Ruta 48 |

Standard journal entry (EU consulting at 25%): Debit cost account + 2645, credit 2614 + leverantörsskulder (2440). Net VAT effect is zero with full deduction right. BOTH sides must be reported; silent netting is prohibited.

### 2.2 Trade in services within EU

**Huvudregeln** (ML 6 kap. 34 §, Article 44 VAT Directive): B2B services taxed where buyer established.

Swedish seller: Invoice without VAT, reference "reverse charge," include buyer VAT number. Report in Ruta 39 + periodisk sammanställning.

Swedish buyer receiving EU services: Report purchase in Ruta 21, self-assess output VAT in Ruta 30/31/32, claim input VAT in Ruta 48.

**Exceptions** (taxed where performed): Fastighetstjänster (property location), persontransporter (where transport occurs), korttidsuthyrning transport vehicles (pickup location), restaurang/catering (where performed), admission to cultural/sports events (event location).

B2C: Generally taxed where seller established. Exception: electronic services, telecom, broadcasting (destination principle since 2015).

### 2.3 Trade in goods within EU

**Gemenskapsinterna förvärv (intra-community acquisitions):** Swedish buyer provides VAT number, receives invoice without VAT, self-assesses. Purchase in Ruta 20, output VAT in Ruta 30/31/32, input VAT in Ruta 48. Cost accounts: 4515/4516/4517 (25%/12%/6%).

**Gemenskapsintern försäljning (intra-community supply):** Zero-rated if four conditions met: valid buyer VAT number (verified via VIES), physical transport from Sweden to another EU country, at least two independent transport documents, reporting in periodisk sammanställning. Reported in Ruta 35, BAS account 3108.

**Trepartshandel (triangulation):** Intermediary (B) avoids VAT registration in destination country. B reports purchases in Ruta 37, sales in Ruta 38, no output/input VAT. Must include in periodisk sammanställning under trepartshandel column. BAS: 4512 (purchase), 3107 (sale).

**Chain transactions (Quick Fixes 2020):** Transport attributed to supply made to the intermediary (if intermediary arranges transport). If intermediary provides departure-country VAT number to supplier, transport attributed to supply made by intermediary. ML 5 kap. 22-25 §.

### 2.4 Distance selling and OSS

Aggregate threshold for B2C distance sales across all EU: EUR 10,000 (≈ SEK 99,680). Above this, destination-country VAT applies. OSS via Skatteverket for quarterly declarations. BAS 2670 handles OSS output VAT. OSS transactions NOT on standard momsdeklaration.

### 2.5 Import and export VAT

Since 1 January 2015, VAT-registered businesses report import VAT in momsdeklaration to Skatteverket (not Tullverket). Only customs duties to Tullverket.

Import tax base (Ruta 50): tullvärde + duties + ancillary costs. Output VAT in Ruta 60/61/62. Input VAT in Ruta 48. BAS: 2615/2625/2635 (output), 2641 (input), 4545/4546/4547 (beschattningsunderlag).

Non-VAT-registered importers: Tullverket collects import VAT directly.

Exports outside EU: 0% moms, full avdragsrätt retained. Ruta 36, BAS 3105. Proof requires customs/freight documentation.

### 2.6 Periodisk sammanställning (EC Sales List)

Required for VAT-registered businesses selling goods/services to VAT-registered EU buyers. Monthly for goods (or goods + services), quarterly for services-only. Electronic deadline: 25th of month after period; paper: 20th (35 kap. 9 § SFL). Late filing penalty: SEK 1,250 per report (52 kap. 10 § SFL). No extension available. Amounts must match Ruta 35 + 38 (goods) and Ruta 39 (services).

---

## 3. Representation Moms Rules for 2024-2026

2017 reform: Income tax deduction for representation meals abolished entirely. Only enklare förtäring (simple refreshments) deductible at 60 SEK/person/occasion for income tax. VAT deduction on representation meals retained.

### VAT deduction limits

Max beskattningsunderlag: 300 SEK excl. moms per person per occasion.

| Scenario | Max VAT deduction per person |
|------|------|
| Food only (12% VAT) | 300 × 12% = 36 SEK |
| Food + alcohol (mixed 12%/25%) | Schablon 46 SEK |
| All at 25% VAT | 300 × 25% = 75 SEK |
| Events/entertainment | Max base 180 SEK/person |
| Representationsgåvor | Max base 300 SEK/person |

**April 2026 change:** Food VAT drops from 12% to 6%, reducing food-only schablon to ~18 SEK (or 33 SEK per updated Skatteverket guidance).

Dual-track: A 500 SEK/person dinner is NOT deductible for income tax but VAT IS deductible on first 300 SEK base.

### BAS accounts for representation

| Account | Purpose |
|------|------|
| 6071 | Representation, avdragsgill (income-tax-deductible) |
| 6072 | Representation, ej avdragsgill |
| 7631 | Personalrepresentation, avdragsgill |
| 7632 | Personalrepresentation, ej avdragsgill |
| 2641 | Ingående moms (deductible VAT portion) → Ruta 48 |

Non-deductible VAT booked as cost, not claimed on momsdeklaration.

### Legal basis

ML 13 kap. 24-25 §§. IL 16 kap. 2 §. Ställningstagande: Dnr 131 519171-16/111 (2016-12-21); Dnr 202 416536-17/111.

---

## 4. Mixed Verksamhet and Proportional Deduction

When business has both VAT-taxable and VAT-exempt activities: directly attributable costs get full/no deduction; shared costs (gemensamma kostnader) require proportional allocation.

### Two methods after HFD 2023 ref. 45

**Method 1 - Skälig grund (ML 13 kap. 29 §):** Allocation on "reasonable basis" reflecting actual resource use. Keys: omsättning, yta, arbetstid, produktionskostnad. Minimum two decimal places.

**Method 2 - EU turnover method (Articles 173.1, 174):** Taxable turnover ÷ total turnover (both excl. VAT). Result rounded UP to next whole number (Article 175.1). Prior year's proportion usable provisionally with year-end adjustment.

Taxpayers may combine methods per cost category, choosing whichever gives better result. Confirmed by Skatteverket Dnr 8-2749853 (2024-02-05) and HFD 2025 not. 29.

### 95% rules (ML 13 kap. 30 §)

If shared purchase used > 95% in taxable part: full input VAT deduction permitted. If > 95% of total turnover is taxable AND input VAT on specific shared purchase ≤ SEK 1,000: full deduction permitted.

### BAS accounts

| Account | Purpose |
|------|------|
| 2649 | Ingående moms, blandad verksamhet (deductible portion) → Ruta 48 |
| 6999 | Ingående moms, blandad verksamhet (non-deductible portion as cost) |

Proportion recalculated annually based on actual turnover with year-end adjustments.

### Proposed changes effective 1 January 2027

Omsättningsmetoden as explicit statutory default. Area-based method (ytbaserad) for building costs. Per-verksamhetsgren calculation.

---

## 5. Jämkning of Input VAT on Capital Goods

Renamed "justering" in ML 2023:200, 15 kap. Requires correction of previously deducted input VAT when capital good use changes during adjustment period.

### Adjustment periods and thresholds

| Asset type | Period | Min ingående moms | Equiv. anskaffningsvärde |
|------|------|------|------|
| Lös egendom (machinery, vehicles) | 5 years | ≥ 50,000 SEK | ≥ 200,000 SEK excl. moms |
| Fastighet (buildings, ny-/till-/ombyggnad) | 10 years | ≥ 100,000 SEK per tax year | ≥ 400,000 SEK excl. moms |

Period starts from acquisition (movable) or completion (real property). Acquisition/completion year = year 1. Each asset assessed separately for threshold. For real property, all work on same fastighet within single tax year IS aggregated.

### Triggers for jämkning

Changed usage between taxable/exempt (assessed at year-end vs acquisition), sale/transfer, demolition, cessation of frivillig skattskyldighet, verksamhetsöverlåtelse. Minimum change: ≥ 5 percentage points.

### Calculation formulas

**Annual adjustment (changed usage):**
Annual jämkning = Original ingående moms × Change in avdragsandel × 1/N (N = 5 or 10)

**One-time adjustment (sale/cessation):**
Slutjämkning = Original ingående moms × Change in avdragsandel × Remaining years / Total years

Example: Warehouse renovated Year 1, 500,000 SEK ingående moms fully deducted, shifts to 60% taxable Year 3: 500,000 × (-40%) × 1/10 = -20,000 SEK (repayment for Year 3).

### EU law: C-787/18 (Sögård Fastigheter)

Swedish rules on transferring jämkningsskyldighet to property buyers incompatible with EU law. Skatteverket confirmed transfer rules no longer applied. Legislative reform: SOU 2026:24 (26 March 2026), lagrådsremiss 1 April 2026.

### BAS accounts

Negative jämkning (repayment): credit 2640/2641, debit cost/asset account. Positive jämkning: reverse. Reported in Ruta 48. Account 2648 (vilande ingående moms) for construction phase before frivillig beskattning granted.

---

## 6. Frivillig Skattskyldighet for Property Rental

ML 12 kap. Allows property owners to charge 25% VAT on commercial rental, unlocking input VAT deductions on property costs. Without this, rental is VAT-exempt, creating dold moms.

### Requirements

Tenant must use premises for VAT-taxable activities (or blandad verksamhet). Rental to stat/kommun/kommunalförbund qualifies regardless. Lease must cover klart avgränsad del of building, provide stadigvarande användning (≥ 1 year or undefined period), premises must not be stadigvarande bostad.

### Activation

Landlord issues hyresavi with 25% moms within 6 months of rental period start. No Skatteverket application needed unless activating during construction (form SKV 5704).

### Chain requirement

Each link in subletting chain must maintain frivillig beskattning. Max three rental links (owner → first-hand → second-hand → end user). If any link fails to charge moms or end-user is exempt, entire chain above loses frivillig beskattning for that lokal, potentially triggering jämkning.

### Interaction with jämkning

If frivillig beskattning ceases: landlord must repay previously deducted investeringsmoms for remaining korrigeringstid. Example: 4,000,000 SEK deducted renovation VAT, loses voluntary registration year 3: repayment = 4,000,000 × 7/10 = 2,800,000 SEK. Landlords should include momsklausuler in leases.

### BAS accounts

| Account | Purpose |
|------|------|
| 2613 | Utgående moms för uthyrning, 25% |
| 2642 | Debiterad ingående moms, frivillig betalningsskyldighet |
| 2646 | Ingående moms på uthyrning |
| 2648 | Vilande ingående moms (construction phase) |
| 3913 | Hyresintäkter (frivilligt momspliktiga) |

---

## 7. Momsdeklaration Field-to-BAS Account Mapping

Complete mapping for SKV 4700.

### Section A - Taxable sales (belopp excl. VAT)

| Ruta | Label | BAS accounts |
|------|------|------|
| 05 | Momspliktig försäljning ej i annan ruta | 3001/3002/3003, 35xx |
| 06 | Momspliktiga uttag | 3401, 3402, 3403 |
| 07 | Beskattningsunderlag vid vinstmarginalbeskattning | 3211, 3212, 3220 |
| 08 | Hyresinkomster vid frivillig skattskyldighet | 3913 |

### Section B - Output VAT on sales (moms amounts)

| Ruta | Label | BAS accounts |
|------|------|------|
| 10 | Utgående moms 25% | 2611, 2612, 2613, 2616 |
| 11 | Utgående moms 12% | 2621, 2622, 2623, 2626 |
| 12 | Utgående moms 6% | 2631, 2632, 2633, 2636 |

### Section C - Reverse charge purchases (belopp excl. VAT)

| Ruta | Label | BAS accounts |
|------|------|------|
| 20 | Inköp varor annat EU-land | 4515, 4516, 4517 |
| 21 | Inköp tjänster annat EU-land (huvudregeln) | 4535, 4536, 4537 |
| 22 | Inköp tjänster land utanför EU | 4531, 4532, 4533 |
| 23 | Inköp varor i Sverige (köparen betalningsskyldig) | 4415, 4416, 4417 |
| 24 | Övriga inköp tjänster i Sverige (köparen betalningsskyldig) | 4425, 4426, 4427 |

### Section D - Output VAT on reverse charge (moms amounts)

| Ruta | Label | BAS accounts |
|------|------|------|
| 30 | Utgående moms 25% | 2614 |
| 31 | Utgående moms 12% | 2624 |
| 32 | Utgående moms 6% | 2634 |

### Section E - VAT-exempt sales (belopp)

| Ruta | Label | BAS accounts |
|------|------|------|
| 35 | Försäljning varor till annat EU-land | 3108 |
| 36 | Försäljning varor utanför EU | 3105 |
| 37 | Mellanmans inköp vid trepartshandel | 4512 |
| 38 | Mellanmans försäljning vid trepartshandel | 3107 |
| 39 | Försäljning tjänster till EU (huvudregeln) | 3308 |
| 40 | Övrig försäljning tjänster omsatta utom landet | 3305 |
| 41 | Försäljning när köparen betalningsskyldig i Sverige | 3231, 3232, 3233 |
| 42 | Övrig försäljning mm | 3004, 3404, 3994, 3980 |

### Section H - Import tax base (belopp)

| Ruta | Label | BAS accounts |
|------|------|------|
| 50 | Beskattningsunderlag vid import | 4545, 4546, 4547 |

### Section I - Output VAT on imports (moms amounts)

| Ruta | Label | BAS accounts |
|------|------|------|
| 60 | Utgående moms 25% import | 2615 |
| 61 | Utgående moms 12% import | 2625 |
| 62 | Utgående moms 6% import | 2635 |

### Section F - Input VAT

| Ruta | Label | BAS accounts |
|------|------|------|
| 48 | Ingående moms att dra av | 2641 + 2645 + 2646 + 2647 + 2649 (deductible only) |

### Section G - Net VAT

| Ruta | Label | BAS accounts |
|------|------|------|
| 49 | Moms att betala eller få tillbaka | 2650 (settlement) |

**Formula:** (Ruta 10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - Ruta 48 = Ruta 49

---

## 8. Complete BAS 26xx Account Series

### 261x - Utgående moms 25%

| Account | Name | Purpose | Ruta |
|------|------|------|------|
| 2610 | Utgående moms, 25% | Summary account | 10 |
| 2611 | Utgående moms försäljning inom Sverige, 25% | Standard domestic | 10 |
| 2612 | Utgående moms egna uttag, 25% | Owner withdrawals | 10 |
| 2613 | Utgående moms uthyrning, 25% | Frivillig skattskyldighet | 10 |
| 2614 | Utgående moms omvänd betalningsskyldighet, 25% | All reverse charge | **30** |
| 2615 | Utgående moms import, 25% | Import VAT (since 2015) | **60** |
| 2616 | Utgående moms VMB 25% | Profit margin scheme | 10 |
| 2618 | Vilande utgående moms, 25% | Dormant/pending | Transferred |

### 262x - Utgående moms 12%

| Account | Name | Purpose | Ruta |
|------|------|------|------|
| 2620 | Utgående moms, 12% | Summary account | 11 |
| 2621 | Utgående moms försäljning inom Sverige, 12% | Food, hotel, restaurant | 11 |
| 2622 | Utgående moms egna uttag, 12% | Owner withdrawals | 11 |
| 2623 | Utgående moms uthyrning, 12% | Rental | 11 |
| 2624 | Utgående moms omvänd betalningsskyldighet, 12% | Reverse charge | **31** |
| 2625 | Utgående moms import, 12% | Import | **61** |
| 2626 | Utgående moms VMB 12% | Profit margin | 11 |
| 2628 | Vilande utgående moms, 12% | Dormant | Transferred |

### 263x - Utgående moms 6%

| Account | Name | Purpose | Ruta |
|------|------|------|------|
| 2630 | Utgående moms, 6% | Summary account | 12 |
| 2631 | Utgående moms försäljning inom Sverige, 6% | Books, transport, culture (incl. danstillställningar from 2026-07-01) | 12 |
| 2632 | Utgående moms egna uttag, 6% | Owner withdrawals | 12 |
| 2633 | Utgående moms uthyrning, 6% | Rental | 12 |
| 2634 | Utgående moms omvänd betalningsskyldighet, 6% | Reverse charge | **32** |
| 2635 | Utgående moms import, 6% | Import | **62** |
| 2636 | Utgående moms VMB 6% | Profit margin | 12 |
| 2638 | Vilande utgående moms, 6% | Dormant | Transferred |

### 264x - Ingående moms

| Account | Name | Purpose | Ruta |
|------|------|------|------|
| 2640 | Ingående moms | Summary account (all rates) | 48 |
| 2641 | Debiterad ingående moms | Standard invoiced input VAT | 48 |
| 2642 | Debiterad ingående moms, frivillig betalningsskyldighet | Voluntary rental input VAT | 48 |
| 2645 | Beräknad ingående moms förvärv utlandet | Reverse charge input (EU + non-EU) | 48 |
| 2646 | Ingående moms på uthyrning | Rental operations input VAT | 48 |
| 2647 | Ingående moms omvänd betalningsskyldighet i Sverige | Domestic reverse charge input | 48 |
| 2648 | Vilande ingående moms | Dormant (construction phase) | Transferred |
| 2649 | Ingående moms blandad verksamhet | Deductible portion mixed activities | 48 |

### 265x-267x - Settlement, excise, OSS

| Account | Name | Purpose |
|------|------|------|
| 2650 | Redovisningskonto för moms | Clearing; net = Ruta 49 |
| 2660 | Punktskatter | Excise (not on momsdeklaration) |
| 2670 | Utgående moms försäljning inom EU, OSS | OSS (separate declaration) |

**Historical note:** Before 2015, 2615/2625/2635 were for EU acquisition output VAT. Since 2015, exclusively for import VAT (Ruta 60-62). Account 2614 now handles all reverse charge (EU + domestic). Legacy system migration must remap.

---

## 9. Highest-Frequency Error Patterns

### Rate misclassification

Wrong VAT rate is the most common SME error. Confusion points: restaurant vs. takeaway food (both 12% but alcohol triggers 25% splitting), digital products (e-books 6% vs. SaaS 25%), mixed hotel packages, repair services (reduced rates only for specific categories: bicycles, shoes, leather goods, clothing, household linen).

**July 2026 change: danstillställningar.** From 2026-07-01, tillträde till danstillställningar (dance events: dansband evenings, club nights with dance character, dance courses with tillställning character) drops from 25% to 6%, aligning dance admission with other cultural events (riksdagen 2025/26:SkU25; Skatteverket "Nya lagar från halvårsskiftet 2026"). Tickets sold and paid before 2026-07-01 keep 25% even if the event is later: the prepayment follows the rate at payment. Watch the split at mixed venues: admission is 6%, but alcohol sales stay 25% and food/serving follows its own rate, so the entrance fee must be separated from serving revenue, same pattern as concert venues.

### EU trade errors

Forgetting reverse charge on EU purchases entirely (neither output nor input VAT reported). Common for IT services, advertising platforms (Google, Meta), consulting from EU suppliers. Also: missing periodisk sammanställning, not validating buyer VAT via VIES, zero-rating without transport documentation.

### Reverse charge booking errors

Posting reverse charge output VAT to 2611 instead of 2614 (inflates Ruta 10 instead of Ruta 30). Booking only one side of reverse charge (output without input or vice versa).

### Period-end clearing failures

Failing to clear all 261x-264x into 2650 at period end. Debit balance on 2650 at year-end should reclassify to 1650 (Momsfordran). Vilande accounts (2618/2628/2638/2648) never transferred cause under-reporting.

### Import VAT errors

Double-counting (paying Tullverket AND reporting in momsdeklaration). Reporting output VAT on imports (Ruta 60) without claiming input VAT (Ruta 48). Using old EU acquisition accounts instead of import-specific accounts.

### Representation errors

Deducting full VAT without 300 SEK cap. Confusing income tax deductibility (abolished 2017) with VAT deductibility (retained). Not separating avdragsgill/ej avdragsgill on correct accounts (6071 vs 6072).

### Penalties

| Violation | Consequence |
|------|------|
| Incorrect declaration | Skattetillägg: 20% of underpaid/overclaimed |
| Period error within 4 months | Skattetillägg: 2% |
| Period error in annual reporting | Skattetillägg: 5% |
| Late filing (skattedeklaration) | Förseningsavgift: 625 SEK (1,250 after föreläggande) |
| Late periodisk sammanställning | 1,250 SEK per report |
| Failure to file (skönsbeskattning) | 20% skattetillägg on estimated amount |

Voluntary correction before Skatteverket detection avoids skattetillägg. Both are not tax-deductible (BAS 6992).

---

## 10. Key Law References

### Mervärdesskattelagen (2023:200)

Replaced ML (1994:200) on 1 July 2023. Key terminology: "omsättning" → "leverans av varor/tillhandahållande av tjänster," "skattskyldig" → "beskattningsbar person/betalningsskyldig."

| Chapter | Subject | Key sections |
|------|------|------|
| 5 kap. | Beskattningsbara transaktioner | §§22-25 (intra-EU) |
| 6 kap. | Plats för transaktioner | §34 (B2B main rule), §35 (B2C) |
| 7 kap. | Beskattningsgrundande händelse | §§4-6 |
| 9 kap. | Skattesatser | §2 (25%), §§3-7 (12%), §§8-15 (6%) |
| 10 kap. | Undantag | Healthcare, education, financial, property |
| 12 kap. | Frivillig beskattning | Commercial property rental |
| 13 kap. | Avdrag för ingående skatt | §6 (main), §18 (cars), §§24-25 (representation), §29 (mixed), §30 (95% rules) |
| 15 kap. | Justering av avdrag | Jämkning; §10 (periods) |
| 16 kap. | Betalningsskyldig | §§6-22 (reverse charge) |
| 18 kap. | Liten årsomsättning | Small business (120,000 SEK from 2025) |
| 22 kap. | OSS/IOSS | One Stop Shop |

### Skatteförfarandelagen (2011:1244)

| Chapter | Subject |
|------|------|
| 7 kap. | Registration (§1 who must register, §4 notification) |
| 26 kap. | Skattedeklaration (§§10-11 periods, §13 voluntary changes/24mo lock-in, §§15-16 timing, §26 deadline 12th, §30 large entity 26th, §§33-33b annual) |
| 35 kap. | Periodisk sammanställning (§9 deadline) |
| 48 kap. | Förseningsavgift |
| 49 kap. | Skattetillägg (§4: 20%, §11: 2% period errors) |
| 62 kap. | Payment deadlines (§3) |

### Key Skatteverket ställningstaganden

- **Representation:** Dnr 131 519171-16/111 (2016-12-21, 300 SEK/schablon); Dnr 202 416536-17/111 (income tax)
- **Mixed activities:** Dnr 8-2749853 (2024-02-05, post-HFD 2023 ref. 45)
- **Jämkning:** Dnr 131 347924-07/111 (5% threshold); Dnr 8-2349336 (2023-05-12, property transfers)
- **Import VAT:** Dnr 131 183789-16/111 (liability)

### Key court rulings

- **HFD 2023 ref. 45** - EU turnover method via direct effect for proportional deduction
- **HFD 2025 not. 29** - Turnover method applies even with stadigvarande bostad
- **C-787/18 (Sögård Fastigheter)** - Swedish jämkning transfer rules incompatible with EU law; reform underway (SOU 2026:24)

### EU VAT Directive (2006/112/EC)

Key articles: 44 (B2B services), 138 (intra-EU supply), 173-175 (proportional deduction), 176 (restriction stand-still), 184-192 (adjustment), 194 (optional domestic reverse charge). Implementing Regulation 282/2011 directly applicable per ML 1 kap. 4 §.