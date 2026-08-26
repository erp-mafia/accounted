---
name: swedish-vat
description: >
  Swedish VAT (moms) compliance reference. Covers momsredovisning periods/deadlines, EU VAT (omvänd skattskyldighet, reverse charge, tjänstehandel, varuhandel, trepartshandel, OSS), import/export moms, representation moms (300 SEK cap), mixed verksamhet (proportionell avdragsrätt, HFD 2023 ref. 45), jämkning of input VAT on capital goods, frivillig skattskyldighet for uthyrning, momsdeklaration Ruta 05-62 to BAS 26xx mapping, complete BAS 26xx series, error patterns, penalties, and law references (ML 2023:200, SFL, EU VAT Directive). Trigger on ANY Swedish moms/VAT question, momsdeklaration, EU trade VAT, reverse charge, representation, blandad verksamhet, jämkning, BAS 2610-2670, rutor 05-62, "vilken momskod", "hur bokför jag moms", "omvänd moms", "EU-moms", "importmoms". Highest-error-rate area in Swedish bookkeeping; always use this skill over training data.
---

# Swedish VAT (Moms) Compliance Skill

This skill provides authoritative compliance reference for Swedish VAT. It is the **single highest-error-rate area** in Swedish bookkeeping.

## When to use

Always read the full reference before answering ANY question about:

- Momsredovisning periods, thresholds, deadlines
- EU VAT: reverse charge, intra-EU goods/services, triangulation, OSS
- Import/export VAT
- Representation moms (deduction limits, BAS accounts)
- Mixed activities (proportional deduction, HFD 2023 ref. 45)
- Jämkning (adjustment of input VAT on capital goods)
- Frivillig skattskyldighet for property rental
- Momsdeklaration field-to-BAS account mapping
- BAS 26xx account usage
- VAT error patterns, penalties, skattetillägg

## How to use

1. **Read the full reference first:** `view /path/to/this/skill/references/vat-compliance-reference.md`
2. Find the relevant section for the user's question
3. Provide precise answers with account numbers, ruta numbers, legal references, and thresholds
4. Flag common error patterns relevant to the user's scenario

## Quick reference: VAT rates

| Rate | Applies to |
|------|-----------|
| 25% | Default rate, most goods and services |
| 12% | Food, hotel, restaurant, camping (drops to 6% for food from April 2026) |
| 6% | Books, newspapers, transport, cultural events, sports, repairs (bicycles/shoes/clothing), dance events (tillträde till danstillställningar, from 1 July 2026; 25% through 30 June 2026) |
| 0% | Exports outside EU, intra-EU supplies (with conditions) |

## Quick reference: Key BAS accounts

| Account | Purpose | Momsdeklaration |
|---------|---------|-----------------|
| 2611 | Utgående moms domestic 25% | Ruta 10 |
| 2614 | Utgående moms reverse charge 25% | Ruta 30 |
| 2615 | Utgående moms import 25% | Ruta 60 |
| 2641 | Debiterad ingående moms | Ruta 48 |
| 2645 | Beräknad ingående moms förvärv utlandet | Ruta 48 |
| 2650 | Momsredovisningskonto (clearing) | Ruta 49 |

## Quick reference: Reporting thresholds

| Annual beskattningsunderlag | Default period |
|----------------------------|----------------|
| ≤ 1M SEK | Annual |
| > 1M - ≤ 40M SEK | Quarterly |
| > 40M SEK | Monthly |

## Critical error patterns to flag

1. **2611 vs 2614**: Reverse charge output VAT must go to 2614 (Ruta 30), never 2611 (Ruta 10)
2. **One-sided reverse charge**: Both output AND input VAT must be booked; silent netting is prohibited
3. **Import double-counting**: Since 2015, VAT-registered businesses report import VAT to Skatteverket only, not Tullverket
4. **Representation**: VAT deductible on 300 SEK base; income tax deduction abolished for meals since 2017
5. **Period-end clearing**: All 261x-264x must clear to 2650; residual balances cause reconciliation failures

For the complete reference with all account mappings, legal citations, formulas, and detailed rules, read:
`references/vat-compliance-reference.md`