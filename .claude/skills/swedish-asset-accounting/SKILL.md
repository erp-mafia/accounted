---
name: swedish-asset-accounting
description: >
  Swedish fixed asset accounting (anläggningsredovisning) reference. Covers planenlig avskrivning, överavskrivning (2150/8850),
  räkenskapsenlig (30%/20%) vs restvärdeavskrivning (25%), BAS 10xx-12xx/78xx mapping, inventarieregister per BFL,
  förbrukningsinventarier (half PBB), leasing K2/K3/IFRS 16, komponentavskrivning, avyttring/utrangering with VAT.
  Trigger on ANY Swedish avskrivning, anläggningstillgång, överavskrivning, inventarieregister, förbrukningsinventarie,
  BAS 10xx-12xx/78xx, leasing K2/K3, asset disposal, komponentavskrivning, or fixed-asset question.
  High-error-rate area; always use over training data.
---

# Swedish Asset Accounting (Anläggningsredovisning)

Developer compliance reference for Swedish fixed asset accounting. Core laws: ÅRL (1995:1554), IL (1999:1229), BFL (1999:1078). Frameworks: K2 (BFNAR 2016:10), K3 (BFNAR 2012:1), IFRS 16, RFR 2.

**Before answering any question, read the appropriate reference file:**

- For depreciation methods, överavskrivning, or tax depreciation rules: `cat references/depreciation.md`
- For BAS account mapping, anläggningsregister, or förbrukningsinventarier: `cat references/accounts-and-registry.md`
- For leasing treatment or disposal/scrapping: `cat references/leasing-and-disposal.md`

If the question spans multiple areas, read all relevant files.

## Quick Decision Tree

```
Is the asset below half prisbasbelopp (29,600 kr 2026) or useful life ≤ 3 years?
├─ YES → Expense immediately via 54xx (förbrukningsinventarie)
└─ NO → Capitalize to 10xx/11xx/12xx
         │
         Is it a building?
         ├─ YES → IL 19 kap rates (2-5% straight-line on cost)
         │        K2: no components, use SKV standard rates
         │        K3: mandatory component depreciation
         └─ NO → Machinery/inventory: IL 18 kap
                  ├─ Räkenskapsenlig: 30% declining or 20% straight-line (choose yearly)
                  └─ Restvärdeavskrivning: 25% declining (fallback)
                  │
                  Book ≠ Tax? → Bridge via 2150/8850 (överavskrivning)
```

## Critical K2 vs K3 Differences (Assets)

| Feature | K2 | K3 |
|---|---|---|
| Component depreciation | Forbidden | Mandatory |
| Useful life | 5-year default allowed | Individual assessment required |
| Residual value | Optional, forbidden with 5-year rule | Required, annual reassessment |
| Depreciation start | Year put into use | When available for use |
| Revaluation | Permitted for buildings/land | Permitted |
| Deferred tax | Forbidden | Required (ch. 29) |
| Leasing on BS | Never | Financial leases (but 20.29 exemption in juridisk person) |
| Development costs | Must expense | May capitalize |

## 2026 Regulatory Change

From fiscal years starting after 2025-12-31 (BFNAR 2025:2 amending K2; BFNAR 2025:3 amending K3):
- **Bostadsrättsföreningar and bostadsföreningar** may not use K2 regardless of size (K2 1.1A e) and apply K3, with its new chapter 38. This forces component depreciation.
- **Companies whose buildings generate ≥75% of net revenue**, or with a material uppskjuten skatteskuld, may not use K2 (1.1B), unless they exceed at most one of >3 employees, >1.5 MSEK balance sheet total, >3 MSEK net revenue (1.1C), or applied K2 the previous year and are not normally covered by 1.1B.
- Also excluded from K2: foreign filialer, aktierelaterade ersättningar, issued convertible or similar sammansatta finansiella instrument, kryptotillgångar (1.1A f-i).

## Prisbasbelopp Reference (Half PBB = förbrukningsinventarie threshold)

| Year | PBB | Threshold |
|---|---|---|
| 2024 | 57,300 | 28,650 |
| 2025 | 58,800 | 29,400 |
| 2026 | 59,200 | 29,600 |
| 2027 | 59,600 | 29,800 (calculated by SCB, not yet formally set) |