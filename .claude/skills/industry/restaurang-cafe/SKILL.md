---
id: vertical/restaurang-cafe
tier: vertical
title: "Restaurang & café (SNI 56)"
description: >
  SNI 56.10, 56.21, 56.29, 56.30. Swedish accounting for restaurants and cafés (restaurang och café). Covers the VAT rate split as it stands in 2026: servering 12 %, food sold for avhämtning 6 % during the temporary reduction (2026-04-01 to 2027-12-31, SFS 2026:118/119, back to 12 % on 2028-01-01), alcohol 25 % either way, plus the servering vs avhämtning boundary, packaging and delivery, catering, delivery platforms, tap water vs bottled water, personalmåltider and uttagsbeskattning, free meals and samples, presentkort, lunchkuponger and lunch cards, rabatter and bundles spanning rates; and operations: serveringstillstånd and its record-keeping, kassaregister and personalliggare with what a kontrollbesök looks at, svinn and inventering, OB, minderåriga and jour, dricks, industry costs and assets, and the key ratios to sanity-check. Trigger on restaurang, café, servering, avhämtning, take-away, catering, dricks, personalmåltid, serveringstillstånd, lunchkupong, matmoms, or booking a restaurant's day.
sni_prefixes: ["56.10", "56.21", "56.29", "56.30"]
trigger_signals:
  text_patterns:
    - "servering"
    - "avhämtning"
    - "take-away"
    - "catering"
    - "dricks"
    - "personalmåltid"
    - "serveringstillstånd"
    - "lunchkupong"
    - "matmoms"
    - "Z-rapport"
    - "kassaregister"
    - "personalliggare"
    - "Wolt"
    - "Foodora"
    - "Uber Eats"
  bas_account_signals:
    - "1686"
    - "1910"
    - "2421"
    - "2621"
    - "2631"
    - "3001"
    - "3002"
    - "3003"
    - "6050"
version: 1
---

# Swedish Restaurant and Café Accounting

> Provenance: imported 2026-09-24 from github.com/erp-mafia/swedish-accounting-skills (swedish-industry-restaurang, commit c11b295); this repository is now the canonical source.

The hard part is the till, not the ledger. One basket can carry three VAT rates, and the boundary between serving and take-away moves with how the food is sold rather than what it is.

Account numbers follow **BAS 2026**. Domestic sales sit on **3000** with **3001-3004** by rate, unchanged from earlier BAS years.

## How to use this skill

| File | When to read |
|---|---|
| `references/moms-och-forsaljning.md` | The sales side: the 6/12/25 split and its dates, servering vs avhämtning, packaging and delivery, catering and platforms, alcohol, personalmåltider, vouchers and lunch cards, discounts across rates, a worked day |
| `references/drift-och-personal.md` | Running the place: serveringstillstånd and its records, kassaregister and personalliggare, kontrollbesök, svinn and inventering, OB and minderåriga, dricks, industry costs and assets, key ratios |

## The rate, right now

| Sale | Rate | Until |
|---|---|---|
| Serving on the premises | 12 % | unchanged |
| Food sold for avhämtning | 6 % | 2027-12-31, then 12 % again |
| Alcohol, served or to take away | 25 % | unchanged |
| Bottled water | 6 % | with the food reduction |
| Tap water sold separately | 25 % | unchanged |

The reduction is temporary. Anything written for a period starting 2028 should use 12 % for food again.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| A café with seating and a take-away counter | Both rates apply in the same day, and the till must split them | Ask how the till is configured before trusting a Z-report total |
| Delivery through a platform | Who sells to the guest, and what the commission and payout mean, differ by platform | Ask for the platform's settlement report |
| Staff meals | They trigger uttagsbeskattning and a benefit value | Ask how many meals and whether staff pay anything |
| A gift card | Single- and multi-purpose vouchers are taxed at different moments | Ask what the card can be used for |
| Tips | Whether they are the company's income and whether they are salary depends on how they reach the staff | Ask who distributes them |

## Related skills

| Question | Skill |
|---|---|
| The till, Z-reports, växelkassa, kassadifferens | `swedish-cash-register` |
| VAT rules and the food boundary in depth | `swedish-vat` |
| Stock of food and drink, shrinkage, inventering | `swedish-inventory` |
| OB, overtime, benefits and payroll on tips | `swedish-payroll` |
| Kitchen equipment, leasing, depreciation | `swedish-asset-accounting` |
| Everyday kontering, card payouts, supplier invoices | `swedish-daily-bookkeeping` |
