import type { Skill } from './types'

const body = `# Reconcile a Month: Accounted

Reconcile every account that has a truth outside the ledger (bank accounts and the skattekonto) for a month, then sign it off. This is the account-keyed flow: one engine, the same numbers the user sees on /reconciliation.

## When to use

- "Stäm av månaden" / "Stäm av banken och skattekontot"
- "Är juli avstämt?" / "Markera juli som avstämd"
- Before \`close_period\` and before the momsdeklaration

## The model in one paragraph

Each account is identified by an \`account_key\`: \`bank:<cash_account_id>\` or \`skattekonto\`. For each account the engine compares the outside balance (bank balance / Skatteverket saldo) with the ledger (19xx / 1630) and explains the difference line by line: unmatched outside rows, unmatched ledger lines, ignored rows, and for the skattekonto the opening difference before the fetched history. \`unexplained_difference\` is the number that matters: when it is 0 the account is reconciled. Matched pairs cancel out; a link never writes to the ledger.

## Workflow

### Step 1: Read the summary

Read \`Accounted://reconciliation/summary\` (optionally \`?date_from&date_to\`). Pick the accounts whose \`state\` is \`open\` or \`stale\`. \`stale\` means the outside side is older than 7 days: ask the user to fetch (bank sync / skattekonto sync) before trusting the bridge.

### Step 2: Read the bridge for one account

\`gnubok_get_reconciliation_status({ account_key })\` returns the bridge: outside balance, ledger balance, difference, unexplained_difference, the explanatory lines, counts per bucket, and the latest sign-off. Judge on \`unexplained_difference\`, never on \`difference\`.

### Step 3: Work the buckets, in this order

\`gnubok_list_reconciliation_items({ account_key, bucket })\`:

1. **proposed**: outside rows with a proposed verifikat (exact twin on amount/date). Link them in one staged call: \`gnubok_reconcile_match({ account_key, use_proposals: true, dry_run: true })\`, then without dry_run. The response lists \`applied[]\` and \`skipped[{code}]\`: a skip is information, not an error (ALREADY_LINKED, PAIR_NOT_CLOSED, ENTRY_NOT_FOUND).
2. **unmatched_external**: outside rows with no counterpart. Bank rows: book them (\`gnubok_categorize_transaction\`, or \`gnubok_link_transaction_to_journal_entry\` when the affärshändelse is already on a verifikat). Skattekonto rows: the user books them from /skattekonto or /reconciliation (the rule-based booking lives there); tell the user which rows and amounts. A row that will never be booked (a duplicate, a noise line) is ignored from the page, not by you.
3. **unmatched_ledger**: verifikat lines on the account with nothing outside. Within 5 days of the snapshot they may simply be waiting for the outside side (\`awaiting_external\`). Older ones are usually a wrong account or a missing outside row: show them to the user with voucher numbers; do not reverse anything on your own.
4. **matched** and **ignored** explain the bridge and need no work.

Re-read the status after each round. Stop when \`unexplained_difference\` is 0, or when what remains needs a human decision.

### Step 4: Sign off

When the account is reconciled through the month end: \`gnubok_reconcile_signoff({ account_key, through_date: "YYYY-MM-DD", dry_run: true })\`, then without dry_run. It stages; the user approves. Refusals are policy, not failures: NOT_RECONCILED (something is still unexplained), NOT_FETCHED_THROUGH (skattekonto snapshot is older than the date), ALREADY_SIGNED_OFF (reopen first), NOTE_REQUIRED (force needs a note). Signing with \`force: true\` and a note is the user's call, never yours by default.

### Step 5: Report

Per account: outside vs ledger, what was linked, what the user still has to book, and the sign-off date. Point at \`/reconciliation?account=<account_key>\` for anything that needs a hand.

## Rules

- Links and sign-offs never touch the ledger; booking does, and always stages.
- One or more outside rows link to one verifikat; other shapes come back as UNSUPPORTED_PAIR_SHAPE. A small fee, interest or rounding difference on a bank account is closed with \`gnubok_reconcile_residual({ account_key, external_ids, journal_entry_id, kind, dry_run: true })\`, then without dry_run: it links the rows and books the difference (6570 / 8410 / 8310 / 3740) in one staged step. Anything larger than the cap is a missing booking, not a fee.
- Never judge on \`difference\`; the bridge explains it. Judge on \`unexplained_difference\`.
- A skattekonto sign-off date cannot pass the saldo snapshot; ask for a fetch.

## Tools used

- \`gnubok_get_reconciliation_status\`, \`gnubok_list_reconciliation_items\` (read)
- \`gnubok_reconcile_match\`, \`gnubok_reconcile_unmatch\`, \`gnubok_reconcile_residual\`, \`gnubok_reconcile_signoff\` (staged writes)
- \`gnubok_categorize_transaction\`, \`gnubok_link_transaction_to_journal_entry\` (bank-side booking)
- \`gnubok_approve_pending_operation\` (when the user approves in chat)
- Resource: \`Accounted://reconciliation/summary\`
`

export const reconcileMonthSkill: Skill = {
  slug: 'reconcile-month',
  name: 'Reconcile a Month',
  summary: 'Stäm av månaden: read the per-account bridge, link proposed pairs, get the rest booked, and sign each account off through the month end.',
  tags: ['monthly', 'reconciliation', 'bank', 'skattekonto', 'sign-off'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
