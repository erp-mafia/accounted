import type { Skill } from './types'

const body = `# Bank Reconciliation: Accounted

Reconcile the company's bank statements against the bookkeeping ledger so that the cash position in the books matches the bank. Run at month-end and before VAT close.

## When to use

- "Stäm av banken"
- "Reconcile the bank account"
- "Why doesn't my 1930 balance match the bank?"
- Mid-month spot-check before tax filings

## Choosing the right matching/linking tool

Accounted has several reconciliation tools because the *right* one depends on what
you already have in hand. Decide along two axes (**what you're connecting** and
**whether a verifikat already exists**) then pick:

| You have… | …and the entry is | Use |
|---|---|---|
| One bank tx + one customer invoice | not yet booked | \`gnubok_match_transaction_to_invoice\` |
| One bank receipt covering many invoices (customer **or** supplier) | not yet booked | \`gnubok_match_batch_allocate\` (samlingsbetalning, BFL 5 kap 6§) |
| A whole period of unmatched income to clear | not yet booked | \`gnubok_auto_match_period\` (run \`dry_run=true\` first) |
| One bank tx whose affärshändelse you already posted manually | already booked | \`gnubok_link_transaction_to_journal_entry\` |
| A customer invoice you know is paid, payment already in a verifikat | already booked | \`gnubok_find_voucher_candidates_for_invoice\` → \`gnubok_link_invoice_to_voucher\` |
| A supplier invoice paid, payment already in a verifikat | already booked | \`gnubok_find_voucher_candidates_for_supplier_invoice\` → \`gnubok_link_supplier_invoice_to_voucher\` |
| A receipt/document to file against a tx (no new bokföring) | n/a | \`gnubok_attach_document_to_transaction\` |
| Income you're sure is paid but with no bank line to point at | not yet booked | \`gnubok_mark_invoice_as_paid\` |

Rule of thumb: **match_\*** creates the payment bokföring; **link_\*** attaches to
bokföring that already exists (no new verifikat). Every one of these stages a
pending operation: the user approves before anything posts.

### Kontantmetoden vs faktureringsmetoden

The settlement posting differs by the company's \`accounting_method\` (read it from
\`gnubok_get_agent_briefing\`: \`accrual\` = faktureringsmetoden, \`cash\` =
kontantmetoden; null defaults to accrual):

- **Faktureringsmetoden (accrual):** revenue was booked at invoice time against
  kundfordran **1510**. Payment **credits 1510** and debits the bank (19xx). The
  link/match tools settle 1510.
- **Kontantmetoden (cash):** no receivable was raised at invoice time. Payment
  **debits 19xx** and books the revenue + moms now.

You usually don't pass the method explicitly: the tools resolve it from company
settings, but knowing it lets you sanity-check the staged preview's accounts
before approving (1510 movement under accrual; revenue/moms under cash).

## Workflow

### Step 1: Pull the reconciliation status

\`gnubok_get_reconciliation_status\` returns the current state per bank account:
matched count, unmatched count, latest bank balance, and ledger balance for the
asset account (typically 1930). If \`unmatched_count = 0\` and the balances agree,
the account is reconciled: skip to Step 5.

### Step 2: Categorize the uncategorized side

Unmatched usually means *bank rows without journal entries* (incoming PSD2
transactions) AND *journal rows without bank lines* (manually-posted entries
the agent might already have created via \`gnubok_create_voucher\`).

For the bank-side gap:

1. \`gnubok_list_uncategorized_transactions(limit=20)\`. Page through if needed.
2. For each, decide: is this an income payment for a known invoice, or an expense?
3. **Income** that matches an open invoice: \`gnubok_match_transaction_to_invoice\`: keeps AR clean.
4. **Income** without a matching invoice (refund, deposit, owner contribution): \`gnubok_categorize_transaction\` with the appropriate category.
5. **Expense**: \`gnubok_suggest_categories\` first (uses counterparty templates + history): accept the top suggestion if confidence is high. Otherwise pick from the category list manually.
6. **Owner draw / private withdrawal** (EF only): category \`private\` posts to 2013.

Each call stages a pending operation: the user approves in the web app.

### Step 3: Resolve duplicates / dead entries

If the bank shows a transaction that was already booked (e.g. manually entered via \`gnubok_create_voucher\`):

- \`gnubok_match_transaction_to_invoice\` won't help here.
- The cleanest path: reverse the manual entry via \`gnubok_reverse_journal_entry\` (storno) and then categorize the bank transaction normally so the trail is "bank → ledger" rather than "ledger → bank → orphan".

If the ledger shows a phantom entry with no bank counterpart (a payment that
was never actually sent), it must be reversed: \`gnubok_reverse_journal_entry\`.

### Step 4: Re-check status

\`gnubok_get_reconciliation_status\` should now report \`unmatched_count = 0\`
and matching balances. If the balances still disagree:

- A historical opening balance might be wrong. Compare \`gnubok_get_trial_balance\` for the period start against the bank's opening statement.
- An entry might sit in a closed period that wasn't fully reconciled before locking. Check \`gnubok_list_fiscal_periods\` and walk backwards.
- FX accounts (non-SEK) need revaluation before period close: \`gnubok_run_currency_revaluation\`.

### Step 5: Document the reconciliation

For each fiscal period, Accounted stores the reconciliation state automatically.
For a printed audit trail (BFL 8 kap), generate the supplier ledger and AR
ledger after reconciliation:

- \`gnubok_get_ar_ledger\`: open customer balances should match unpaid invoices
- \`gnubok_get_supplier_ledger\`: open supplier balances should match unpaid leverantörsfakturor

## Critical rules

- **Never delete a bank transaction**, even if it looks wrong. The PSD2 feed is the source of truth. If the bank made a mistake, the bank reverses it via a new transaction.
- **Never edit a posted entry to "make it match"**: use \`gnubok_correct_entry\` or \`gnubok_reverse_journal_entry\`. BFL 5 kap 5 § forbids in-place edits.
- **Reconcile BEFORE locking the period.** Lock-period sealed-off audit can't be re-opened cheaply (it requires \`gnubok_unlock_period\` + storno + relock).
- **FX accounts must be revalued** at period close. Pre-revaluation reconciliation can show a phantom mismatch that disappears after revaluation: don't chase it.

## Common errors

- *"Balances disagree by exactly N"*: usually a single rounding entry at year-end (öresavrundning, 3741/7741) wasn't booked. Verify with \`gnubok_get_general_ledger\` filtered to the rounding accounts.
- *"Unmatched count is 0 but balances disagree"*: opening balance issue. Check the previous period's UB matches this period's IB via \`gnubok_get_trial_balance(period=prev)\` vs \`gnubok_get_trial_balance(period=current, opening=true)\`.
- *"Same transaction shows twice"*: either two PSD2 feeds (manual + Enable Banking) imported the same row, or the user manually created a voucher AND the bank imported the row. Reverse the duplicate via \`gnubok_reverse_journal_entry\`.

## Tools

- \`gnubok_get_reconciliation_status\` (single source of truth: call first and last)
- \`gnubok_list_uncategorized_transactions\`
- \`gnubok_suggest_categories\`
- \`gnubok_categorize_transaction\`
- \`gnubok_match_transaction_to_invoice\`, \`gnubok_match_batch_allocate\` (one receipt → many invoices)
- \`gnubok_auto_match_period\` (bulk matcher with confidence thresholds: use for big backlogs)
- \`gnubok_link_transaction_to_journal_entry\`, \`gnubok_link_invoice_to_voucher\`, \`gnubok_link_supplier_invoice_to_voucher\` (attach to an existing verifikat: no new bokföring)
- \`gnubok_find_voucher_candidates_for_invoice\`, \`gnubok_find_voucher_candidates_for_supplier_invoice\` (read-only: run before the link_\* tools)
- \`gnubok_attach_document_to_transaction\` (file a receipt against a tx)
- \`gnubok_reverse_journal_entry\` (storno)
- \`gnubok_run_currency_revaluation\` (FX accounts only)
- \`gnubok_get_trial_balance\`, \`gnubok_get_ar_ledger\`, \`gnubok_get_supplier_ledger\` (verification)
`

export const bankReconciliationSkill: Skill = {
  slug: 'bank-reconciliation',
  name: 'Bank Reconciliation',
  summary: 'Stämma av banken: pick the right match/link tool, categorize PSD2 rows, handle kontant- vs faktureringsmetoden, resolve duplicates, verify with ledger reports.',
  tags: ['monthly', 'reconciliation', 'bank', 'verification', 'matching'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
