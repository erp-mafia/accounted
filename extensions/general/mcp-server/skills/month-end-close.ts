import type { Skill } from './types'

const body = `# Month-End Close: Accounted

Run this at the end of each calendar month to ensure books are clean before locking the period.

## When to use

Trigger this workflow when the user says any of:

- "Close out [month]"
- "Stäng [månad]"
- "Month-end close"
- "Lock [period]"

Run it on the **last business day** of the month (or first business day of the next month). Locking too early prevents legitimate late entries; locking too late risks period-skew on VAT filings.

## Workflow

### Step 1: Book every business transaction

Goal: zero uncategorized business transactions inside the period.

1. Call \`gnubok_list_uncategorized_transactions\` to see what's outstanding.
2. For each, call \`gnubok_suggest_categories\` (batches of up to 20) to get high-confidence proposals.
3. Stage categorizations via \`gnubok_categorize_transaction\` (or, for income that matches an invoice, \`gnubok_match_transaction_to_invoice\`).
4. Review and approve the exact staged preview through the supported approval surface. Staging is an Accounted control; BFL requires complete, traceable accounting, not this particular UI.

Reconcile issued and received invoices, credits, unpaid receivables/payables, owner-paid purchases, advances and non-cash adjustments too. Under faktureringsmetoden, absence of a bank payment does not justify omitting a known invoice.

A genuinely personal-account import with no company event may be excluded. A real movement in an AB's bank account must remain accounted for even if its purpose is private: establish the lawful treatment (for example remuneration, reimbursement or another evidenced event), including shareholder-loan restrictions. Do not use \`category: 'private'\` to silently remove company cash movements.

### Step 2: Reconcile bank

Run \`gnubok_get_reconciliation_status\` for the month's date range. The result includes \`bank_balance\`, \`ledger_balance\`, and \`difference\`. Any non-zero difference means unmatched transactions or missing JEs: investigate before locking.

### Step 3: Check voucher gaps

Run \`gnubok_list_voucher_gaps\` for the fiscal period. **Every gap must have an explanation** per BFNAR 2013:2. Use \`gnubok_explain_voucher_gap\` to document each one (e.g., "Voucher number reserved but not used because invoice was cancelled before posting").

### Step 4: Run VAT report (monthly filers)

If the company files VAT monthly (beskattningsunderlag > 40M SEK, or voluntarily), run \`gnubok_get_vat_report\` with \`period_type: 'monthly'\`. Sanity-check ruta49 ("att betala/återfå"). Use \`gnubok_vat_review_widget\` for a visual review.

If quarterly or annual filer: skip: VAT happens on its own cadence (see the quarterly-vat-review skill).

### Step 5: Review the requested lock scope

A monthly review does not automatically authorize locking the entire fiscal year. Verify the scope of \`fiscal_period_id\` and the deployed lock tool before proposing a lock. Keep the period open for remaining adjustments and an intended year-end run. For an explicitly requested and reviewed fiscal-period lock, stage \`gnubok_lock_period(fiscal_period_id)\`. The tool refuses if any business transactions remain unbooked. After user approval, no new entries can be posted into the period: late corrections must use \`gnubok_unlock_period\` (also high-risk, also staged).

## Critical rules

- **Never delete journal entries.** Use \`gnubok_uncategorize_transaction\` (storno reversal) to undo. DB triggers enforce this: direct deletes will fail.
- **Posted entries are immutable.** Once a JE is posted, even amounts are locked. Use \`correctEntry\` (web app) for corrections.
- **Money math:** use the project money/rounding helpers for software and decimal arithmetic for independent controls. Do not introduce a second rounding convention.
- **Locking ≠ closing.** Locking blocks new entries; closing (after year-end) is irreversible. This skill stops at locking.

## Common errors

- **"Period must be locked before closing"**: \`gnubok_close_period\` requires \`gnubok_lock_period\` first AND the year-end closing entry. Don't try to close mid-year periods.
- **"Cannot lock period: N business transactions unbooked"**: Step 1 wasn't complete. Re-run \`gnubok_list_uncategorized_transactions\`.

## Tools

- \`gnubok_list_uncategorized_transactions\`: find unbooked transactions
- \`gnubok_suggest_categories\`: get categorization proposals (batch of 20)
- \`gnubok_categorize_transaction\`: stage a single categorization
- \`gnubok_match_transaction_to_invoice\`: apply income to a customer invoice
- \`gnubok_get_reconciliation_status\`: bank vs ledger balance
- \`gnubok_list_voucher_gaps\`: BFNAR 2013:2 audit check
- \`gnubok_explain_voucher_gap\`: document a gap
- \`gnubok_get_vat_report\`: momsdeklaration data
- \`gnubok_vat_review_widget\`: interactive VAT review
- \`gnubok_lock_period\`: stage period lock
- \`gnubok_uncategorize_transaction\`: undo a categorization (storno)
`

export const monthEndCloseSkill: Skill = {
  slug: 'month-end-close',
  name: 'Month-End Close',
  summary: 'End-of-month workflow: book transactions, reconcile bank, verify voucher gaps, file VAT (monthly filers), lock period.',
  tags: ['monthly', 'close', 'reconciliation', 'vat'],
  body,
  tier: 'workflow',
  // Universal: both AB and EF run a monthly close. VAT step is conditional
  // inside the body so non-VAT-registered companies aren't blocked.
  applicability: { entity_type: 'both' },
}
