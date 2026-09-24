import type { Skill } from '../types'

const body = `# Stäm av månaden: Accounted

Sign off a month account by account: every bank account, the skattekonto (1630) and the other balance accounts that need an underlag. For each account you compare the outside truth (bank, Skatteverket, a reskontra or the user's own underlag) with the ledger, get every difference explained, and stage an "avstämt t.o.m." sign-off the user approves.

Scope: this skill is the per-account bridge and the sign-off. Choosing how to book or match individual bank rows (invoice matching, categorizing, duplicates, kontant- vs faktureringsmetoden) is the \`bank-reconciliation\` skill: load it with \`gnubok_load_skill\` when a bank account has many unbooked rows. Locking the period afterwards is \`month-end-close\`.

## When to use

- "Stäm av månaden", "Stäm av banken och skattekontot", "Är juli avstämt?", "Markera juli som avstämd"
- Before \`month-end-close\` locks the month and before the momsdeklaration

## The model

Each account has an \`account_key\`: \`bank:<cash_account_id>\`, \`skattekonto\` or \`manual:<BAS>\` (for example \`manual:1510\`). The engine compares outside balance with ledger balance and explains the gap line by line: unmatched outside rows, unmatched ledger lines, ignored rows, and for the skattekonto an opening difference before the fetched history. \`unexplained_difference\` is the only number you judge on: when it is 0 the account is reconciled. \`difference\` is the raw gap and is normally non-zero while the bridge explains it. A link between an outside row and a verifikat never writes to the ledger; booking does.

## Step 0: Orient before acting

Answer these before touching an account. Do not ask the user what a tool can tell you.

1. **Which company.** \`gnubok_list_companies\`. One company: use it. Several: ask which one, then pass that \`company_id\` on every call below, approvals included.
2. **Legal form and method.** \`gnubok_get_agent_briefing\` gives \`entity_type\` (aktiebolag or enskild_firma) and \`accounting_method\` (accrual = faktureringsmetoden, cash = kontantmetoden, null = accrual). Legal form matters for private rows on the bank (see Stop conditions); the method matters when you book bank rows (see \`bank-reconciliation\`).
3. **Which month, and is it open.** \`gnubok_list_fiscal_periods\`: find the fiscal period that holds the month and its status (active, locked, closed). A locked or closed month can still be linked and signed off, but nothing new can be booked in it: see "When a tool call fails".
4. **Which accounts.** Read the resource \`Accounted://reconciliation/summary?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD\`: every account with \`state\` (reconciled, open, stale, not_configured), \`unexplained_difference\`, open counts, \`synced_at\` and \`signed_off_through\`. The resource always reads the connection's default company: for another company, or a harness without resources, use \`gnubok_list_cash_accounts\` (each \`cash_account_id\` gives \`bank:<id>\`) and call \`gnubok_get_reconciliation_status\` per key. An unknown key is answered with an error that lists the keys that exist: pick from that list, never guess.
5. **Is the outside side fresh.** \`stale\` means the outside data is older than 7 days. Bank: \`gnubok_connect_bank\` shows the connections and their last sync; \`gnubok_sync_bank({ connection_id })\` fetches now (\`synced: false\` with \`next_allowed_at\` means a sync ran in the last 15 minutes: wait, do not loop). Skattekonto: there is no fetch tool; ask the user to fetch it in Accounted (Skattekonto page) and tell you when it is done.

Then tell the user in two lines what you found: the month, the accounts, which already are signed off, and which you will work. Ask one scoping question only if it is open: "Ska jag stämma av alla konton för juli, eller bara bank och skattekonto?" An account whose \`signed_off_through\` is already at or past the month end is done: skip it.

## Step 1: Read the bridge for one account

\`gnubok_get_reconciliation_status({ account_key, date_from, date_to })\` with the month (for \`manual:\` keys, \`date_to\` is the balansdag). It returns outside balance, ledger balance, \`difference\`, \`unexplained_difference\`, the bridge lines, counts per bucket and the latest sign-off. Work one account at a time, in this order: bank accounts, skattekonto, then manual accounts.

## Step 2: Work the buckets

\`gnubok_list_reconciliation_items({ account_key, bucket, date_from, date_to })\` (limit default 50, max 200; page with \`offset\`). Each item carries \`item_id\`, \`side\`, \`amount\`, a \`proposal\` and the \`actions\` it allows.

1. **proposed**: outside rows with an exact twin verifikat. Link them in one call: \`gnubok_reconcile_match({ account_key, use_proposals: true, dry_run: true })\`, show the user the preview, then call again without \`dry_run\`. It stages. Rows in \`skipped[]\` are information: ALREADY_LINKED (done already), ENTRY_REVERSED or ENTRY_NOT_FOUND (the verifikat is gone or reversed: treat the row as unmatched), PAIR_NOT_CLOSED (amounts do not add up: see Step 3), UNSUPPORTED_PAIR_SHAPE (see Rules).
2. **unmatched_external** (only on the outside): see "Items on one side only" below.
3. **unmatched_ledger** (only in the books): see the same section.
4. **matched**, **ignored**, **upcoming**: explain the bridge and need no work. \`upcoming\` skattekonto rows are not yet settled at Skatteverket and cannot be booked.

Re-read the status after every approved round. Stop working an account when \`unexplained_difference\` is 0, or when what remains needs the user.

### Items on one side only

**Outside row, nothing in the books** (\`unmatched_external\`):

- Bank row whose affärshändelse is already on a verifikat: link it with \`gnubok_reconcile_match({ account_key, pairs: [{ external_ids: [...], journal_entry_ids: [...] }] })\`. Find the verifikat with \`gnubok_query_journal\` (account, date window, amount) first.
- Bank row that is not booked at all: it needs booking. A handful: \`gnubok_categorize_transaction\`. Many, or incoming customer payments: follow \`bank-reconciliation\` (it covers \`gnubok_match_transaction_to_invoice\` and \`gnubok_auto_match_period\`, which proposes invoice matches for a date range of unmatched income, dry run by default).
- Bank row that is no business event (a duplicate, a PSD2 ghost row): \`gnubok_ignore_transaction({ transaction_id, dry_run: true })\`, then without \`dry_run\`. It writes no verifikat, so a locked period does not block it. Only when the user agrees it is noise.
- Skattekonto row (ränta, avgift, moms, preliminärskatt, arbetsgivaravgift): book settled rows with \`gnubok_book_skattekonto_rows({ skattekonto_transaction_ids, dry_run: true })\`, then without \`dry_run\` (one row: \`gnubok_book_skattekonto_row\`). The preview shows the counter account each rule chose. Skipped reasons: NOT_SETTLED (wait for Skatteverket), ALREADY_BOOKED, ROW_IGNORED, NO_COUNTER_ACCOUNT (no rule: ask the user what the row is, or hand it over; a row that needs employer registration is often private A-skatt and not the company's). A skattekonto row that pairs with a verifikat the user already booked (for example the monthly skattedeklaration) is linked with \`gnubok_reconcile_match\`, not booked again.

**Ledger line, nothing outside** (\`unmatched_ledger\`):

- Within 5 days of the snapshot (\`awaiting_external\`): the outside side may simply not have arrived. Leave it and say so.
- Older: usually booked on the wrong account, booked twice, or a payment that never left. Show the user voucher number, date, amount and text, and ask one question: "Verifikat A45 den 12 juli, 3 450 kr på 1930, har ingen motsvarande rad på banken. Gick betalningen iväg, eller ska verifikatet rättas?" Never reverse or correct on your own. If the user confirms it is wrong, the correction goes through \`gnubok_reverse_journal_entry\` or \`gnubok_correct_entry\`, staged like everything else, and only in an open period.

## Step 3: When the bridge does not balance

Work from the largest unexplained amount down.

1. **Re-read with the right window.** A bank bridge read without the month window, or a stale snapshot, gives a false gap. Fix the window and freshness first.
2. **Look for a single row.** Compare \`unexplained_difference\` with the amounts in \`unmatched_external\` and \`unmatched_ledger\`: an exact hit, or double it (a row booked with the wrong sign), points at the cause.
3. **PAIR_NOT_CLOSED on a bank pair.** The rows and the verifikat almost match. If the gap is a fee, interest or öre rounding that the bank statement shows, close it with \`gnubok_reconcile_residual({ account_key, external_ids, journal_entry_id, kind, dry_run: true })\` (kind \`bank_fee\` 6570, \`interest_expense\` 8410, \`interest_income\` 8310, \`rounding\` 3740), then without \`dry_run\`. It links the rows and books the difference in one staged step. Refusals: RESIDUAL_ZERO (nothing to book, link normally), RESIDUAL_DIRECTION (the kind does not fit the sign: fee and interest expense are money out, interest income is money in), RESIDUAL_TOO_LARGE (above the 5 000 cap: a missing booking, not a fee). Residual is bank only: on the skattekonto a pair that does not close is a wrong booking, because Skatteverket posts ränta and avgifter as rows of their own.
4. **Everything is linked but a gap remains.** On a bank account this is usually the opening balance (below) or a verifikat whose bank line changed after it was linked. On the skattekonto a non-zero \`unexplained_difference\` is an integrity finding, not a user task: stop and hand it over with the numbers.

### Small (öre) versus material

- Unexplained below half an öre counts as zero: the sign-off accepts it.
- An öre or krona gap on a bank pair that the statement shows as rounding: \`rounding\` residual (3740).
- A fee or interest line on the statement: book it as such with the residual, whatever the size under the cap.
- Anything else is a missing or wrong booking until proven otherwise. The 5 000 cap is a technical ceiling, not a materiality threshold. Whether a remaining difference is small enough to sign off with an explanation is the user's decision, never yours: give the amount and what you checked, and ask.

### The opening balance is wrong

The bank bridge runs from the start of the fiscal period, so a wrong ingående balans on 19xx shows as a constant gap that no row explains.

- Check it: \`gnubok_get_trial_balance({ period_id })\` for the current and the previous fiscal period. The previous period's closing balance on the account should equal this period's opening balance, and both should match the bank statement at the year shift. \`gnubok_query_journal({ accounts: ["1930"], source_type: "opening_balance" })\` shows the opening verifikat.
- No opening balances at all after a closed year: \`gnubok_set_opening_balances({ closed_period_id, next_period_id })\` stages them. Show the preview.
- The opening balance exists but differs from the bank: do not book a plug entry. The cause sits in an earlier period (an unbooked row before the year shift, a migration or SIE import that missed the account). Ask the user for the bank statement's balance at the year shift and hand over: it touches a closed or earlier year.
- Skattekonto: an "Ingående skillnad" (\`opening_difference\`) bridge line is the gap between Skatteverket's saldo and 1630 before the first fetched row. It is explained, so it does not block the sign-off, but it is a real difference in the books. Report it with the date and amount and ask the user whether they have a skattekontoutdrag from before that date. Never book it away yourself.

### The skattekonto is not imported

- Error "Skattekontot är inte kopplat": Skatteverket is not connected. \`gnubok_connect_skatteverket\` returns the link where the user authorises with BankID. Tell the user, skip the skattekonto for now and continue with the other accounts.
- Error "inga skattekontohändelser har hämtats ännu": connected but the first fetch has not finished. Skip it and say so.
- State \`stale\`, or NOT_FETCHED_THROUGH at sign-off: the snapshot is older than the month end. Ask the user to fetch in Accounted, then re-read. A skattekonto sign-off date can never pass the snapshot date.

### Other balance accounts (manual:BAS)

The summary also lists balance accounts without a feed. For 1510 (kundreskontra), 2440 (leverantörsreskontra) and 2920/2940 (semesterlöneskuld) the system keeps its own specification as the outside side; the reskontra totals are open items as they stand today, so for a past month say so. For every other account the outside balance is the user's underlag: ask for it ("Vad säger låneavin för 2350 per 31 juli?") and pass it as \`external_balance\` at sign-off, in ledger sign (liabilities negative). Never invent \`external_balance\` or copy it from the ledger: that signs off nothing. EXTERNAL_BALANCE_NOT_ALLOWED means the account already has a specification or feed: sign without it.

## Step 4: Sign off

When \`unexplained_difference\` is 0 through the month end: \`gnubok_reconcile_signoff({ account_key, through_date: "YYYY-MM-DD", dry_run: true })\` with the last day of the month, then without \`dry_run\`. It stages; the user approves. Refusals are policy:

- NOT_RECONCILED: something is still unexplained. Back to Step 3.
- OUTSIDE_UNKNOWN: no outside balance (manual account without underlag, or no fetched data). Ask for the underlag or the fetch.
- NOT_FETCHED_THROUGH: skattekonto snapshot older than the date. Ask for a fetch.
- ALREADY_SIGNED_OFF: signed through that date or later. The user reopens it in Accounted (Avstämning) if it must change; you do not.
- DATE_IN_FUTURE, INVALID_DATE: fix the date.
- NOTE_REQUIRED: \`force\` needs a \`note\`.
- SIGNOFF_RACE: someone else signed or reopened just now. Re-read the status before anything else.

\`force: true\` with a \`note\` signs despite a difference. Only on the user's explicit decision, with the user's own words for the note, and never for the skattekonto integrity case above.

## Questions for the user

Ask one precise question with the facts attached, never an open "what should I do".

- At the start: which month, which accounts, and whether "done" means signed off or just checked.
- A ledger line with nothing outside, older than 5 days: did the payment happen?
- A bank row that looks private (a grocery store, a personal Swish): whose was it? See Stop conditions.
- A row you cannot identify (unknown payee, foreign amount, no text): what is it, and is there a receipt?
- A remaining difference: is it acceptable to sign with a note, and what should the note say?
- A manual account: what does the underlag say on the balansdag?

## When a tool call fails

- **Validation** ("Invalid account_key", missing field, bad date): fix the argument from the error and call once more. Read the tool's schema; do not guess field names.
- **Unknown account_key**: use one of the keys the error lists.
- **Period locked or closed**: links, ignores and sign-offs still work (they write no verifikat). Anything that books (\`gnubok_categorize_transaction\`, \`gnubok_reconcile_residual\`, \`gnubok_book_skattekonto_rows\`, a correction) cannot be committed in a locked month; the staged response's \`period_status\` says so. Tell the user; unlocking is their call, and a closed year is never reopened by you. Never move the date into an open month to get around a lock.
- **Conflict or race** (ALREADY_LINKED, LINK_RACE, SIGNOFF_RACE, a 409): state changed under you. Re-read the status and items, then decide. Never repeat a write blindly; pass an \`idempotency_key\` when you must retry the same staged write.
- **Staged for approval** (\`staged: true\`): not an error. Nothing happened yet. Collect the staged operations and hand them to the user (see Approval).
- **Capability gate**: residual refused on the skattekonto, skattekonto not connected, or a loadout tool with \`callable: false\` and \`blocked_by\` (a missing scope on the API key). Say which capability is missing and what the user does to add it; do not substitute another tool that writes differently.
- **A tool not in your tools/list**: \`gnubok_search_tools\` shows \`callable_via\`. A staged write with \`stage_tool\` goes through \`gnubok_stage_tool({ tool, arguments })\` and is approved as usual; an unlisted read goes through \`gnubok_call_tool({ tool, arguments })\`. \`gnubok_reconcile_signoff\`, \`gnubok_reconcile_residual\`, \`gnubok_reconcile_unmatch\`, \`gnubok_book_skattekonto_rows\` and \`gnubok_link_transaction_to_journal_entry\` are often reached this way.

## Approval

Every write here stages a pending operation. On Claude, \`gnubok_list_pending_operations({ render_ui: true })\` opens the approval widget. Without a widget (ChatGPT, Grok, a terminal), list what is staged (account, what it links or books, amount) and ask. On a clear yes, call \`gnubok_approve_pending_operation\` per operation; otherwise point the user to Granskning in Accounted. Approve in dependency order: links and bookings first, the sign-off last, since the sign-off re-checks the bridge when approved.

## Stop conditions: this needs a human

Stop, and say "Det här behöver ett beslut av dig (eller er redovisningskonsult): här är vad jag hittade", then the facts, when:

- a bank row may be private: in an enskild firma the owner decides whether it is a private withdrawal; in an aktiebolag a private purchase on the company account is never simply "private", so ask the user and let their accountant decide how to book it
- a difference would need \`force\` to sign off
- the cause sits in a locked month, a closed year, or the opening balance
- the skattekonto has a non-zero \`unexplained_difference\`, or an \`opening_difference\` the user cannot explain
- a skattekonto row has no counter account rule
- a correction of a posted verifikat would be needed

## Rules

- Links and sign-offs never touch the ledger. Booking does, and always stages.
- Never delete, never edit a posted verifikat, never book a plug entry to force a zero, never invent an amount or an \`external_balance\`.
- Judge on \`unexplained_difference\`, never on \`difference\`.
- Round money to whole öre (two decimals), never with toFixed. Account numbers are strings ("1930").
- One or more outside rows link to one verifikat. On a bank account one row may also settle several verifikat (a lump payout over utlägg, a Bankgirot deposit over two customer payments): pass \`journal_entry_ids\` with several ids and optionally \`allocations: [{ journal_entry_id, amount }]\` (signed, summing to the row). Other shapes come back as UNSUPPORTED_PAIR_SHAPE.
- A wrong link is undone with \`gnubok_reconcile_unmatch({ account_key, external_id })\`; the verifikat stays untouched.

## Report

End with short groups, in the user's language:

- **Klart**: per account, outside vs ledger and the sign-off date approved
- **Väntar på godkännande**: what is staged, per account
- **Behöver ditt svar**: each open question, with the facts
- **Kunde inte göras**: what and why (not connected, locked period, stale data)
- **Nästa steg**: usually approve in Granskning, then \`month-end-close\`. Point at the Avstämning page in Accounted for anything the user wants to see.

## Tools used

- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`, \`gnubok_list_fiscal_periods\`, \`gnubok_list_cash_accounts\` (orientation)
- \`gnubok_get_reconciliation_status\`, \`gnubok_list_reconciliation_items\` (the bridge and its rows)
- \`gnubok_connect_bank\`, \`gnubok_sync_bank\`, \`gnubok_connect_skatteverket\` (freshness and connections)
- \`gnubok_reconcile_match\`, \`gnubok_reconcile_unmatch\`, \`gnubok_reconcile_residual\`, \`gnubok_reconcile_signoff\` (staged writes)
- \`gnubok_categorize_transaction\`, \`gnubok_link_transaction_to_journal_entry\`, \`gnubok_ignore_transaction\`, \`gnubok_auto_match_period\` (bank rows; details in \`bank-reconciliation\`)
- \`gnubok_book_skattekonto_rows\`, \`gnubok_book_skattekonto_row\` (skattekonto rows)
- \`gnubok_get_trial_balance\`, \`gnubok_query_journal\`, \`gnubok_set_opening_balances\` (opening balance checks)
- \`gnubok_reverse_journal_entry\`, \`gnubok_correct_entry\` (only on the user's decision, open periods)
- \`gnubok_list_pending_operations\`, \`gnubok_approve_pending_operation\` (approval)
- \`gnubok_search_tools\`, \`gnubok_call_tool\`, \`gnubok_stage_tool\` (reaching unlisted tools)
- Resource: \`Accounted://reconciliation/summary\`
`

export const reconcileMonthSkill: Skill = {
  slug: 'reconcile-month',
  name: 'Stäm av månaden',
  summary: 'Stäm av månaden per konto: explain every difference on bank, skattekonto and other balance accounts, then stage an "avstämt t.o.m." sign-off per account.',
  tags: ['monthly', 'reconciliation', 'bank', 'skattekonto', 'sign-off', 'avstämning'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
