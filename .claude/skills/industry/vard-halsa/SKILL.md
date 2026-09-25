---
id: vertical/vard-halsa
tier: vertical
title: "Vård, tandvård & skönhet (SNI 86 / 96.02 / 96.04)"
description: >
  SNI 86, 96.02, 96.04. Swedish accounting for healthcare, dental care and beauty services (vård, tandvård, skönhet). Covers the VAT exemption in ML 2023:200 10 kap 6-13 §§ (sjukvård och tandvård) och 14 § (social omsorg): what counts as sjukvård, the 22 legitimerade yrken, the medical vs aesthetic boundary for botox, fillers, laser and tandblekning with the evidence it needs, uthyrning av vårdpersonal after HFD 2018 ref. 41, intyg, företagshälsovård, massage, and taxable goods such as glasögon; plus running a mixed clinic: direct attribution before apportionment, 95 %-reglerna, keys after HFD 2023 ref. 45, justering of input VAT, why frivillig beskattning is unavailable when letting to an exempt tenant, equipment and the non-deductible VAT trap on the half-PBB limit, kassaregister for kropps- och skönhetsvård, patient and regional payments, and a monthly checklist. Trigger on momsfri vård, sjukvård moms, tandvård, estetisk behandling, personaluthyrning vård, blandad verksamhet, klinik, skönhetssalong.
sni_prefixes: ["86.10", "86.21", "86.22", "86.23", "86.90", "96.02", "96.04"]
trigger_signals:
  text_patterns:
    - "momsfri vård"
    - "sjukvård"
    - "tandvård"
    - "legitimerad"
    - "estetisk behandling"
    - "botox"
    - "filler"
    - "personaluthyrning"
    - "blandad verksamhet"
    - "klinik"
    - "skönhetssalong"
    - "högkostnadsskydd"
    - "frikort"
    - "vårdval"
  bas_account_signals:
    - "2649"
    - "3004"
    - "3620"
version: 1
---

# Swedish Healthcare, Dental and Beauty Accounting

> Provenance: imported 2026-09-24 from github.com/erp-mafia/swedish-accounting-skills (swedish-industry-vard, commit c11b295); this repository is now the canonical source.

Almost every hard question in this industry is the same question: is this supply exempt from VAT, and if the clinic has both exempt and taxable supplies, how much input VAT may it deduct. Get those right and the rest is ordinary bookkeeping.

Account numbers follow **BAS 2026**.

## How to use this skill

| File | When to read |
|---|---|
| `references/momsfri-vard.md` | Is this supply exempt? The exemption in ML 10 kap 6-13 §§ och 14 §, the two routes to it, legitimation, the medical versus aesthetic boundary per treatment, uthyrning av vårdpersonal, adjacent services, goods and packages, with a decision table |
| `references/blandad-verksamhet-vard.md` | Running a mixed clinic: splitting input VAT, the 95 % rules, apportionment keys, justering, premises, equipment, payroll, kassaregister and personalliggare, patient and public-payer payments, monthly checklist |

## The two tests for exemption

1. **Is the measure health care?** Something done to prevent, investigate or treat illness, physical injury or defect, or care during childbirth.
2. **Who performs it, and where?** Provided at a facility covered by the health care rules, or by someone with a licensed profession acting within it.

Both must hold. A licensed nurse doing purely cosmetic work is taxable; a medically motivated treatment performed by an unlicensed person outside a care facility is taxable too. The purpose is judged per treatment and per patient, which is why the documentation matters.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| Botox, fillers, laser or similar | The same treatment can be exempt or taxable depending on the medical purpose | Ask for the indication and who assessed it, and check that it is documented in the journal |
| A doctor or nurse invoicing through their own company | Hiring out staff is taxable; providing care under one's own responsibility can be exempt | Ask who carries the medical responsibility and who the patient's counterparty is |
| A clinic that also sells products | It becomes blandad verksamhet, and input VAT must be split | Ask for the taxable share of turnover before deducting anything |
| Rent for clinic premises | A landlord cannot add VAT when letting to an exempt tenant | Ask whether the lease shows VAT, and why |
| Equipment bought partly for taxable use | Non-deductible VAT is part of the cost, which can push it over the direct-expensing limit | Ask about the intended mix before deciding cost or asset |

## Related skills

| Question | Skill |
|---|---|
| General VAT rules, blandad verksamhet in depth, jämkning | `swedish-vat` |
| Invoice content and patient invoicing | `swedish-invoice-compliance` |
| Kassaregister and personalliggare duties | `swedish-cash-register` |
| Staff benefits, friskvård, jour and beredskap | `swedish-payroll` |
| Equipment, leasing, depreciation | `swedish-asset-accounting` |
| Everyday kontering of costs and card payouts | `swedish-daily-bookkeeping` |
