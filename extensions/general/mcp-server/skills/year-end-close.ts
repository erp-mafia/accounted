import type { Skill } from './types'

const body = `# Year-End Close (Bokslut): Accounted

The annual close. Irreversible. Legally significant. Always staged for human approval.

## When to use

- "Run year-end" / "Bokslut för [år]"
- "Close FY[year]"
- After all monthly closes are done and the last period is locked
- Before årsredovisning filing to Bolagsverket (AB) or NE-bilaga (enskild firma)

**Do not run year-end during the year.** It zeros result accounts (3xxx-8xxx) into 2099 (årets resultat): only correct at the end of the räkenskapsår.

## Workflow

### Step 1: Bokslutstransaktioner (accrual entries)

Before running year-end, post any year-end adjusting entries via the web app:

- **Förutbetalda kostnader / upplupna intäkter** (1700/1800-series accruals)
- **Avskrivningar** (depreciation): planenlig + räkenskapsenlig 30 % / 20 % rule, or restvärde 25 %
- **Periodiseringsfond** (AB only, max 25 % of överskott av näringsverksamhet **before** this year's avsättning per IL 30 kap.; 6-year mandatory reversal, oldest fond reversed first)
- **Överavskrivning** (2150/8850: bokföringsmässig avskrivning beyond skattemässig)
- **Lagervärdering** (lägsta värdets princip)
- **Skuld till företagaren / egenavgifter** (enskild firma)

These are not staged via MCP today: direct in web UI. The skill is to remind the user.

### Step 2: Currency revaluation (if multi-currency)

If the company has open foreign-currency receivables/payables (1510/2440 in EUR/USD/etc.), revalue to closing-date FX rate via \`gnubok_run_currency_revaluation({ fiscal_period_id, closing_date })\`. Posts to **3960** (kursvinster) and **7960** (kursförluster). One revaluation per period.

### Step 3: Lock the period

\`gnubok_lock_period(fiscal_period_id)\`. Required before year-end. Refuses if business transactions are unbooked.

### Step 4: Run year-end

\`gnubok_run_year_end(fiscal_period_id)\`: stages a high-risk operation. After approval:

- Class 3-8 (revenue + expenses) zeroed into **2099** (årets resultat)
- Period flagged \`is_year_end_complete\`
- Next period created automatically

### Step 5: Set opening balances

\`gnubok_set_opening_balances({ closed_period_id, next_period_id })\`. Copies class 1-2 closing balances into the next period as opening balances. Stage → approve.

### Step 6: Close (final, irreversible)

\`gnubok_close_period(fiscal_period_id)\`. Once approved, the period is sealed forever. **No more entries possible, not even via storno.**

## Tax provisions to compute (AB)

After year-end JE but before filing INK2:

- **Bolagsskatt 20.6 %** of skattemässigt resultat (since 2021). Posted to 8910 → 2510.
- **Periodiseringsfond:** max 25 % of överskott **before this year's avsättning** (IL 30 kap.). 6-year mandatory reversal; oldest fond reversed first to avoid statutory return.
- **Räkenskapsenlig avskrivning:** must be applied consistently: switching method requires Skatteverket approval.

## Tax provisions (Enskild firma)

- **Egenavgifter** (28.97 % normal, 10.21 % age 66+): reserves for next year's tax.
- **Räntefördelning** (positive at 7.94 % on capital underlag 2025; 50 000 SEK floor).
- **Expansionsfond** (max equity capital × 1.4; reversed when withdrawn).

These compute with \`gnubok_get_kpi_report\` for inputs but the actual tax JE is web-UI today.

## Critical rules

- **Year-end is forever.** Once \`gnubok_close_period\` succeeds, there is no rollback. \`gnubok_unlock_period\` cannot unlock a closed period: only one that is locked but not closed.
- **Run order matters.** lock → year-end → opening balances → close. Any other order fails.
- **K2 vs K3:** affects många bokslutsposter: start-up costs, leasing, immateriella tillgångar. The skill assumes K2 unless told otherwise.
- **Revisionsplikt:** AB with > 3 M SEK omsättning, > 1.5 M SEK BR-omslutning, > 3 employees (any 2 of 3, two consecutive years) need auditor: book the audit before close.

## Common errors

- **"Period must be locked before closing"**: Step 3 missed.
- **"Year-end closing entry must exist"**: Step 4 missed.
- **Forgetting periodiseringsfond reversal**: must reverse the oldest 6-year-old fond automatically. Skatteverket WILL catch this.
- **Skipping currency revaluation on FX exposure**: distorts BR; auditors flag.

## Tools

- \`gnubok_lock_period\`: pre-flight before year-end
- \`gnubok_run_year_end\`: zero result accounts
- \`gnubok_set_opening_balances\`: seed next period
- \`gnubok_run_currency_revaluation\`: FX revaluation
- \`gnubok_close_period\`: final, irreversible
- \`gnubok_get_balance_sheet\`: verify post-year-end balances
- \`gnubok_get_income_statement\`: verify result before year-end JE
- \`gnubok_get_trial_balance\`: sanity check before each step
`

export const yearEndCloseSkill: Skill = {
  slug: 'year-end-close',
  name: 'Year-End Close (Bokslut)',
  summary: 'Annual close: bokslutstransaktioner, currency revaluation, lock → year-end → opening balances → close. Irreversible.',
  tags: ['yearly', 'close', 'bokslut', 'compliance'],
  body,
  tier: 'workflow',
  // AB-specific. Sole traders (EF) use a different year-end path (NE-bilaga)
  // covered by a separate skill that we'll add when bokslut for EF lands.
  applicability: { entity_type: 'AB' },
}
