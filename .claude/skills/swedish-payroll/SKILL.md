---
name: swedish-payroll
description: Swedish payroll (lön & arbetsgivaravgifter) compliance reference for developers building payroll or accounting software. Covers arbetsgivardeklaration (AGI) filing, sociala avgifter (31.42% breakdown and age reductions), skatteavdrag (tax table lookup, column system, jämkning), förmånsbeskattning (bilförmån calculation, kostförmån, friskvård, KPO), semesterlöneskuld (procentregeln 12%, sammalöneregeln, BAS 2920/7090), OB-tillägg and övertid (Arbetstidslagen limits, CBA divisors), traktamente (domestic/international rates, tremånadersregeln, meal reductions), utlägg vs kostnadsersättning (milersättning, körjournal), F-skatt vs A-skatt distinction and verification, BAS 7xxx series account mapping (7010-7699 wages, 7510 avgifter, 7321-7332 traktamente/resor), nettolöneavdrag vs bruttolöneavdrag processing order, löneväxling (1.058 factor, pension cap), and sjuklön (karensavdrag, day 2-14 at 80%, Försäkringskassan day 15+). Trigger on any mention of lön, lönehantering, payroll, arbetsgivardeklaration, AGI, arbetsgivaravgifter, skatteavdrag, skattetabell, förmånsbeskattning, bilförmån, kostförmån, friskvårdsbidrag, semesterlön, semesterlöneskuld, OB-tillägg, övertidsersättning, traktamente, milersättning, utlägg, F-skatt, A-skatt, FA-skatt, sjuklön, karensavdrag, löneväxling, bruttolöneavdrag, nettolöneavdrag, BAS 7xxx accounts, or any Swedish payroll compliance question. Also trigger when the user asks how to book salary, employer contributions, vacation pay, or sick pay in a Swedish context, or when implementing payroll calculations, AGI XML generation, or tax table lookups. This skill is a developer compliance oracle, not an end-user payroll guide.
---

# Swedish Payroll Compliance

Developer-facing compliance reference for building Swedish payroll software. This skill answers questions about statutory rates, filing obligations, benefit valuations, BAS account mappings, and calculation logic so you can verify your implementation is correct.

## How to use this skill

This skill has a router structure. The SKILL.md contains the most critical rules and rates you need constantly. Detailed reference material lives in `references/`. Read the relevant reference file when you need depth on a specific area.

### Reference files

| File | When to read |
|---|---|
| `references/agi-filing.md` | Questions about arbetsgivardeklaration (AGI), XML schema, field codes (fältkoder), filing deadlines, corrections, penalties, Skatteverket API submission |
| `references/social-charges.md` | Questions about arbetsgivaravgifter component breakdown, age-based reductions, egenavgifter, växa-stöd, forskningsavdrag, youth discount, thresholds (PBB/IBB/SGI) |
| `references/tax-tables.md` | Questions about skatteavdrag, skattetabeller, column system, jämkning, sidoinkomst, statlig inkomstskatt brytpunkt, Skatteverket tax table data format |
| `references/benefits.md` | Questions about förmånsbeskattning: bilförmån (all 3 formula generations, miljöbil reductions), kostförmån, friskvård, KPO, telefon/internet, bostadsförmån |
| `references/vacation-pay.md` | Questions about semesterlön, semesterlöneskuld, procentregeln, sammalöneregeln, semestertillägg, sparade dagar, intjänandeår, BAS 2920/7090 accounting |
| `references/ob-overtime.md` | Questions about OB-tillägg, övertid, Arbetstidslagen limits, CBA divisors, mertid, kompensationsledighet |
| `references/travel-expenses.md` | Questions about traktamente (domestic/international), tremånadersregeln, meal reductions, utlägg vs kostnadsersättning, milersättning, körjournal |
| `references/f-skatt.md` | Questions about F-skatt vs A-skatt vs FA-skatt, verification workflow, employer liability, Skatteverket Företagsuppgifter API |
| `references/bas-7xxx.md` | Questions about BAS kontoplan 7xxx salary accounts, balance sheet accounts (2710/2730/2920), standard monthly journal entry flow |
| `references/deductions-lonevaxling.md` | Questions about nettolöneavdrag vs bruttolöneavdrag processing order, löneväxling (1.058 factor), pension deductibility caps |
| `references/sick-pay.md` | Questions about sjuklön, karensavdrag calculation, day 2-14 at 80%, läkarintyg, återinsjuknande, Försäkringskassan day 15+, högkostnadsskydd |

