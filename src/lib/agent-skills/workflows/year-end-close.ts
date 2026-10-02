import type { Skill } from '../types'

const body = `# Årsbokslut (Year-End Close): Accounted

The annual close for an aktiebolag. You prepare it with the owner, step by step; the one irreversible step (\`gnubok_run_year_end\`) happens only after the owner has said yes to it in so many words. Work like a consultant with a junior colleague's care: check first, ask one precise question at a time, never guess an amount.

## What this covers, and what it does not

Covers: readiness, bokslutstransaktioner (periodiseringar, avskrivningar, bokslutsdispositioner, bolagsskatt), the close itself, the årsredovisning preview, and the handover to a revisor or accountant.

Links instead of repeating:
- Unbooked transactions and receipts during the year: \`bookkeep\`, \`month-end-close\`
- Bank and skattekonto reconciliation at balansdagen: \`reconcile-month\`, \`bank-reconciliation\`
- The last momsdeklaration of the year: \`quarterly-vat-review\`
- **Which** tax choices to make (how much periodiseringsfond, whether to take full överavskrivning, salary vs dividend): \`tax-planning\`. That skill decides; this one books the decision.

Load a sibling with \`gnubok_load_skill\` when you reach its part.

## Step 0: Orient before acting

Answer each of these with a tool, not an assumption:

1. **Which company.** \`gnubok_list_companies\`. Several: ask which one, then pass that \`company_id\` on every call, including approval. Never let the connection default decide.
2. **Legal form, accounting method, framework.** \`gnubok_get_agent_briefing\` gives identity and \`accounting_method\` (kontantmetoden or faktureringsmetoden). This skill is for AB; if the company is an enskild firma, jump to "If the company is an enskild firma" below. K2 or K3: \`gnubok_preview_arsredovisning\` returns \`report.accounting_framework\`. K3 changes many bokslut items (deferred tax, component depreciation): see stop conditions.
3. **Which year, and its state.** \`gnubok_list_fiscal_periods\`. Find the period the user means by its \`period_end\` (the räkenskapsår may be brutet, never assume 31 December). Status: open, locked or closed.
4. **Earlier years.** In the same list, check every period that ends before this one. See "If a prior year is not closed".
5. **Bank.** \`gnubok_get_reconciliation_status\` with \`date_from\`/\`date_to\` = the period. No connected bank or a difference at balansdagen means the books are not complete yet.

Then tell the user in two or three lines what you found (company, year, K2/K3, method, state) and ask the scoping question: "Do you want me to prepare everything up to the close and then stop for your yes, or only check readiness today?" Also ask, once, up front: "Does the company have a revisor, and does an accounting firm help with the bokslut?" The answer decides the handover at the end.

## If a prior year is not closed

The opening balances of this year are the closing balances of the last one. Closing out of order breaks that chain.

- **An earlier period in Accounted is open or locked (not closed):** stop working on this year. Tell the user: "FY[earlier] is not closed yet. It must be closed first, because this year's opening balances come from it." Offer to run this skill on the earlier year first, oldest first.
- **The earlier year was closed in another system** (the company migrated and this year starts with imported IB): that is fine if this year's IB is posted. Do not run a year-end on a year whose full books are not in Accounted. If you are unsure which case it is, ask: "Was FY[earlier] closed in your previous system, with the opening balances imported here?"
- **Readiness shows \`opening_balance_continuity\`:** this year's IB does not match last year's UB. Compare with \`gnubok_get_trial_balance\` (\`period_id\`) on both periods and show the user the accounts that differ. Do not correct IB yourself: this needs a human, and usually last year's accountant.

## Step 1: Readiness

\`gnubok_year_end_readiness({ fiscal_period_id })\`. Run it first to see the scope of work, and again after each fix. Blockers and what to do:

| Blocker \`kind\` | Meaning | What you do |
|---|---|---|
| \`unbooked_transactions\` | Bank rows in the year are neither booked nor ignored | Load \`bookkeep\`. Book or ignore each one with the user; a private one is handled per that skill, never guessed. |
| \`draft_entries\` | Unposted drafts in the period | Ask the user to finish or discard each draft in Accounted. You cannot delete. |
| \`unexplained_voucher_gap\` | A gap in voucher numbering with no explanation (BFNAR 2013:2) | \`gnubok_list_voucher_gaps\`, ask the user why each gap exists, then \`gnubok_explain_voucher_gap\` with their answer in Swedish. Never invent a reason. |
| \`kontantmetod_cutoff_required\` | Kontantmetoden: open receivables and payables must be booked at balansdagen (BFL 5 kap 2 §) | Step 3 below. |
| \`period_locked\` | The period was locked beforehand | \`gnubok_unlock_period\` (staged, high-risk), after telling the user why: the close posts into the period and locks it itself. |
| \`period_not_ended\` | Balansdagen has not passed | Stop. You can read proposals and prepare questions, but the close waits. |
| \`period_already_closed\`, \`closing_entry_exists\` | Already done | Verify with \`gnubok_list_fiscal_periods\` and go to Step 7. |
| \`next_period_ib_posted\` | The next year already has opening balances (often from an import) | Stop and hand over. Removing them means reversing a posted entry: not yours to decide. |
| \`opening_balance_continuity\` | IB and last year's UB differ | See "If a prior year is not closed". |
| \`trial_balance_unbalanced\`, \`sequence_mismatch\` | Integrity faults | Stop. Tell the user to contact Accounted support with the message text. Never try to post a balancing entry. |

**Warnings** do not block but must be read out. The common one: foreign-currency items open at balansdagen. Items that "saknar valutakurs" cannot be revalued at all: ask the user for the rate on each invoice. Items that can be revalued are handled by the close itself (Step 6).

**Never call \`gnubok_lock_period\` as a pre-flight.** A locked period cannot take the closing entry.

## Step 2: The books must be complete

Before bokslutstransaktioner, confirm with the user and the tools:
- Bank and skattekonto reconciled at balansdagen (\`reconcile-month\`).
- The year's momsdeklarationer filed and the VAT accounts settled (\`quarterly-vat-review\`, \`gnubok_vat_close_check\`).
- Every supplier invoice dated in the year is in the books. Ask: "Have any bills arrived after year-end that belong to [year]? Rent, electricity, telecom, the accountant's fee?" Those are accruals (Step 4).
- Inventory: if the company holds goods (14xx accounts), ask for the stocktake value at balansdagen. Without a count you cannot value the lager: stop that item and say so.

## Step 3: Kontantmetoden cut-off (only if the method is kontantmetoden)

\`gnubok_post_kontantmetod_cutoff({ fiscal_period_id })\` stages the receivable and payable entries on balansdagen plus their reversals on day one of the next year. It is search-only: if your client does not list it, stage it through \`gnubok_stage_tool({ tool: "gnubok_post_kontantmetod_cutoff", arguments: { fiscal_period_id } })\`. The next period must exist and be open; if the tool says it is missing, tell the user and stop this step. Show every proposed line, get approval (high-risk, \`confirmed: true\`), then re-run readiness.

## Step 4: Periodiseringar and avskrivningar

### Periodiseringar (accruals)
- \`gnubok_propose_accruals({ fiscal_period_id })\` proposes what Accounted can compute today, mainly the change in semesterlöneskuld. Read \`notices\`: they say why a proposal was withheld (for example no employees).
- \`gnubok_list_accrual_schedules\` shows running periodiseringar (17xx/29xx) and what remains.
- Everything else comes from the user. Ask concrete questions: prepaid rent or insurance covering next year, customer work done but not invoiced, costs for this year billed next year, an estimated fee for bokslut or revision.
- Under K2, a recurring cost under 5 000 SEK per item that does not vary more than 20 % year on year need not be accrued; personnel costs always are. Under K3 there is no such threshold.
- Stage each accrual with \`gnubok_create_voucher\` dated on balansdagen, balanced lines, the amount the user gave you with its underlag. Tell the user the reversal belongs on day one of the next year, and put it under "next step": the next period normally exists only after the close.

### Avskrivningar (depreciation)
- \`gnubok_list_assets\` first. Then ask: "Did the company buy equipment, computers or vehicles this year that are not in this list?" and "Was anything sold, scrapped or taken out of use?" Compare the purchases booked on 10xx-12xx accounts (\`gnubok_query_journal\` with \`account_from\`/\`account_to\` and the year's dates) with the register.
- A purchase not in the register: register it with \`gnubok_create_asset\` after the user confirms cost, date put into use and useful life. A purchase below half a prisbasbelopp (29 400 SEK for 2025, 29 600 SEK for 2026) or with a useful life of three years or less is normally a förbrukningsinventarie and expensed: ask before moving anything. A sold or scrapped asset: \`gnubok_dispose_asset\`, with the user's facts.
- \`gnubok_propose_annual_depreciation({ fiscal_period_id })\`, show the per-asset amounts, then \`gnubok_post_annual_depreciation({ fiscal_period_id })\` (or with \`asset_ids\` for a subset). One verifikat per asset, staged. Assets that already have a posting this year are skipped.
- This is planenlig avskrivning. The tax-side difference (överavskrivning, 2150/8850) is a bokslutsdisposition, Step 5, not a depreciation posting.

### Currency revaluation (optional)
The close revalues open foreign-currency items at the balansdag rate by itself. Run \`gnubok_run_currency_revaluation({ fiscal_period_id, closing_date })\` with \`closing_date\` = the period's \`period_end\` only if the user wants to see the FX effect before the close. One revaluation per period: never run it twice.

## Step 5: Bokslutsdispositioner and tax: decisions the owner takes

\`gnubok_propose_dispositioner({ fiscal_period_id })\` returns \`proposals\`, each with \`kind\`, \`label\`, \`description\`, \`amount\`, ready-balanced \`lines\`, \`warnings\` and \`required\`, plus \`completedDispositions\` already posted. The order is deliberate: periodiseringsfond återföring, överavskrivningar, periodiseringsfond avsättning, särskild löneskatt, bolagsskatt last (it depends on all the others).

- **\`required: true\`** (a periodiseringsfond that must be reversed this year): not a choice. Tell the user and book it.
- **Avsättning to periodiseringsfond and överavskrivningar** are choices that move taxable profit between years. Present the proposal and its effect in plain words, then load \`tax-planning\` for the decision. Ask one question per item: "Accounted proposes setting aside X SEK to a periodiseringsfond, the maximum allowed. That lowers this year's tax and the amount comes back as taxable income within six years. Do you want the full amount, less, or none?" Never pick for them.
- **Särskild löneskatt** on pension costs and **bolagsskatt** are calculations, not choices. Check them against the numbers, do not negotiate them.
- **Booking.** The Bokslut page in Accounted posts these from the same proposal and is the preferred path. From here: stage one \`gnubok_create_voucher\` per accepted disposition, dated on balansdagen, with the proposal's \`lines\` unchanged. After each approval, call \`gnubok_propose_dispositioner\` again: bolagsskatt must be recomputed on the new base, so never post it from a stale proposal. If the user wants a different amount than proposed, send them to the Bokslut page rather than scaling lines by hand.
- Schablonintäkt on periodiseringsfonder is a tax-return adjustment, never booked.

## Step 6: The close (irreversible)

Preconditions: readiness says \`ready: true\`, the period is open and unlocked, Steps 2 to 5 are done or explicitly skipped by the user. Optionally run \`gnubok_year_end_readiness({ fiscal_period_id, include_preview: true })\` and show the closing-entry preview. Also run \`gnubok_preview_arsredovisning\` now: blockers it shows are cheaper to fix while the period is still open.

\`gnubok_run_year_end({ fiscal_period_id })\` stages one high-risk operation. On approval it revalues open FX items at the balansdag rate, posts the closing entry (class 3-8 into the result account named on the approval card), locks and closes the period, creates or reuses the next period and posts its opening balances.

**Collect an explicit confirmation before approving.** Say, in the user's language:

"This closes FY[year] for good. After this, nothing can be booked, corrected or reversed in [year], not even with a storno: a closed year is final. Any mistake found later is corrected in [next year]. The result that will be closed is [result] SEK. Reply 'Ja, stäng [year]' if you want me to approve it."

Only on that clear yes: \`gnubok_approve_pending_operation({ operation_id, confirmed: true })\`. "OK", "sure" or silence is not enough: ask again. If the approval tool is not available to you, point the user to Granskning in Accounted, where the same confirmation is asked.

Do not call \`gnubok_lock_period\`, \`gnubok_close_period\` or \`gnubok_set_opening_balances\` afterwards: the close did all of it, and they answer "already locked" / "already closed". They exist only for a manual or legacy flow.

## Step 7: Verify, then the årsredovisning

- \`gnubok_list_fiscal_periods\`: the year is closed, the next period exists.
- \`gnubok_get_balance_sheet({ period_id: next })\`: opening balances equal last year's closing balances.
- \`gnubok_get_income_statement({ period_id: closed })\`: the result the user expected.
- \`gnubok_validate_arsredovisning({ fiscal_period_id, stage: "signing" })\`: list every blocker in plain words. Förvaltningsberättelse text, the board's proposed resultatdisposition and notes such as medelantal anställda need the owner's input: ask for them, do not write facts you were not given.
- \`gnubok_preview_arsredovisning\` shows \`eligibility\` and \`capabilities\`: follow what they say about PDF, versions and filing. Signing (all board members, and the VD if there is one) and filing with Bolagsverket are the user's acts. Never say the report is filed. Deadlines to pass on: årsstämma within six months and filing with Bolagsverket within seven months of balansdagen; late filing triggers förseningsavgift.
- Resultatdisposition (moving the result from 2098 to 2091, or a dividend) happens after the årsstämma, in the next year: put it under "next step".

## Handover to a revisor or accountant

A revisor is required when the company exceeded at least two of these in each of the last two years: more than 3 employees on average, more than 1.5 MSEK balansomslutning, more than 3 MSEK nettoomsättning. Check against \`gnubok_get_balance_sheet\` and \`gnubok_get_income_statement\`, but ask the user: a company may also have a revisor voluntarily.

When there is a revisor or an accounting firm, or any stop condition below applies: \`gnubok_audit_package({ fiscal_period_id, estimate_only: true })\` for the size, then without \`estimate_only\` for the zip (SIE-4, reports, receipts, audit log, voucher gaps). The \`download_url\` is valid one hour: give it to the user at once. Tell them what is done and what is left for the professional.

## If the company is an enskild firma

This skill is filtered to AB, but if you reach it for an EF: readiness, accruals, depreciation and \`gnubok_run_year_end\` work the same way (the close uses the EF equity account, named on the approval card). There are no bokslutsdispositioner and no bolagsskatt to book: \`gnubok_propose_dispositioner\` returns none. Periodiseringsfond, expansionsfond, räntefördelning and egenavgifter exist only in the NE-bilaga and are never booked. \`gnubok_preview_ef_declaration({ fiscal_period_id })\` computes them, but it needs inputs only the owner has (\`kapitalunderlag\`, last year's \`prior_year_schablonavdrag\` and \`prior_year_actual_charged\`, an existing expansionsfond): ask for last year's NE-bilaga. The choices go through \`tax-planning\`. No årsredovisning; the NE-bilaga goes with Inkomstdeklaration 1 in early May.

## When a tool call fails

- **Validation error** (missing or malformed argument): fix the argument from the tool's schema and call once more. Two failures on the same call: stop and report it.
- **Period locked or closed** ("Cannot write to locked/closed fiscal period", "Period is locked or closed", PERIOD_LOCK_ALREADY_LOCKED): the period is not writable. If it is only locked and the user agrees, \`gnubok_unlock_period\`, then retry. If it is closed, nothing can be written there: the correction goes into the next year. Never try another date or another tool to get around a lock.
- **Not found** ("Fiscal period not found"): wrong \`fiscal_period_id\` or wrong company. Re-read \`gnubok_list_fiscal_periods\` for the chosen \`company_id\`.
- **Conflict or already done** ("already closed", "already locked", "already exists"): check the state with a read tool before anything else. It usually means the step was done.
- **Staged, not committed** (\`staged: true\`): nothing happened yet. Say so, and hand over for approval.
- **Capability gate** (the legal form, method or API-key scope does not allow the tool): do not look for a workaround tool. Tell the user what the gate says.
- **A write with an unclear outcome** (timeout, network): check \`gnubok_list_pending_operations\` and the journal before retrying. Never retry a write blind.

## Stop conditions: this needs a human

Stop, say "This needs a human: here is what I found", list the facts, and offer the audit package when useful:
- Eget kapital below half of the registered aktiekapital (kontrollbalansräkning, ABL 25 kap). The board has duties and personal liability.
- K3 framework, deferred tax, koncernbidrag, or a company whose buildings generate most of its revenue.
- Any integrity blocker, IB/UB mismatch, IB already posted in the next year, or a prior year closed wrongly.
- An amount the user cannot back with underlag, or a disposition the user wants that you cannot build from the proposal.
- Anything touching a closed year.
- A tax question the rule packs and \`tax-planning\` do not answer: ask, do not guess.

## Rules

- You stage; the user approves. Never bypass Granskning, never approve a high-risk operation without the user's explicit confirmation for that operation.
- Never delete, never edit a posted verifikat. Corrections in an open year follow the storno or rättelse paths; in a closed year they go into the next year.
- Never invent an amount, a rate, an asset, a reason for a voucher gap or an årsredovisning text.
- Round money to whole öre (two decimals), never with toFixed. Account numbers are strings ("2099", not 2099). Every voucher balances.
- One question at a time, with the facts you already have in it.
- No widgets needed. \`gnubok_list_pending_operations({ render_ui: true })\` opens an approval widget where the client supports it; otherwise list the staged operations in chat.

## Report at the end

In the user's language, short groups:
- **Done**: steps completed, with verifikat or period names.
- **Staged for approval**: each pending operation, amount, and whether it is high-risk.
- **Needs your answer**: the open questions, each one precise.
- **Could not do**: what and why (a blocker, a missing fact, a stop condition).
- **Next step**: for example reversing accruals on day one of next year, signing, årsstämma, resultatdisposition, filing deadlines, the handover to the revisor.

## Tools

- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`, \`gnubok_list_fiscal_periods\`: orientation
- \`gnubok_year_end_readiness\`: blockers, warnings, optional closing-entry preview
- \`gnubok_get_reconciliation_status\`, \`gnubok_vat_close_check\`, \`gnubok_get_trial_balance\`, \`gnubok_query_journal\`: completeness checks
- \`gnubok_list_voucher_gaps\`, \`gnubok_explain_voucher_gap\`: BFNAR 2013:2 gaps
- \`gnubok_post_kontantmetod_cutoff\`: kontantmetoden cut-off (search-only, via \`gnubok_stage_tool\`)
- \`gnubok_propose_accruals\`, \`gnubok_list_accrual_schedules\`: periodiseringar
- \`gnubok_list_assets\`, \`gnubok_create_asset\`, \`gnubok_dispose_asset\`, \`gnubok_propose_annual_depreciation\`, \`gnubok_post_annual_depreciation\`: avskrivningar
- \`gnubok_run_currency_revaluation\`: optional FX review before the close
- \`gnubok_propose_dispositioner\`, \`gnubok_create_voucher\`: bokslutsdispositioner and tax
- \`gnubok_run_year_end\`: the close (high-risk, irreversible)
- \`gnubok_unlock_period\`: only to undo a lock taken before the close
- \`gnubok_get_balance_sheet\`, \`gnubok_get_income_statement\`: verification
- \`gnubok_preview_arsredovisning\`, \`gnubok_validate_arsredovisning\`: årsredovisning
- \`gnubok_preview_ef_declaration\`: NE-bilaga figures (enskild firma)
- \`gnubok_audit_package\`: handover to revisor or accountant
- \`gnubok_list_pending_operations\`, \`gnubok_approve_pending_operation\`: approval
- \`gnubok_lock_period\`, \`gnubok_close_period\`, \`gnubok_set_opening_balances\`: manual or legacy flow only, never after \`gnubok_run_year_end\`

A staged write your client does not list in tools/list (\`gnubok_search_tools\` shows callable_via "stage_tool") goes through \`gnubok_stage_tool({ tool, arguments })\` and is approved as usual; an unlisted read goes through \`gnubok_call_tool\`.
`

export const yearEndCloseSkill: Skill = {
  slug: 'year-end-close',
  name: 'Year-End Close (Årsbokslut)',
  summary: 'AB årsbokslut: clear readiness blockers, book periodiseringar, avskrivningar and the owner\'s dispositioner, then gnubok_run_year_end on the OPEN period after an explicit yes. Irreversible.',
  tags: ['yearly', 'close', 'bokslut', 'arsbokslut', 'arsredovisning', 'dispositioner', 'compliance'],
  body,
  tier: 'workflow',
  // AB-specific. Sole traders (EF) use a different year-end path (NE-bilaga)
  // covered by a separate skill that we'll add when bokslut for EF lands.
  applicability: { entity_type: 'AB' },
}
