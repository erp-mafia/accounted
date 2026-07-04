---
name: swedish-year-end-closing
description: >
  Swedish year-end closing (bokslut) for AB and Enskild firma. Covers legal framework (BFL/ÅRL/K2/K3), step-by-step closing with BAS account numbers, all bokslutstransaktioner, tax calculations (bolagsskatt, egenavgifter, räntefördelning, expansionsfond, periodiseringsfond), reporting (årsredovisning/NE-bilaga), filing deadlines, SIE4 export, K2 vs K3 differences, and compliance pitfalls. Trigger on bokslut, årsbokslut, årsredovisning, closing entries, resultatdisposition, year-end accruals, tax provisions, överavskrivningar, accounts 2099/2091/8910/8811/2512/21xx/29xx in closing context, or any question about closing books for a Swedish company. Also trigger for "how do I book tax at year-end", "periodiseringsfond AB vs EF", "deadline årsredovisning", "what accounts for accruals".
---

# Swedish Year-End Closing (Bokslut)

This skill provides everything needed to perform or implement a complete Swedish year-end closing for **Aktiebolag (AB)** and **Enskild firma**.

## Quick decision tree

1. **AB** → always årsredovisning → K2 (if mindre and eligible) or K3
2. **Enskild firma, revenue ≤ 3 MSEK** → K1 förenklat årsbokslut
3. **Enskild firma, revenue > 3 MSEK** → full årsbokslut (BFNAR 2017:3)

## Reference files

This skill contains detailed reference material split by topic. Read the relevant file(s) based on the user's question:

- **`references/legal-framework.md`**: BFL, ÅRL, K1/K2/K3 framework rules, entity obligations, större/mindre företag thresholds, 2026 K2 changes
- **`references/closing-process.md`**: Complete 8-phase closing process with BAS account numbers: avstämningar, periodiseringar, avskrivningar, lagervärdering, obeskattade reserver, avsättningar/skatt, equity handling, result closing
- **`references/journal-entries.md`**: All specific bokslutstransaktioner with debit/credit pairs for software implementation
- **`references/tax-calculations.md`**: Bolagsskatt for AB, egenavgifter/räntefördelning/expansionsfond/periodiseringsfond for enskild firma, schablonintäkt, schablonavdrag
- **`references/reporting-and-filing.md`**: Årsredovisning structure, NE-bilaga, filing deadlines, penalties, Bolagsverket/Skatteverket requirements, SIE4 export, audit thresholds
- **`references/k2-vs-k3.md`**: Implementation differences: component depreciation, deferred tax, intangibles, leasing, format restrictions, account visibility
- **`references/pitfalls-and-rates.md`**: Common mistakes, compliance traps, kontrollbalansräkning, and reference rate table (2025/2026)

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