Read multiple reference files when a question spans domains (common).

## Core rates and rules (always in context)

### Arbetsgivaravgifter: 31.42%

Total rate unchanged since 2009. Calculated on full gross salary + taxable benefits with no cap. Age tiers:

| Birth year condition | Rate |
|---|---|
| Born 1937 or earlier | 0% |
| Turned 66+ at year start (67+ from 2026) | 10.21% (only ålderspensionsavgift) |
| Standard (all others) | 31.42% |
| Temporary youth (Apr 2026 to Sep 2027) | 20.81% on salary up to 25,000 SEK/month. Eligible: vid årets ingång fyllt 18, inte 23 (i.e. age 18-22 at Jan 1; born 2003-2007 in 2026, 2004-2008 in 2027). NOT during-year age: Skatteverket rejects 23-year-olds at year start. Source: Prop. 2025/26:66 |

No avgifter required if total annual compensation from one employer < 1,000 SEK.

### AGI filing deadline

12th of month following pay period (17th in Jan/Aug for turnover ≤40 MSEK). Late = 625 SEK first offense, 1,250 SEK if repeated.

### Skatteavdrag lookup chain

kommun → total skattesats → round to table number (29-42) → select column (1-6 by employee category) → look up gross salary bracket → withholding amount. Sidoinkomst: flat 30%.

### Semesterlön

Procentregeln: 12% of semesterlönegrundande income. Sammalöneregeln: regular pay + 0.43% semestertillägg per day (many CBAs use 0.8%). Intjänandeår: Apr 1 - Mar 31 by law (often calendar year via CBA).

### Sjuklön (day 1-14)

Karensavdrag = 20% of one week's sjuklön (80% of weekly pay). Day 2-14: 80% of lost pay. Läkarintyg from day 8. Återinsjuknande within 5 days = same period continues.

### Traktamente (domestic)

2024-2025: 290 SEK/hel dag. 2026: 300 SEK/hel dag. Halv dag = 50%. After 3 months same location: 70%. After 2 years: 50%.

### Key thresholds 2025

| Parameter | Value |
|---|---|
| Prisbasbelopp (PBB) | 58,800 SEK |
| Inkomstbasbelopp (IBB) | 80,600 SEK |
| Max PGI (7.5 × IBB) | 604,500 SEK |
| SGI ceiling (10 × PBB) | 588,000 SEK |
| Friskvård tax-free cap | 5,000 SEK/year |
| Milersättning (own car) | 25 SEK/mil |
| Statlig skatt brytpunkt | 660,400 SEK/year (2026) |

### BAS 7xxx quick reference

| Range | Category |
|---|---|
| 7010-7090 | Löner kollektivanställda + semester |
| 7210-7290 | Löner tjänstemän/företagsledare + semester |
| 7321-7332 | Traktamente + bilersättningar |
| 7381-7385 | Förmåner (bostad, kost, bil) |
| 7410-7460 | Pensionskostnader |
| 7510-7533 | Arbetsgivaravgifter + SLP |
| 7571-7699 | Försäkringar + övriga personalkostnader |

### Standard monthly journal entries

1. Gross salary: Debit 7210 / Credit 2710 (tax) + Credit 1930 (net pay)
2. Employer avgifter: Debit 7510 / Credit 2730
3. Vacation accrual: Debit 7290 / Credit 2920
4. Avgifter on accrual: Debit 7519 / Credit 2940
5. Pension premiums: Debit 7410 / Credit 2440/2740
6. SLP on pensions: Debit 7533 / Credit 2514

### Processing order for gross-to-net

bruttolöneavdrag → förmånsvärden (reduced by nettolöneavdrag) → tax base → skattetabell lookup → net pay → nettolöneavdrag → utbetalat belopp. Arbetsgivaravgifter calculated on gross after bruttolöneavdrag but before nettolöneavdrag.

### Löneväxling factor

For every 1 SEK salary reduction: pension contribution = 1.058 SEK. Flag if post-reduction salary drops below ~54,204 SEK/month (8.07 × IBB / 12 for 2025).

### F-skatt verification

A-skatt: withhold tax + pay avgifter. F-skatt: neither. FA-skatt: split. No F-skatt stated: withhold 30% + full avgifter. Verify via Skatteverket before first payment.

## Rate update schedule

Rates shift annually with PBB, IBB, and SLR. Subscribe to Skatteverket's annual publications each December. Bilförmån formulas use SLR from November 30 of prior year (floor 0.50%). Kostförmån tied to PBB. Traktamente normalbelopp published annually.