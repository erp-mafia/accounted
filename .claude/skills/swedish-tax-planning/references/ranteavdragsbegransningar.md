# Ränteavdragsbegränsningar (Interest Deduction Limitations)

## Legal basis
IL 24 kap. 21-29 §§ (generella regler), IL 24 kap. 16-20 §§ (riktade regler)

Implements the EU Anti-Tax Avoidance Directive (ATAD). Effective January 1, 2019.

## Two alternative ceilings

### EBITDA-regeln (24 kap. 24 § first paragraph)

Deduction of negativt räntenetto up to **30% of skattemässigt EBITDA** (avdragsunderlag).

Avdragsunderlag calculation (24 kap. 25 §):
- Start: skattemässigt resultat
- ADD: värdeminskningsavdrag, negativt räntenetto, avsättning till periodiseringsfond, certain non-deductible items
- SUBTRACT: återförd periodiseringsfond, tax-free dividends on näringsbetingade andelar, positivt räntenetto

Key interaction: periodiseringsfond avsättning INCREASES avdragsunderlag, which is beneficial.
Key interaction: koncernbidrag (lämnat) DECREASES avdragsunderlag, which is harmful.

### Förenklingsregeln (24 kap. 24 § second paragraph)

Deduction of negativt räntenetto up to **5 MSEK**.

Critical constraints:
- Applies per **intressegemenskap**, not per bolag
- If ANY company in the group uses this, the 5 MSEK cap covers the ENTIRE group
- Non-deductible amounts under förenklingsregeln **cannot be carried forward** (permanently lost)
- Cannot be combined with EBITDA-regeln within the same intressegemenskap

A proposal to raise the limit to 25 MSEK (lagrådsremiss "Förbättrade ränteavdragsregler för företag", June 2025) was not included in the 2026 budget and has not been enacted. IL 24 kap. 24 § still says 5 MSEK.

## Carry-forward (24 kap. 26 §)

Under EBITDA-regeln only: excess negativt räntenetto becomes **kvarstående negativt räntenetto**, carried forward for **6 years**. Lost upon ägarförändring.

## Definition of ränteutgifter (24 kap. 2 §)

Broad definition includes:
- Traditional ränta
- Financing costs, commitment fees, arrangement fees
- Interest component of financial leasing
- Hedged currency losses on loans
- Capitalized interest

## Riktade regler for koncerninterna lån (24 kap. 16-20 §§)

Additional restrictions BEFORE the generella regler apply:
- Ränteavdrag denied if arrangement "uteslutande eller så gott som uteslutande" (90-100%) arose to generate väsentlig skatteförmån
- Förvärvsregeln (24 kap. 19 §): underlying acquisition must be "väsentligen affärsmässigt motiverat"
- Following HFD 2021 ref. 68 and HFD 2024, partly incompatible with EU law
- Enacted from beskattningsår beginning after 2025-12-31 (IL 24 kap. 19 a §, SFS 2025:1333, prop. 2025/26:20): interest on debt to a company in the intressegemenskap is deductible when the company actually entitled to the interest income is resident in another EES state, unless the debt is part of a **konstlat upplägg** whose purpose is a väsentlig skatteförmån for the intressegemenskap (then denied wholly or partly)

## BAS accounts

| Account | Use |
|---------|-----|
| 8400/8410 | Räntekostnader (general) |
| 8310/8311 | Ränteintäkter |
| Separate sub-accounts | Koncerninterna vs externa räntor (essential for N9) |

## N9-blankett

Filed as bilaga to INK2 when negativt räntenetto exists. Reports:
- Ränteintäkter and ränteutgifter
- Negativt/positivt räntenetto
- Avdragsunderlag (EBITDA)
- Avdragsutrymme
- Kvarstående negativt räntenetto from prior years
- Choice of EBITDA-regeln vs förenklingsregeln

## Practical example

AB Alfa: skattemässigt resultat 10 MSEK, ränteintäkter 1 MSEK, ränteutgifter 6 MSEK, avskrivningar 3 MSEK, periodiseringsfond avsättning 2 MSEK, återföring 1 MSEK.

- Negativt räntenetto: 6 - 1 = 5 MSEK
- EBITDA = 10 + 5 + 3 + 2 - 1 = 19 MSEK
- Avdragsutrymme = 30% x 19 = 5.7 MSEK > 5 MSEK -> full deduction

## Circular dependency warning

Adjusting koncernbidrag after the EBITDA calculation creates circular dependencies. Koncernbidrag changes skattemässigt resultat, which changes EBITDA, which changes avdragsutrymme, which may change the optimal koncernbidrag. Iterative recalculation required.