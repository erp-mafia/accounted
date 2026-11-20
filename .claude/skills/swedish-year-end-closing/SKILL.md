---
name: swedish-year-end-closing
description: >
  Swedish year-end closing (bokslut) for AB and Enskild firma. Covers legal framework (BFL/ÅRL/K1/K2/K3), step-by-step closing with BAS account numbers, bokslutstransaktioner, tax calculations (bolagsskatt, egenavgifter, räntefördelning, expansionsfond, periodiseringsfond), reporting (årsredovisning/NE-bilaga), filing deadlines, SIE4 export, K2 vs K3 differences, förenklat årsbokslut K1 (BFNAR 2006:1, B-poster, R-poster, U-poster, BAS 2018 förenklat, NE-blankett mapping), and compliance pitfalls. Trigger on bokslut, årsbokslut, årsredovisning, förenklat årsbokslut, K1, BFNAR 2006:1, B-poster B1-B16, R-poster R1-R11, U-poster U1-U4, BAS 2018 förenklat, NE-blankett mapping, closing entries, resultatdisposition, accruals, tax provisions, överavskrivningar, accounts 2099/2091/8910/8811/2512/21xx/29xx, or any question about closing books for a Swedish company. Also "periodiseringsfond AB vs EF", "deadline årsredovisning", "K1 vs fullt årsbokslut".
---

# Swedish Year-End Closing (Bokslut)

This skill provides everything needed to perform or implement a complete Swedish year-end closing for **Aktiebolag (AB)** and **Enskild firma**.

## Quick decision tree

1. **AB** → always årsredovisning → K2 (if mindre and eligible) or K3
2. **Enskild firma, revenue ≤ 3 MSEK** → **K1 förenklat årsbokslut** (BFNAR 2006:1): see `references/k1-forenklat-arsbokslut.md`. Critical: P-fond and expansionsfond must NEVER be booked in räkenskaperna for EF (only as upplysning U1/U2); the opposite of AB. NE-bilaga handles the avdrag.
3. **Enskild firma, revenue > 3 MSEK** → full årsbokslut (BFNAR 2017:3)

## Reference files

This skill contains detailed reference material split by topic. Read the relevant file(s) based on the user's question:

- **`references/legal-framework.md`**: BFL, ÅRL, K1/K2/K3 framework rules, entity obligations, större/mindre företag thresholds, 2026 K2 changes
- **`references/closing-process.md`**: Complete 8-phase closing process with BAS account numbers: avstämningar, periodiseringar, avskrivningar, lagervärdering, obeskattade reserver, avsättningar/skatt, equity handling, result closing
- **`references/journal-entries.md`**: All specific bokslutstransaktioner with debit/credit pairs for software implementation
- **`references/tax-calculations.md`**: Bolagsskatt for AB, egenavgifter/räntefördelning/expansionsfond/periodiseringsfond for enskild firma, schablonintäkt, schablonavdrag
- **`references/reporting-and-filing.md`**: Årsredovisning structure, NE-bilaga, filing deadlines, penalties, Bolagsverket/Skatteverket requirements, SIE4 export, audit thresholds
- **`references/k2-vs-k3.md`**: Implementation differences: component depreciation, deferred tax, intangibles, leasing, format restrictions, account visibility, K2 accrual rules (2.4/2.4A/2.4B/7.9), K2 changes from BFNAR 2025:2, K3 BFNAR 2025:3, årsbokslut BFNAR 2026:1
- **`references/pitfalls-and-rates.md`**: Common mistakes, compliance traps, kontrollbalansräkning, and reference rate table (2025/2026)
- **`references/k1-forenklat-arsbokslut.md`**: K1 förenklat årsbokslut (BFNAR 2006:1): applicability (3 MSEK threshold), kontantmetoden vs faktureringsmetoden, B1-B16/R1-R11/U1-U4 struktur with BAS 2018 förenklat kontoplan mappings, K1 värderingsregler (inventarier, lager, skogskonto), NE-bilaga mapping, värdering at avveckling, and a distilled praktikfall

## How to use this skill

When a user asks a bokslut question:

1. Identify whether it's about AB or Enskild firma (or both)
2. Identify which phase/topic the question relates to
3. Read the relevant reference file(s)
4. Answer with specific BAS account numbers and journal entries where applicable
5. Flag K2 vs K3 differences when relevant
6. Include current rates/thresholds from the rates table

Always distinguish between items that are **booked** in the accounting vs items that exist **only in the tax declaration**:
- **Booked**: överavskrivningar, periodiseringsfond (AB only), skatt på årets resultat (AB only)
- **Declaration only**: periodiseringsfond (EF), expansionsfond, räntefördelning, schablonintäkt on periodiseringsfond, egenavgifter schablonavdrag