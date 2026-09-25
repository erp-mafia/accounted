import type { Skill } from '../types'

const body = `# Month-End Close (Månadsavslut): Accounted

The orchestration skill for closing one calendar month: make sure every affärshändelse in the month is booked with its underlag, every account with an outside truth agrees, every voucher gap is explained and, for monthly filers, the momsdeklaration is ready. Then the user locks the month. You coordinate; the detail lives in sibling skills you load by slug with \`gnubok_load_skill\`:

- \`bookkeep\`: booking the individual transactions and documents
- \`kvittojakten\` (\`kvittojakten-chatgpt\`, \`kvittojakten-grok\`, \`kvittojakten-claude\` for those harnesses): finding missing underlag in the user's mail
- \`reconcile-month\`: the account-keyed reconciliation of bank accounts and the skattekonto, with sign-off
- \`bank-reconciliation\`: which match or link tool fits a bank row
- \`quarterly-vat-review\`: the momsdeklaration review for quarterly filers
- \`payroll-monthly\`: the month's salary, for companies with employees
- \`year-end-close\`: bokslut, the only place a fiscal year is closed

Do not repeat those skills here. Run the step, and when it needs depth, load the sibling and follow it.

## When to use

- "Stäng juni" / "Gör månadsavslut för juni" / "Close out June"
- "Kan jag låsa maj?" / "Is May ready to lock?"
- As the monthly step before a quarterly momsdeklaration

## Locking, closing and the lock date: know the difference

Accounted has three different things that users all call "stänga". Get this right before you say anything to the user.

1. **Month lock: "Bokföring låst t.o.m."** A company-wide date under Inställningar, Bokföring, Periodlåsning (\`/settings/bookkeeping\`). Nothing dated on or before it can be booked or changed. This is what closing a month means. It covers everything before the date too, so locking through 30 June also locks May. No MCP tool sets it: the user changes it in the app. It has no built-in "all booked" check, so your checklist is the check.
2. **Fiscal period lock: \`gnubok_lock_period\`.** A fiscal period in Accounted is the whole räkenskapsår, not a month. Locking it freezes the entire year. Never use it for a month-end close. It refuses while any bank transaction in the year is unbooked or untriaged.
3. **Close: \`gnubok_close_period\`.** Year-end only, irreversible, requires the lock and the bokslut closing entry. Not part of this skill: point to \`year-end-close\` (which uses \`gnubok_run_year_end\`).

Consequence the user must hear before locking: in an open, unlocked month a posted verifikat can still be corrected inside the same verifikat (inline rättelse, with a who/when log). Once the month is behind the lock date the only path is storno plus a new verifikat (BFL 5 kap 5 §), and only after the user moves the date back.

## Step 0: Orient before acting

Answer each of these with a tool, not a guess:

| Question | Where the answer comes from |
|---|---|
| Which company? | \`gnubok_list_companies\`. Several: ask which one, then pass that \`company_id\` on every call, approvals included. |
| Legal form, accounting method, VAT registered, employees? | \`gnubok_get_agent_briefing\`: \`entity_type\` (aktiebolag vs enskild_firma), \`accounting_method\` (\`accrual\` = faktureringsmetoden, \`cash\` = kontantmetoden), \`company_context.vat_registered\`, \`company_context.has_employees\`. |
| VAT filing cadence? | \`Accounted://company/current\` (\`settings.moms_period\`) for the default company; otherwise \`gnubok_vat_close_check\` returns \`payment.moms_period\`. If neither answers, ask the user. |
| Is the month inside an open fiscal year? | \`gnubok_list_fiscal_periods\`: find the period whose \`period_start\`/\`period_end\` covers the month. \`active\` = open, \`locked\` = the whole year is frozen, \`closed\` = bokslut done. |
| Current lock date? | \`Accounted://company/current\` (\`fiscal.company_lock_date\`) for the default company. For another company, ask the user to read "Bokföring låst t.o.m." under Inställningar, Bokföring. |
| Is the bank connected and fresh? | \`Accounted://reconciliation/summary\` (default company) or \`gnubok_get_reconciliation_status\`; \`recent.last_bank_sync_at\` in \`Accounted://company/current\`. |
| What is already staged? | \`gnubok_list_pending_operations\`: operations waiting for approval are not booked yet. |

Resources read the connection's default company only. For a non-default company use the tools, and ask for what the tools cannot give.

Stop at Step 0 when:

- No fiscal period covers the month: say so, and tell the user to create the räkenskapsår in Accounted first. Do not book anything.
- The covering period is \`closed\`: the month is final. Say that this needs a human (an accountant) if something is wrong in it.
- The covering period is \`locked\`, or the lock date already covers the month: the month is already locked. Ask what the user wants to achieve; do not suggest unlocking unless they need a correction, and then read "Unlocking" below.

## Questions to ask at the start

Ask these in one message, with the facts from Step 0 filled in:

1. Which month, and what "done" means: a check only, or ready for the user to set "Bokföring låst t.o.m." to the last day of the month.
2. Anything outside the bank feed: cash purchases, purchases on a private card for the company (utlägg), a company card from another bank, invoices sent or received outside Accounted.
3. For an enskild firma: any private purchases on the business account the user already knows about.

Do not ask for confirmation before reading: reading is always safe.

## The previous month is still open

The lock date is one date that covers everything before it. You cannot lock June and leave May open. So close months in order:

- Run Step 1 to Step 6 for the earliest month after the current lock date first. If the user only wants June, tell them May is still unlocked and ask: "Ska jag ta maj först? Juni kan inte låsas utan att maj låses samtidigt."
- If several months are open, do the checks month by month, but one lock at the end (the last day of the last clean month) is fine.
- Leaving a month unlocked is legal. BFL requires other affärshändelser to be booked "so snart det kan ske", in practice by the end of the following month; cash payments by the next working day. A month waiting for one receipt can stay open; a month three months behind is a problem worth saying out loud.

## Step 1: Everything in the month is booked

1. \`gnubok_list_uncategorized_transactions({ limit: 100 })\`. It has no date filter and is newest first: page with \`offset\` until you are past the month, and keep only rows dated inside it.
2. Pending operations dated in the month from Step 0: remind the user they still need approval.
3. Load \`bookkeep\` and work the rows in batches. Sort each row into one of four piles:
   - **Bookable now**: facts and underlag are clear. Book via \`bookkeep\`.
   - **Not a business event** (duplicate, PSD2 ghost row, a transfer that never executed): \`gnubok_ignore_transaction({ transaction_id, dry_run: true })\`, then without \`dry_run\`. Say why for each.
   - **Private** (enskild firma only): an eget uttag, booked through \`bookkeep\` with category \`private\`. In an aktiebolag there is no "private": a private purchase on the company account is a decision about the owner's debt or salary, so it is a stop condition.
   - **Cannot book yet**: see Step 2.
4. Also check the month's invoices, depending on method. Faktureringsmetoden: customer invoices dated in the month should be booked (\`gnubok_list_invoices\`) and supplier invoices dated in the month registered (\`gnubok_list_supplier_invoices({ date_from, date_to })\`). Kontantmetoden: they are booked at payment, so an unpaid invoice does not block the month.
5. Employees (\`has_employees\`): check that the month's salary run is booked; if not, point to \`payroll-monthly\` and do not book salary yourself.

## Step 2: Transactions that cannot be booked yet

Never book a guess to make the month look clean. For each row, find out which gap it is:

- **Missing underlag** (no receipt or invoice): load \`kvittojakten\` (the harness variant) and run it for the month (\`since\` = the first day of the month on the worklist). What it finds, you book. What it does not find: ask the user one question per item, e.g. "Betalning 1 249,00 kr till HETZNER den 14 juni: har du kvittot, eller kan du ladda ner det från leverantörens konto?" If the underlag is lost for good, stop for that item and hand it over: what replaces a lost receipt, and whether VAT can be deducted without it, is not your call.
- **Unclear counterparty or purpose**: gather the facts first (bank text, amount, date, earlier bookings of the same text via \`gnubok_query_journal({ text, date_from, date_to })\`), then ask one precise question. Not "what is this?" but "14 juni, -3 400 kr, 'SWISH 123 456'. Tidigare Swish-betalningar till samma nummer bokades som förbrukningsmaterial. Stämmer det även här?"
- **Unusual items**: a foreign supplier (EU or not, reverse charge), representation, a large purchase that may be an asset, a loan, a refund. Load \`horizontal/swedish-vat\` or \`horizontal/swedish-accounting-compliance\` with \`gnubok_load_skill\` before proposing anything, and stop when the rule pack does not settle it.

Rows still in this pile at the end keep the month from being lockable. List them in the report under "needs your answer"; the month stays open until they are resolved.

## Step 3: Reconcile

Load \`reconcile-month\` and follow it for each bank account and the skattekonto, through the last day of the month. The gate for this skill: every account's \`unexplained_difference\` is 0 through the month end and signed off, or what remains is listed for the user. Use \`bank-reconciliation\` when you need to choose between match and link tools.

When information is missing:

- **Stale bank data** (state \`stale\`, or the last sync before the month end): the bank side cannot be trusted. Ask the user to sync the bank in Accounted, or call \`gnubok_sync_bank({ connection_id })\` if you have the connection id. Then re-read.
- **No bank connected**: ask for the closing balance on the bank statement for the last day of the month and compare it with the ledger yourself. Say in the report that the reconciliation was manual.
- **A difference you cannot explain**: do not book a balancing entry. Show the difference, the rows behind it, and stop for that account.

## Step 4: Voucher gaps

\`gnubok_list_voucher_gaps({ fiscal_period_id })\` lists gaps per series for the whole räkenskapsår. BFL and BFNAR 2013:2 require verifikationsnummer in an unbroken series; a gap needs a documented explanation. Look at \`unexplained_gaps\` and at gaps whose numbers fall in the month.

For each unexplained gap:

1. Find the cause from facts: the verifikat either side of the gap (\`gnubok_query_journal({ voucher_series, voucher_number_from, voucher_number_to })\`), an SIE import or migration around that date, a series the user started by hand.
2. If the cause is clear, stage \`gnubok_explain_voucher_gap({ fiscal_period_id, voucher_series, gap_start, gap_end, explanation })\` with a short factual explanation in Swedish, e.g. "Nummer A45 till A47 reserverades vid SIE-importen 2026-03-02 men användes inte."
3. If the cause is not clear, ask the user what happened around those numbers. Never write an explanation you cannot back with facts, never create a verifikat to fill a gap, never renumber.

After approval, run \`gnubok_list_voucher_gaps\` again and confirm \`unexplained_gaps\` is 0.

## Step 5: VAT for the month

Skip when the company is not VAT registered.

- **Monthly filer**: \`gnubok_vat_close_check({ period_type: "monthly", year, period })\`. \`ready_to_close\` answers whether the momsdeklaration can be filed; work every item in \`blockers\` and every ERROR in \`declaration_checks\`. Take the deadline from \`payment.deadline\`, never compute it. Show the rutor with \`gnubok_get_vat_report({ period_type: "monthly", year, period, render_ui: true })\` where widgets render; in other harnesses list the rutor in chat.
- **Quarterly filer**: if the month ends a quarter, load \`quarterly-vat-review\` after this skill. Otherwise nothing to file this month.
- **Yearly filer**: nothing to file this month.
- **EU sales**: if the company sells to VAT-registered buyers in other EU countries, ask whether a periodisk sammanställning is due; it has its own deadline and cadence.

Filing is the user's action. You never submit a momsdeklaration from this skill.

## Step 6: Read the numbers

- \`gnubok_get_income_statement({ period_id, from_date, to_date })\` for the month. Compare with the previous month and flag anything odd: revenue missing, a cost doubled, a large one-off. Ask about it, do not fix it.
- \`gnubok_get_trial_balance({ period_id })\`: \`is_balanced\` must be true.

## Step 7: Hand the lock to the user

When Steps 1 to 6 are clean, tell the user the month is ready and exactly what to do: "Gå till Inställningar, Bokföring, Periodlåsning och sätt 'Bokföring låst t.o.m.' till 2026-06-30." Remind them that after this, corrections in the month need storno and an unlocked date. You cannot set the date, and you do not call \`gnubok_lock_period\` for a month.

If something is still open, do not offer the lock. List what blocks it.

## Unlocking

Only when the user needs to correct something in a locked month. For the month lock, the user moves "Bokföring låst t.o.m." back in the app. For a locked fiscal year, \`gnubok_unlock_period({ fiscal_period_id })\` stages the unlock; it is high risk, and a closed year can never be unlocked. After the correction, the lock goes back. Never propose unlocking to make a booking in this skill succeed unless the user asked for that correction.

## When a tool call fails

- **Validation error**: read the message, fix the argument (dates as YYYY-MM-DD, account numbers as strings), retry once. A second failure: report it.
- **Period locked or closed** (\`PERIOD_LOCKED\`, \`TARGET_PERIOD_LOCKED\`, \`TARGET_PERIOD_CLOSED\`, or \`period_status\` in a staged result saying \`locked\`/\`closed\`): the date is behind a lock. Do not retry, do not change the entry date to dodge it, do not unlock. Report the item and let the user decide. A row that is not a business event can still be ignored in a locked period.
- **\`PERIOD_HAS_UNBOOKED_TRANSACTIONS\`** or "Kan inte låsa period": someone tried to lock the fiscal year. Stop: this skill does not lock years.
- **No open period** (\`NO_OPEN_PERIOD_FOR_DATE\`): the räkenskapsår is missing; stop and tell the user.
- **Not found**: the id is stale. Re-list and pick the current id; never guess one.
- **Conflict (409)** or an idempotency replay: the thing already happened or is already staged. Re-read state (\`gnubok_list_pending_operations\`, the list tool) before doing anything else. Never stage the same write twice.
- **Capability or legal-form refusal**: the company's form or settings do not allow the operation. Tell the user; do not look for another tool that does the same thing.
- **Staged for approval**: that is success, not an error. It is not booked until approved.
- **Anything uncertain after a write**: re-read before retrying. A write is never retried blindly.

## Approval discipline

Every write stages a pending operation. The user approves in Accounted under Granskning, or with \`gnubok_list_pending_operations({ render_ui: true })\` where the widget renders (optional). In harnesses without widgets (ChatGPT, Grok), list what is staged (what, date, amount, accounts) and ask; on a clear yes call \`gnubok_approve_pending_operation({ operation_id })\` per operation, adding \`confirmed: true\` only for high-risk operations after stating that they cannot be undone. Never approve on your own initiative.

## Stop conditions: this needs a human

Stop for that item, keep going with the rest, and say plainly "Det här behöver en människa: här är vad jag hittade":

- Private spending in an aktiebolag, or anything that could be salary or a loan to the owner
- Representation vs private, or a cost that may not be deductible
- VAT on EU or non-EU purchases the rule pack does not settle
- A lost underlag with no way to get a copy
- A reconciliation difference with no explanation
- A voucher gap whose cause nobody knows
- Anything in a closed fiscal year, or anything already reported to Skatteverket

## Report format

Short groups, in the user's language:

- **Done**: what is booked, reconciled, explained (with verifikat numbers)
- **Staged for approval**: what waits in Granskning
- **Needs your answer**: one precise question per item
- **Could not do**: item and reason (locked, missing, failed)
- **Next step**: ready to lock (with the exact date to set), or what blocks it; the VAT deadline for monthly filers

## Rules

- Never delete anything, never edit a posted verifikat outside a sanctioned correction, never book a guess or an invented amount.
- Round money to whole öre (two decimals), never with toFixed. Account numbers are strings (\`'1930'\`).
- Do not work around a lock. Do not lock a fiscal year for a month.
- One question at a time, with the facts attached.

## Tools

- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`, \`gnubok_list_fiscal_periods\`, \`gnubok_list_pending_operations\` (orientation)
- \`gnubok_load_skill\` (sibling skills and rule packs)
- \`gnubok_list_uncategorized_transactions\`, \`gnubok_ignore_transaction\`, \`gnubok_list_invoices\`, \`gnubok_list_supplier_invoices\`, \`gnubok_query_journal\` (booking check; booking itself via \`bookkeep\`)
- \`gnubok_get_reconciliation_status\`, \`gnubok_sync_bank\` (reconciliation; detail via \`reconcile-month\`)
- \`gnubok_list_voucher_gaps\`, \`gnubok_explain_voucher_gap\` (voucher gaps)
- \`gnubok_vat_close_check\`, \`gnubok_get_vat_report\` (VAT, monthly filers)
- \`gnubok_get_income_statement\`, \`gnubok_get_trial_balance\` (review)
- \`gnubok_unlock_period\` (only for a requested correction in a locked year)
- \`gnubok_approve_pending_operation\` (only on the user's explicit yes)
`

export const monthEndCloseSkill: Skill = {
  slug: 'month-end-close',
  name: 'Month-End Close (Månadsavslut)',
  summary: 'Close a month: everything booked with underlag, accounts reconciled, voucher gaps explained, monthly VAT ready, then the user sets the lock date.',
  tags: ['monthly', 'close', 'reconciliation', 'vat', 'lock', 'voucher-gaps'],
  body,
  tier: 'workflow',
  // Universal: both AB and EF run a monthly close. VAT step is conditional
  // inside the body so non-VAT-registered companies aren't blocked.
  applicability: { entity_type: 'both' },
}
