import type { Skill } from './types'

const body = `# Year-End Close (Bokslut): Accounted

The annual close. Irreversible. Legally significant. Always staged for human approval.

## When to use

- "Run year-end" / "Bokslut för [år]"
- "Close FY[year]"
- After all monthly work is done: every business transaction in the year is booked
- Before årsredovisning filing to Bolagsverket (AB) or NE-bilaga (enskild firma)

**Do not run year-end during the year.** It zeros result accounts (3xxx-8xxx) into 2099 (årets resultat): only correct at the end of the räkenskapsår.

## What \`gnubok_run_year_end\` actually does

One staged operation, one approval, five effects (lib/core/bookkeeping/year-end-service.ts, executeYearEndClosing):

1. Revalues open foreign-currency items at the closing rate (3960/7960)
2. Posts the closing entry INTO the period (class 3-8 zeroed against 2099)
3. Locks the period
4. Closes the period (irreversible per BFL)
5. Creates or reuses the next period and posts its opening balances (class 1-2), then moves 2099 to 2098 in the new year

Consequence: **the period must be OPEN and UNLOCKED when you run it.** The closing entry is a journal entry dated on balansdagen; a period locked beforehand refuses it ("Cannot write to locked/closed fiscal period"), and \`gnubok_year_end_readiness\` / \`gnubok_run_year_end\` now refuse a pre-locked period up front (\`period_locked\` / PERIOD_LOCK_ALREADY_LOCKED). There is no separate lock, close or opening-balance step afterwards: those tools answer "already locked" / "already closed" once year-end has run.

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

### Step 2: Cash-method cut-off (kontantmetoden only)

For a company using kontantmetoden, first run

\`gnubok_post_kontantmetod_cutoff({ fiscal_period_id })\`.

It stages the exact customer-receivable and supplier-payable entries dated on the fiscal year end, plus their reversals on day one of the next period. Review every proposed line and approve with \`confirmed=true\`. The next fiscal period must already exist and be open. Re-run \`gnubok_year_end_readiness\` after approval: BFL 5 kap 2 § makes this a blocker, not an optional reminder.

### Step 3: Currency revaluation (if multi-currency)

Open foreign-currency receivables/payables (1510/2440 in EUR/USD/etc.) are revalued to the closing-date FX rate by \`gnubok_run_year_end\` itself (step 1 above). Run \`gnubok_run_currency_revaluation({ fiscal_period_id, closing_date })\` separately only if the user wants to review the FX result before the close. Posts to **3960** (kursvinster) and **7960** (kursförluster). One revaluation per period.

### Step 4: Readiness check

\`gnubok_year_end_readiness({ fiscal_period_id })\`. Resolve every blocker before going on: \`unbooked_transactions\` (the common one), \`draft_entries\`, \`unexplained_voucher_gap\`, \`sequence_mismatch\`, \`trial_balance_unbalanced\`, \`kontantmetod_cutoff_required\`, \`period_locked\` (unlock it: year-end locks the period itself), and the period-state kinds. **Do NOT call \`gnubok_lock_period\` here.** A lock is not a pre-flight for bokslut; it only freezes a period you are not about to close.

### Step 5: Run year-end (the only write)

\`gnubok_run_year_end({ fiscal_period_id })\` on the open, unlocked period: stages a high-risk operation. Surface the irreversibility, then approve with \`confirmed=true\`. After approval:

- Class 3-8 (revenue + expenses) zeroed into **2099** (årets resultat)
- Period locked AND closed (sealed forever, not even storno)
- Next period created (or reused) with opening balances posted and 2099 moved to 2098

### Step 6: Verify

- \`gnubok_list_fiscal_periods\`: the closed year shows \`is_closed\`, the next period exists
- \`gnubok_get_balance_sheet\` on the next period: opening balances equal the closed year's closing balances (IB/UB continuity)
- \`gnubok_get_income_statement\` on the closed year: the result that went to 2099

Nothing else to call. \`gnubok_set_opening_balances\`, \`gnubok_close_period\` and \`gnubok_lock_period\` are for the manual or legacy flow only (a period closed in another system, or a partial run that needs finishing by hand); after \`gnubok_run_year_end\` they refuse with "already closed" / "already locked".

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

- **Year-end is forever.** Once \`gnubok_run_year_end\` is approved, the period is closed and there is no rollback. \`gnubok_unlock_period\` cannot unlock a closed period: only one that is locked but not closed.
- **Run order matters.** bokslutstransaktioner → readiness → run_year_end on the OPEN period → verify. Locking first is the one ordering that fails.
- **K2 vs K3:** affects många bokslutsposter: start-up costs, leasing, immateriella tillgångar. The skill assumes K2 unless told otherwise.
- **Revisionsplikt:** AB with > 3 M SEK omsättning, > 1.5 M SEK BR-omslutning, > 3 employees (any 2 of 3, two consecutive years) need auditor: book the audit before close.

## Common errors

- **"Cannot write to locked/closed fiscal period" at approval, or \`period_locked\` in readiness**: the period was locked before year-end. \`gnubok_unlock_period\`, then \`gnubok_run_year_end\` again. Never lock first.
- **"Period is already closed" (PERIOD_ALREADY_CLOSED) from \`gnubok_close_period\` / \`gnubok_lock_period\`**: year-end already closed it. Not an error to fix: verify with \`gnubok_list_fiscal_periods\` and move on.
- **"Period is already locked" (PERIOD_LOCK_ALREADY_LOCKED) from \`gnubok_run_year_end\`**: same cause as the first item; unlock and re-run.
- **Forgetting periodiseringsfond reversal**: must reverse the oldest 6-year-old fond automatically. Skatteverket WILL catch this.
- **Skipping currency revaluation on FX exposure**: distorts BR; auditors flag.

## Tools

- \`gnubok_year_end_readiness\`: pre-flight (blockers + warnings)
- \`gnubok_post_kontantmetod_cutoff\`: stage the mandatory cash-method cut-off and reversals
- \`gnubok_run_year_end\`: closing entry + lock + close + next period IB, one approval
- \`gnubok_run_currency_revaluation\`: FX revaluation on its own, for review before the close
- \`gnubok_list_fiscal_periods\`: confirm the closed/open state afterwards
- \`gnubok_get_balance_sheet\`: verify post-year-end balances
- \`gnubok_get_income_statement\`: verify result before year-end JE
- \`gnubok_get_trial_balance\`: sanity check before the run
- \`gnubok_lock_period\`, \`gnubok_close_period\`, \`gnubok_set_opening_balances\`: manual/legacy flow only, never after \`gnubok_run_year_end\`
`

export const yearEndCloseSkill: Skill = {
  slug: 'year-end-close',
  name: 'Year-End Close (Bokslut)',
  summary: 'Annual close: bokslutstransaktioner, readiness check, then gnubok_run_year_end on the OPEN period (it locks, closes and seeds next-year IB itself). Irreversible.',
  tags: ['yearly', 'close', 'bokslut', 'compliance'],
  body,
  tier: 'workflow',
  // AB-specific. Sole traders (EF) use a different year-end path (NE-bilaga)
  // covered by a separate skill that we'll add when bokslut for EF lands.
  applicability: { entity_type: 'AB' },
}
