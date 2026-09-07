# UI v2 build plan: from the "Hela året" prototype to the product

Written 2026-09-07. Source: the prototype at claude.ai/code/artifact/8937d889 (v19), built on Kick's layout in Accounted's design system, and the founder decisions taken the same day (DECISIONS.md, 2026-09-07). This document is the sequence and the models; the prototype is the picture.

## Decisions this plan rests on

1. Shell v2 is full-bleed: no centered column, page title in a 48 px top bar, primary action top-right. Per-user opt-in until it is the default.
2. Home is one queue: Att göra on `lib/worklist` plus `pending_operations`. Ingest creates the proposal, so every row arrives with a suggestion. Object pages become registers.
3. Autopilot is allowed as an opt-in per company. A rule may book on its own after five hits without a correction. Proposals-only stays the default.
4. One rules model. The three learning systems merge into one table and one word in the UI: Regler.
5. Receipt chasing (card-to-person asks) is designed but not built now.
6. Supplier invoices get "in payment file" and "reconciled" states, shaped so in-system payment initiation can replace the bank-file step later.
7. Cheap removals: the defer-booking toggle, the Ny verifikation sub-doors, attest hidden for kontantmetod companies.

## Sequence

Each PR is independent and reviewable. The order follows dependency, not page order.

### PR 1: shell v2 behind a flag (this PR)

- `user_preferences.ui_state.shell` ('v1' | 'v2'), written from Inställningar → Konto → Layout.
- Layout renders `data-shell` on `#main-content`; `MainContainer` drops the max-width in v2.
- `PageHeader` keeps its markup and becomes the top bar through `[data-shell="v2"]` CSS. No page is edited, and v1 is byte-identical.
- design.md conventions 1, 2 and 9 carry the addendum.

Done when: any page renders in both shells, the toggle persists, lint and tests are green.

### PR 2: sidebar and top bar to the prototype's proportions

- Sidebar 220 px with 15 px icons, company chip at the top, Enheter group.
- The avatar menu stays at the bottom of the sidebar in PR 2; moving it and the plus into the top bar is part of PR 9 (cutover polish), since the top bar is the page header and lives inside each page.
- Nav IA: Att göra, Aktivitet, then Konton, Transaktioner, Fakturering, Inköp, Bokföring, Löner, Skatt, Rapporter, Bokslut. Sub-pages become section pickers in the toolbar row instead of nav items.

### PR 3: Att göra as three panes on the worklist

- Left: task tree grouped Löpande / Stäng månad / Moms / Bokslut with counts, from `lib/worklist` categories plus `pending_operations` ("Assistentens förslag").
- Middle: the task detail, starting with Granska utgående and Granska inkommande (row-centric review, approve selected).
- Right: Detaljer (deadline, lagrum), Beroenden, task-scoped assistant message.
- Dependencies come from the worklist's done conditions, not from new state.
- Requires propose-at-ingest: the categorisation pipeline writes a proposal on arrival instead of on open.

Shipped scope (PR 3a): the three panes on the real worklist (`lib/worklist/tasks-v2.ts` builds the tree from the counts; groups Kom igång / Löpande / Bevaka / Skatt). Middle-pane lists with actions: suggested matches (Bekräfta), supplier invoices (Attestera, Attestera alla), agent proposals (Godkänn / Avvisa). Lists that show rows and open their page: transactions, inbox documents, expense payouts, overdue invoices, deadlines, bank consent. Link-only for now: skattekonto rows, verifikat without documents, accounts to reconcile. Row-centric transaction review with approve-in-place lands with PR 4's table (PR 3b embeds it here). The right pane reads deadline, lagrum and dependencies from the model and shows a task-scoped assistant line with "Fråga assistenten" (opens the agent sheet with general.help). Not a chat thread yet.

### PR 4: Transaktioner table

- Columns: checkbox, Datum, Beskrivning, Kategori (icon), Klass, Konto (institution mark), Belopp, Enhet, Åtgärd. Column settings (order, pin, hide) and saved views in `ui_state`.
- Inline category picker that offers the rule dialog after a change ("Accounted hittade N liknande").
- Right drawer for a row; match view for transfers.

### PR 5: one rules model

Migration `rules` (per company):

| column | meaning |
|---|---|
| id, company_id | |
| when | jsonb list of conditions: counterparty, text contains, direction, amount range, account |
| then | jsonb list of actions: category/account, VAT treatment, template, class or dimension, document expectation, question to ask |
| origin | 'correction' \| 'repetition' \| 'answer' \| 'system' \| 'manual' |
| origin_ref | verifikat or transaction id the rule was born from |
| mode | 'proposed' \| 'propose' \| 'auto' \| 'paused' |
| hits, corrections | counters, updated when a match is approved or changed |
| last_match_at, last_match_ref | |
| created_at, updated_at, edited_note | |

- Backfill: categorization_templates and counterparty templates become rows with origin 'repetition' or 'correction'; booking_template_library entries become templates a `then` action can reference.
- Mode ladder: proposed → propose (user confirms) → auto (five hits, zero corrections, company autopilot on). A correction sets paused.
- Amounts over the company's confirm threshold (default 10 000 kr) are always confirmed regardless of mode.
- UI: Regler page with the four-step bar, sentence rows, and a rule page (Om / Gör / Utom, "Så här läser Accounted regeln", matches this year, origin, trust, links).
- Agents: the same table behind `list_rules` and the existing categorisation tools.

### PR 6: Inköp lifecycle

- `SupplierInvoiceStatus` gains `in_payment_file` and `reconciled`. Betalfil batches already exist; "in payment file" is set when a batch includes the invoice, "reconciled" when the bank row is matched in reconciliation.
- Payment initiation later: the step "I betalfil" becomes "Betalas" with two implementations (file to bank, or initiation through the bank connection). The state machine does not change, only the actor.
- Pipeline bar on the list with counts per step, the invoice page with document, kontering, betalning and kopplat, one primary per step.
- Kontantmetod companies do not see attest.

### PR 7: Underlag

- Inkorg with the pipeline bar and the "Tar emot från" channel line (existing intake address, WhatsApp when live, Peppol, upload).
- Underlag rows link to the bank row or the invoice they belong to; "Svara vad det var" creates the own document per BFL 5 kap. 6–7 §§.
- Chasing is out of scope in this PR (decision 5).

### PR 8: registers as lists

Fakturering, Bokföring, Löner, Skatt, Rapporter, Bokslut and Konton get the toolbar row, the section picker and the one-line table. Existing editors stay. This is the long tail and can be split per page.

### PR 9: cutover

Shell v2 becomes the default, v1 is removed, design.md conventions 1, 2 and 9 lose their addenda and state v2 plainly.

## What the prototype fakes and the product must do for real

- Assistant answers (canned in the prototype): task-scoped opening message from worklist data, questions to the existing assistant.
- Live categorisation and OCR: the existing pipelines, with proposals written at ingest.
- "Bokför själv": auto-commit through the engine under the autonomy envelope, only when company autopilot is on and the rule is in mode auto.
- Activity: `processing_history`, never `event_log`.

## Out of scope for now

Receipt chasing and card-to-person mapping, Kivra and Gmail scanning, the byrå shell beyond the Klienter list, mobile layout for the three-pane home (the right pane collapses below 1240 px in the prototype; the product needs a real mobile answer before PR 3 ships to phones).
