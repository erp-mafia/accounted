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

Shipped scope (PR 4a): the inbox table gains Kategori and Konto columns in shell v2, with per-user column visibility (`ui_state.tx_columns`, gear in the toolbar, `lib/transactions/columns-v2.ts`). The Kategori cell shows the match hint the row already carries (invoice, supplier invoice, ROT/RUT payout, utlägg, verifikat) or prompts "Välj kategori" and opens the existing review dialog. Konto shows bank plus the account's last digits. `ShellProvider` / `useShell()` let client pages branch on the shell. Still to come: the rule dialog after a category change (with PR 5's rules model), drag-to-reorder and saved views, the right drawer and the transfer match view (PR 4b), and the same columns on the history list.

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

Shipped scope (PR 5a): no new table. `categorization_templates` already is the per-counterparty rule (aliases, accounts, VAT, occurrence_count, confidence, source), so the ladder lives there: migration 20260907120000 adds `mode` (proposed / propose / auto / paused), `corrections` and `paused_at`, with a BEFORE trigger that keeps `mode` and `is_active` in step both ways (soft-delete reads as paused, a paused rule stops matching). `insertOrUpdateTemplate` counts corrections. `lib/rules` (model + service), `/api/rules` and `/api/rules/[id]` (GET, PATCH mode), the Regler page with the ladder bar and sentence rows, and the rule page (Om / Gör, "Så här läser Accounted regeln", this year's matches by bank text, origin, trust, links). Regler is a sub-item under Transaktioner in the v2 sidebar. Still to come: 'auto' is refused by the API until the autopilot tier (PR 5b: company opt-in + rule-driven auto-commit under the autonomy envelope); 'proposed' rules (suggest before confirm) need the repetition detector to write mode = proposed instead of activating (PR 5c); the rule dialog after a category change on Transaktioner; merging booking_template_library into a `then` action (it stays Mallar for now).

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
