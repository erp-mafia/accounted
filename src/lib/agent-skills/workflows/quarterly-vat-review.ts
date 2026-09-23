import type { Skill } from '../types'

const body = `# Quarterly VAT Review (Momsdeklaration): Accounted

Review one momsdeklaration (SKV 4700) ruta by ruta, get it to a state that can be filed, and, when Skatteverket is connected and the user says so, stage the filing for approval. Works for monthly, quarterly and annual (helårsmoms) filers despite the slug.

## Scope

In scope: one VAT period for one company. Find the cadence, check the period is booked and reconciled, read the rutor, explain what drives each one, flag errors, validate, and stage the submission.

Not in scope, hand off by skill slug instead:

- Booking unbooked bank rows or receipts: \`bookkeep\`
- Bank vs ledger differences: \`reconcile-month\` (or \`bank-reconciliation\`)
- Missing underlag: \`kvittojakten\`
- Locking the month: \`month-end-close\`
- Kontantmetoden year-end cut-off: \`year-end-close\`

You never book, correct, unlock or approve anything silently in this skill. Anything that changes the books is staged and the user decides.

## Step 0: Orient before you touch numbers

Answer each question with the tool named. Do not guess any of them.

1. **Which company?** \`gnubok_list_companies\`. One company: use it. Several: ask which one, then pass that \`company_id\` on every call, including approval. Then \`gnubok_get_agent_briefing\` for \`entity_type\` (aktiebolag or enskild firma), \`accounting_method\` (\`accrual\` = faktureringsmetoden, \`cash\` = kontantmetoden) and \`skatteverket_connection\`.
2. **Is the company VAT registered?** This skill only lists for VAT-registered companies. If the user says they are not registered, stop: there is no momsdeklaration to file.
3. **Which cadence?** Call \`gnubok_vat_close_check\` once for the period the user named (or the most recently ended one) and read \`payment.moms_period\`: \`monthly\`, \`quarterly\` or \`yearly\`. That is the company's setting. When it is \`null\`, ask the user; never infer it from turnover. For context only, the default periods are: beskattningsunderlag up to 1M SEK annual, over 1M to 40M quarterly, over 40M monthly; a business may choose a shorter period (and is then bound for 24 months before switching back). If the user's answer differs from the setting, tell them the setting in Accounted must be corrected before filing.
4. **Which period?** Translate to \`period_type\` + \`year\` + \`period\`: monthly \`1-12\`, quarterly \`1-4\`, yearly \`1\` with \`year\` = the year the räkenskapsår ENDS. If the user asks for a period type that is not their cadence, say so before continuing: a quarterly filer does not file a monthly declaration.
5. **Fiscal year and period status.** \`gnubok_list_fiscal_periods\`: is the fiscal year open, locked or closed? A locked month is normal after month-end close and does not stop you reading or filing. A closed year means corrections cannot be booked into it (see Stop conditions).
6. **Is the bank connected and reconciled?** Covered by the \`bank_unreconciled\` blocker in step 1; \`gnubok_get_reconciliation_status\` for detail.
7. **Is Skatteverket connected?** \`skatteverket_connection\` from the briefing, or \`gnubok_connect_skatteverket\` (\`available\`, \`connected\`). This only matters for steps 5 and 6; do the review either way.

Before starting, tell the user in two lines what you found (company, cadence, period, deadline if known) and what "done" means today: "reviewed and ready", or "filed for BankID signing". Ask which, if they did not say.

## Step 1: Is the period ready? (gnubok_vat_close_check)

\`gnubok_vat_close_check({ period_type, year, period })\` answers "can I close VAT for this period" in one read-only call. It returns \`rutor\`, \`payment\` (\`net_due\`, \`direction\` pay/refund/zero, \`deadline\`, \`deadline_label\`, \`moms_period\`), \`blockers\`, \`declaration_checks\`, \`sanity.anomalies\`, \`ready_to_close\` and a Swedish \`summary\`.

\`ready_to_close\` is false when any blocker has severity \`high\` or any declaration check is \`ERROR\`. Work the blockers by \`kind\`:

| kind | What it means | What you do |
|------|---------------|-------------|
| \`uncategorized_transactions\` | Bank rows in the period with no verifikat | Hand off to \`bookkeep\`. If the affärshändelse is already booked, the hint names \`gnubok_link_transaction_to_journal_entry\` (no new booking). |
| \`unapproved_supplier_invoices\` | Registered but not attested leverantörsfakturor; their ingående moms is missing from ruta 48 | Ask the user whether to attest each one. \`gnubok_approve_supplier_invoice\` stages; the user approves. |
| \`bank_unreconciled\` | Bank and 19xx disagree | Hand off to \`reconcile-month\`. VAT is computed from the ledger, so a difference hides errors. |
| \`missing_high_value_receipts\` | Verifikat without underlag | Offer \`kvittojakten\`. Medium severity, but the deduction needs the underlag. |
| \`reverse_charge_input_missing\` | Omvänd skattskyldighet booked on one side only | See step 3. Read \`check_code\`. |
| \`declaration_incomplete\` | A completeness rule failed | Read \`check_code\` and \`message\`, drill as in step 3. |
| \`deadline_unavailable\` | Settings do not allow a safe deadline (cadence, 40M flag, filing profile, fiscal year) | Tell the user which setting looks missing. Never state a deadline yourself. |
| \`fiscal_year_not_found\` | Yearly period fell back to the calendar year | Re-run with \`year\` = the year the fiscal year ends; check \`gnubok_list_fiscal_periods\`. |
| \`momsredovisning_entries_excluded\` | Information only: verifikat treated as momsredovisning and kept out of the rutor | Not a blocker. When a ruta disagrees with the ledger, these explain it; inspect with \`gnubok_query_journal\`. |

\`declaration_checks\` codes you can meet: \`RC_BASIS_MISSING\`, \`RC_OUTPUT_MISSING\`, \`RC_INPUT_VAT_MISMATCH\`, \`TAXABLE_SALES_WITHOUT_OUTPUT\`, \`OUTPUT_VAT_WITHOUT_SALES_BASE\`, \`SALES_OUTPUT_VAT_SHORTFALL\`, \`IMPORT_BASE_WITHOUT_OUTPUT\`, \`IMPORT_OUTPUT_WITHOUT_BASE\`, \`SUMMA_MOMS_DRIFT\`. Each has a \`status\` (\`ERROR\` blocks filing, \`WARNING\` needs a human look) and the \`rutor\` involved.

\`sanity.anomalies\` compares with the previous period: \`output_vat_ratio_drift\` (wrong rate somewhere), \`revenue_drop\` (unbooked invoices?), \`revenue_spike\` (something booked twice?). Raise each as a question to the user; they are not errors by themselves.

**When the period is not fully booked or reconciled:** do not treat the rutor as final and do not validate or submit. Tell the user exactly which blockers remain, offer the sibling skill for each, and either stop there or continue the review clearly labelled as preliminary ("preliminär, perioden är inte klar"). After the fixes are approved, run \`gnubok_vat_close_check\` again; never assume a fix landed.

**Kontantmetoden:** under \`accounting_method: cash\`, moms is recognised when paid, so unpaid customer and supplier invoices are correctly absent from the period. Exception: at fiscal year-end open invoices must be brought in. If this period contains the fiscal year-end, ask whether the year-end cut-off from \`year-end-close\` has been done before filing. Faktureringsmetoden is required above 3M SEK omsättning; if a cash-method company looks larger than that, raise it as a question, do not change anything.

## Step 2: Read the declaration ruta by ruta

\`gnubok_get_vat_report({ period_type, year, period })\` returns the rutor, a \`summary\`, \`warnings\` and \`excluded_settlement_entries\`. Pass \`render_ui: true\` to also open the review widget on claude.ai or Claude Desktop (\`gnubok_vat_review_widget\` is an alias). The widget is optional: every other harness uses the structured data, and so should you.

The report is a trimmed view (05, 10-12, 30-32, 35, 39, 40, 48, 49, 60-62). The full SKV 4700 projection that would actually be filed, including rutor 20-24 and 50, is \`momsuppgift\` in the \`gnubok_vat_declaration_validate\` result (step 5). Review against that when you have it.

What each ruta means and where it comes from (BAS):

| Ruta | Meaning | Main BAS accounts |
|------|---------|-------------------|
| 05 | Momspliktig försäljning not in another ruta | 3001-3003, 35xx |
| 06 / 07 / 08 | Momspliktiga uttag / vinstmarginal / hyra med frivillig skattskyldighet | 3401-3403 / 3211, 3212, 3220 / 3913 |
| 10 / 11 / 12 | Utgående moms 25 / 12 / 6 % | 2611 / 2621 / 2631 (plus 2612-2613, 2616 and the 262x/263x equivalents) |
| 20 | Inköp varor från annat EU-land | 4515-4517 |
| 21 | Inköp tjänster från annat EU-land (huvudregeln) | 4535-4537 |
| 22 | Inköp tjänster från land utanför EU | 4531-4533 |
| 23 / 24 | Inköp varor / tjänster i Sverige, köparen betalningsskyldig | 4415-4417 / 4425-4427 |
| 30 / 31 / 32 | Utgående moms på rutor 20-24, 25 / 12 / 6 % | 2614 / 2624 / 2634 |
| 35 | Varor till annat EU-land | 3108 |
| 36 | Varor utanför EU (export) | 3105 |
| 37 / 38 | Trepartshandel, mellanmans inköp / försäljning | 4512 / 3107 |
| 39 | Tjänster till EU-företag (huvudregeln) | 3308 |
| 40 | Övriga tjänster omsatta utom landet | 3305 |
| 41 | Försäljning där köparen är betalningsskyldig i Sverige | 3231-3233 |
| 42 | Övrig försäljning (momsfri m.m.) | 3004, 3404, 3980, 3994 |
| 48 | Ingående moms att dra av | 2641, 2645, 2646, 2647, 2649 (deductible part only) |
| 50 | Beskattningsunderlag vid import | 4545-4547 |
| 60 / 61 / 62 | Utgående moms på import 25 / 12 / 6 % | 2615 / 2625 / 2635 |
| 49 | Moms att betala eller få tillbaka | computed; cleared to 2650 |

Ruta 49 = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48.

Walk the user through it in plain words: sales and output VAT first, then purchases with omvänd skattskyldighet, then EU and export sales, then ingående moms, then ruta 49. Point out any ruta that is unexpectedly zero or nonzero for this business (a consultant with no EU customers and a ruta 39, a shop with no ruta 05).

**Ruta 49:**

- **Positive**: moms att betala. The payment must reach the skattekonto by the filing deadline (SFL 62 kap 3 §); give the user \`net_due\` and \`deadline_label\` from the close check.
- **Negative**: moms att få tillbaka. Normal for a period with large purchases, an investment, mostly EU or export sales, or a start-up. Still ask one question when it is unusual for this company ("Ni får tillbaka 18 400 kr, mest ingående moms på en maskin i mars. Stämmer det?"), because an overclaimed deduction is the classic skattetillägg case (20 % of the overclaimed amount).
- **Zero with activity in the period**: suspicious. Check that the rutor are not empty because nothing was booked.
- If you compute anything yourself (a sum or a difference), round to whole öre and compare with the tool's figure; the tool's figure wins, and a mismatch is a question, not a correction.

## Step 3: Drill into anything that looks wrong

Use \`gnubok_query_journal\` with the period's dates and the accounts in question, for example \`{ accounts: ["2611"], date_from: "2026-01-01", date_to: "2026-03-31" }\`, or \`{ account_from: "2640", account_to: "2649", date_from, date_to }\` for ingående moms. Account numbers are always strings. \`gnubok_get_general_ledger\` takes a fiscal \`period_id\` plus \`account_from\` / \`account_to\` when you need opening and closing balances.

Typical findings (from the Swedish VAT rule pack):

- **Reverse charge booked on one side, or not at all.** An EU or non-EU purchase (IT services, Google, Meta, consultants) needs the purchase in ruta 20/21/22, output VAT on 2614/2624/2634 (ruta 30-32) AND the matching ingående moms on 2645 (ruta 48). Silent netting is prohibited. Reverse-charge output VAT posted on 2611 inflates ruta 10 instead of ruta 30. \`RC_BASIS_MISSING\` / \`RC_OUTPUT_MISSING\` / \`RC_INPUT_VAT_MISMATCH\` point here.
- **Domestic omvänd skattskyldighet** (byggtjänster between construction businesses, scrap, investment gold, mobile phones/computers/game consoles on an invoice over 100 000 SEK) goes in ruta 23/24 with 2647 on the buyer side; the seller reports ruta 41.
- **EU sales.** Services to an EU business belong in ruta 39, goods in ruta 35, not in ruta 05. Both also go on the periodisk sammanställning, a separate filing (electronic deadline the 25th of the month after the period) that these tools do not file: remind the user.
- **Import.** Since 2015 import VAT is reported to Skatteverket in the momsdeklaration: ruta 50 base, ruta 60-62 output, the deduction in ruta 48. Paying it to Tullverket as well is double counting.
- **Wrong rate.** 6 % covers books, newspapers, passenger transport, cultural and sports admission, certain repairs, and dance events from 1 July 2026; 12 % food and hotel (food drops to 6 % from 1 April 2026); 25 % the rest. \`output_vat_ratio_drift\` often means a rate error.
- **Representation.** Ingående moms is deductible only on a base of at most 300 SEK excl. moms per person and occasion. Full deduction on a dinner is an error.
- **Mixed verksamhet.** A company with both VAT-liable and VAT-exempt sales may only deduct proportionally (HFD 2023 ref. 45). Full deduction on shared costs is an error; the proportion is a human decision.
- **A ruta disagrees with the ledger.** Check \`excluded_settlement_entries\` first: momsredovisning verifikat are kept out of the rutor on purpose.

When you find an error: explain it with the verifikat number, date, amount and the ruta it moves. Never edit a posted verifikat. The correction is a new booking in an open period, staged for the user, through the \`bookkeep\` skill (or \`gnubok_correct_entry\` / \`gnubok_reverse_journal_entry\` for one specific wrong verifikat, both staged and high risk). Then re-run step 1.

## Step 4: Questions to ask the user

Ask one precise question at a time, with the facts you already have. Good: "Hetzner (Tyskland) fakturerade 1 249 kr i mars utan moms. Ska den redovisas som EU-tjänst i ruta 21 med omvänd moms, eller är det en privat utgift?" Bad: "Vad ska jag göra med Hetzner?"

- **At the start:** which period, and what "done" means (reviewed only, or filed).
- **An unusual ruta** or an anomaly from the close check.
- **A foreign supplier** without VAT on the invoice: EU or outside EU, goods or services, business or private.
- **A purchase that may be private or representation.**
- **A missing receipt** behind a large deduction.
- **A negative ruta 49** that is unusual for this company.
- **Before anything is submitted:** see step 6.

## Step 5: Validate (Skatteverket connected)

\`gnubok_vat_declaration_validate({ period_type, year, period })\` sends the declaration to Skatteverket's kontrollera endpoint (read-only, nothing is saved there) and runs the same local completeness checks as the web filing UI. Read two flags separately:

- \`arithmetic_ok\`: Skatteverket found no errors in \`kontrollresultat\`. This only means the figures add up; a declaration of all zeros passes.
- \`completeness_ok\`: our checks found no ERROR in \`completeness_checks\`. False means the declaration is incomplete and must not be filed.

Both must be true before step 6. Show the user \`momsuppgift\` (the exact rutor that would be filed) and \`summary\`, and list any warnings.

Also call \`gnubok_vat_declaration_status({ period_type, year, period })\` before submitting. \`submitted\` and \`decided\` are null when nothing is on file. If a declaration is already submitted or decided for the period, stop: filing again is a correction of a filed declaration and needs the user's explicit decision (see Stop conditions).

## Step 6: Submit, only on an explicit yes

Before staging, ask and get a clear answer to all of these, in one message:

1. "Stämmer rutorna?" Show every nonzero ruta, and ruta 49 with pay or refund and the deadline.
2. Every open WARNING and every question from step 4 is answered.
3. They understand that approval sends the declaration for BankID signing, and it is filed only when they sign.
4. They are firmatecknare or deklarationsombud and can sign with BankID now.

Only then: \`gnubok_vat_declaration_submit({ period_type, year, period })\`. It re-runs kontrollera and stages a \`submit_vat_declaration\` pending operation with risk level \`high\`. It does NOT run the completeness checks, which is why step 5 is mandatory. Nothing is sent yet.

Approval:

- claude.ai / Claude Desktop: \`gnubok_list_pending_operations({ render_ui: true })\` opens the approval widget; the user approves there.
- ChatGPT, Grok, local agents (no widget): show the staged preview (period, rutor, kontrollresultat) and ask. On a clear yes in this conversation, call \`gnubok_approve_pending_operation({ operation_id, confirmed: true })\`. \`confirmed: true\` is required for a high-risk operation and is only passed after that yes. Otherwise point them to Granskning in Accounted.

After approval the result carries a \`signing_url\`: give it to the user and ask them to sign with BankID. When they say they signed, call \`gnubok_vat_declaration_status({ period_type, year, period, state: "submitted" })\`. Report "inlämnad" only when \`submitted\` is no longer null.

After filing, remind the user of the payment (ruta 49 positive) and that the momsredovisning verifikat (26xx cleared to 2650) is booked from the momsdeklaration report in Accounted. Synced skattekonto rows are booked with \`gnubok_book_skattekonto_rows\` (search-only, reach it via \`gnubok_stage_tool\` if your client needs to; staged); do that only if the user asks.

## When Skatteverket is not connected

- \`gnubok_connect_skatteverket\` returns \`available: false\` (or a tool fails with \`EXTENSION_DISABLED\`): the integration is not enabled on this installation. Do the full review (steps 0-4; \`gnubok_vat_close_check\` already carries the same completeness checks as step 5), then tell the user to file the momsdeklaration themselves at skatteverket.se with the reviewed figures; Accounted can download the declaration as a file.
- \`available: true, connected: false\`, or any Skatteverket tool fails with \`SKATTEVERKET_NOT_CONNECTED\`: give the user \`connect_url\` (on claude.ai a connect card renders) and explain they sign in with BankID as firmatecknare. Personal Skatteverket sessions last about an hour, so an expired connection is normal. Do not retry until they say they reconnected.
- \`SKATTEVERKET_ACCESS_DENIED\`: the signed-in person lacks authority for this company at Skatteverket (firmatecknare or deklarationsombud). Only the user can fix that; stop.
- \`SKATTEVERKET_RATE_LIMITED\`: wait, then retry the read once.

## When a tool call fails

- **Validation error** (wrong \`period_type\`, \`period\` out of range, unknown argument): fix the arguments from the tool schema and call again once. Never guess a field.
- **Not found** (company, period, operation): re-read with the list tool; do not invent an id.
- **Period locked / closed** on a correction you staged: do not work around it. A locked month can only be unlocked by the user (\`gnubok_unlock_period\` is staged, high risk): ask first and say why. A closed year: stop.
- **409 / conflict** (an operation already consumed, a duplicate submission): re-read state (\`gnubok_list_pending_operations\`, \`gnubok_vat_declaration_status\`) before doing anything else. Never stage the same submission twice.
- **Staged for approval**: that is success, not an error. Nothing is committed until the user approves.
- **\`capability_blocked\` (403) on approval**: the company's plan does not include Skatteverket filing. Tell the user; they file manually at skatteverket.se.
- **\`SKATTEVERKET_SUBMIT_REJECTED\`** or \`SKATTEVERKET_API_ERROR\`: show Skatteverket's message verbatim, do not retry a write blindly, re-run step 5.

## Stop conditions: this needs a human

Stop and hand over, phrased as "Det här behöver en människa: här är vad jag hittade" plus the facts, when:

- The period already has a submitted or decided declaration and the numbers now differ (a correction of a filed declaration).
- A correction would land in a closed fiscal year.
- Place of supply is unclear: property services, passenger transport, restaurant/catering or event admission abroad, triangulation, chain transactions.
- Mixed verksamhet: the deduction proportion, or jämkning on a capital good.
- Representation vs private, or a large deduction without underlag.
- \`deadline_unavailable\` or a missing cadence the user cannot confirm.
- The rule pack does not answer the question. Do not answer Swedish VAT from memory.

## Rules

- Never submit without the explicit yes in step 6, and never pass \`confirmed: true\` on your own initiative.
- Never file while \`ready_to_close\` or \`completeness_ok\` is false.
- Never edit, delete or re-date a posted verifikat. Corrections are new, staged bookings in an open period.
- Never invent an amount, a deadline, a ruta or an account. Numbers come from the tools; account numbers are strings.
- Never unlock a period or attest a supplier invoice without asking.
- The review widget is optional. Everything in this skill works from the structured results.

## Report format

End with short groups, in the user's language:

- **Klart**: period, cadence, rutor reviewed, ruta 49 (pay or refund, amount, deadline).
- **Väntar på godkännande**: staged operations (submission, corrections, attestations).
- **Behöver ditt svar**: each open question, one line each.
- **Kunde inte göra**: what and why (blocker, missing connection, stop condition).
- **Nästa steg**: the one thing that moves this forward (sign with BankID, answer X, run \`reconcile-month\`).

## Tools

- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`, \`gnubok_list_fiscal_periods\`: orientation
- \`gnubok_vat_close_check\`: readiness, cadence, deadline, blockers, completeness checks
- \`gnubok_get_vat_report\` (\`render_ui\` optional), \`gnubok_vat_review_widget\` (alias): the rutor
- \`gnubok_query_journal\`, \`gnubok_get_general_ledger\`: drill into 26xx and the underlying accounts
- \`gnubok_get_reconciliation_status\`, \`gnubok_list_uncategorized_transactions\`: readiness detail
- \`gnubok_approve_supplier_invoice\`: stage attestation (user decides)
- \`gnubok_connect_skatteverket\`: connection status and link
- \`gnubok_vat_declaration_validate\`, \`gnubok_vat_declaration_status\`: Skatteverket reads
- \`gnubok_vat_declaration_submit\`: stage the filing (high risk)
- \`gnubok_list_pending_operations\`, \`gnubok_approve_pending_operation\`, \`gnubok_reject_pending_operation\`: approval
`

export const quarterlyVatReviewSkill: Skill = {
  slug: 'quarterly-vat-review',
  name: 'Momsdeklaration',
  summary:
    'Review and file the momsdeklaration for a monthly, quarterly or annual period: cadence, readiness, ruta-by-ruta review, reverse charge, validation, BankID filing via approval.',
  tags: ['vat', 'moms', 'momsdeklaration', 'monthly', 'quarterly', 'yearly', 'compliance', 'skatteverket'],
  body,
  tier: 'workflow',
  // Only surfaces for VAT-registered companies. Most are; a hobby/below-tröskel
  // EF without VAT registration shouldn't see this in its skill list.
  applicability: { entity_type: 'both', requires: ['vat_registered'] },
}
