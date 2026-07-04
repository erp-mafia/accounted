# Tax Calculations: AB vs Enskild Firma

## Bolagsskatt for AB

Rate: **20.6%** (since January 1, 2021).

### Skattemässigt resultat calculation

Start from bokfört resultat, then adjust:

**Add back (ej avdragsgilla kostnader):**
- Representation (over deductible limits)
- Böter, skattetillägg
- Kostnadsränta on skattekonto
- Gåvor
- Bolagsbildningskostnader

**Subtract (ej skattepliktiga intäkter):**
- Utdelning from näringsbetingade andelar
- Intäktsränta on skattekonto

**Add:**
- Schablonintäkt on periodiseringsfonder
- Reversal of overused tax depreciation

**Subtract:**
- Prior-year losses (underskottsavdrag)

Round down to nearest 10 SEK before applying 20.6%.

### Schablonintäkt on periodiseringsfonder (AB)

Formula: total periodiseringsfonder at year-start × statslåneränta (SLR) from November 30 of preceding year (floor 0.5%).

- Beskattningsår ending 2025: **1.96%**
- Beskattningsår ending 2026: **2.55%**

This is a skattemässig justering ONLY. NEVER booked in accounting. Reported on INK2S field 4.6a.

### Transition rule for pre-2019 periodiseringsfonder

Funds created before 2019 (when rate was 22%) require **gross-up of 103-106%** on reversal to compensate for rate reduction. Handled only in tax calculation.

---

## Enskild firma: four unique tax mechanisms

An enskild firma is NOT a skattesubjekt. Owner pays tax personally via Inkomstdeklaration 1 + NE-bilaga.

### 1. Egenavgifter

Replace arbetsgivaravgifter for employees.

**Full rate (2025/2026):** 28.97% (born 1959 or later, active business, 7 karensdagar)

**NE-bilaga schablonavdrag logic:**
- R43: Schablonavdrag = **25%** of överskott before egenavgifter
- R40: Previous year's schablonavdrag added back
- R41: Actual egenavgifter charged previous year deducted
- Net effect: estimated deduction, reconciled following year

**Reduced rates:**
- Pensioners born 1938-1958: 10.21% rate, 10% schablonavdrag
- Passive businesses: SLP 24.26% instead, 20% schablonavdrag

**Additional nedsättning:** 7.5% (max 15,000 SEK/year) for active businesses with överskott > 40,000 SEK. Calculated automatically by Skatteverket.

### 2. Räntefördelning

Shifts calculated return on business capital from inkomstslaget näringsverksamhet (taxed at marginal rates up to ~55% including egenavgifter) to inkomstslaget kapital (flat 30%).

**Positive räntefördelning (voluntary):**
- Rate: SLR + 6 percentage points
- 2025: 7.96%, 2026: 8.55%
- Applied on positive kapitalunderlag
- From 2025: no minimum kapitalunderlag threshold (previously 50,000 SEK)

**Negative räntefördelning (mandatory):**
- Triggers when negative kapitalunderlag exceeds **500,000 SEK**
- Rate: SLR + 1 percentage point
- 2025: 2.96%, 2026: 3.55%

**Kapitalunderlag** = adjusted eget kapital in the business at previous year-end.

Handled in NE-bilaga only, NEVER booked.

### 3. Expansionsfond

Gives sole traders equivalent of AB's ability to retain earnings at corporate tax rate.

- Owner pays **20.6% expansionsfondsskatt** on avsättning
- Max avsättning: **125.94%** of kapitalunderlag at year-end
- **No mandatory 6-year reversal** (can be held indefinitely)
- On reversal: amount added back as NV income, previously paid 20.6% credited against that year's tax

Handled exclusively in NE-bilaga (R33/R34), NEVER booked.

### 4. Periodiseringsfond (Enskild firma)

- Max deferral: **30%** of result (vs 25% for AB)
- Same 6-year mandatory reversal
- **No schablonintäkt** for fysiska personer
- Handled only in NE-bilaga (R29/R30), NEVER booked

---

## Critical distinction: booked vs declaration-only

| Item | AB | Enskild firma |
|------|-----|---------------|
| Periodiseringsfond | **Booked** (8811/21xx) | Declaration only (NE R29/R30) |
| Överavskrivningar | **Booked** (8850/2150) | **Booked** (8850/2150) |
| Skatt på årets resultat | **Booked** (8910/2512) | NOT booked (personal tax) |
| Schablonintäkt periodiseringsfond | Declaration only (INK2S 4.6a) | N/A |
| Räntefördelning | N/A | Declaration only |
| Expansionsfond | N/A | Declaration only |
| Egenavgifter schablonavdrag | N/A | Declaration only |