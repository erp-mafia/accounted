/**
 * Risk tier classification for pending_operations.
 *
 * Stamped as risk_level on staged proposals (MCP server staging,
 * lib/receipt-hunt/hunt.ts). Agent auto-commit was removed in #394
 * (20260505190027_drop_agent_auto_commit): every staged operation needs
 * human approval, whatever its tier.
 *
 * Tiering principles:
 *   - **low**: no booking impact, no external side-effects, no audit risk.
 *   - **medium**: reversible booking impact (drafts, transaction
 *     categorization that can be uncategorized).
 *   - **high**: irreversible or compliance-critical. Sends external messages,
 *     locks/closes periods, or affects tax filings. Excluded from bulk
 *     approval, and the approval card asks for a typed confirmation.
 */

import { WEB_ONLY_CASE_ACTIONS } from '@/lib/collections/stages'

export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * Every pending operation type with its tier: the ONE hand-kept list of
 * operation types. PendingOperationType, PENDING_OPERATION_TYPES and the
 * approval label keys (components/pending-operations/vocabulary.ts) are
 * derived from it, so a type added here has a type, a tier and a label key
 * at once (operation-contract.test.ts checks the translations). The
 * pending_operations CHECK constraint is the database's own copy; the pg
 * audit compares it with this list.
 */
const RISK_TIERS = {
  // ── Low: pure data, no booking impact ─────────────────────────────
  create_customer: 'low',
  update_customer: 'low',
  // Article catalog (artikelregister) is app-level master data: no journal
  // impact, no external side-effect. Unlike create_supplier it carries no
  // payment-routing fields, so there's no BEC/fraud surface; both create and
  // update sit at the lowest tier next to create_customer.
  create_article: 'low',
  update_article: 'low',
  // A draft inventeringslista (year-end stock count): no booking until a
  // person signs it and the booking is approved on its own.
  save_inventory_count: 'low',
  // Dimension values (kostnadsställe/projekt object codes, SIE #OBJEKT) are
  // reporting master data: no journal impact, no external side-effect, no
  // payment-routing surface. Staged (agents never silently mint reporting
  // values) but at the lowest tier next to create_customer/create_article.
  create_dimension_value: 'low',
  create_dimension: 'low',
  // Budgets (accounted#134) are planning data, not räkenskapsinformation: no
  // booking, no external side-effect, deleted freely.
  create_budget: 'low',
  update_budget: 'low',
  delete_budget: 'low',
  upsert_budget_lines: 'low',
  copy_budget_actuals: 'low',
  spread_budget: 'low',
  // Operation registry, wave 4: Peppol, årsredovisning, IB, AP actions.
  send_invoice_peppol: 'high',
  register_peppol_participant: 'high',
  request_peppol_access: 'medium',
  update_arsredovisning_narrative: 'medium',
  update_arsredovisning_compliance: 'medium',
  create_arsredovisning_version: 'high',
  add_arsredovisning_signature: 'medium',
  set_opening_balances_manual: 'high',
  correct_opening_balances: 'high',
  // Inline rättelse of the IB verifikat (#3313): same tier as correct_entry_lines_inline.
  split_opening_balances_per_project: 'high',
  // POS sales: connecting only starts fetching; the mapping decides future
  // vouchers; booking posts the daily takings voucher.
  connect_pos_venue: 'low',
  disconnect_pos_connection: 'medium',
  update_pos_sales_settings: 'medium',
  book_pos_sales_day: 'high',
  // Webshop orders: booking posts the order's verifikat with the caller's lines.
  book_webshop_order: 'high',
  book_webshop_day: 'high',
  // Collections: a customer's claim goes to, or a decision is sent to, the
  // company's collections provider, which writes to the customer. External
  // and not undone by a later call. Handing over and escalating are also
  // approvable only in the web UI (requiresWebApproval below).
  open_collection_case: 'high',
  collection_case_action: 'high',
  // Collections bookings post vouchers (corrected only by the rebook or a
  // storno of the payout voucher). Obligation work, approvable by an agent.
  book_collected_payment: 'high',
  book_collection_settlement: 'high',
  // Cron-staged (the daily collections batch): hands invoices over and
  // approves next steps against customers; an administrator approves it in
  // the web UI only.
  collections_daily_batch: 'high',
  // The daily reminder batch emails the company's customers (lib/reminders).
  reminder_daily_batch: 'high',
  record_customer_loss: 'high',
  // The lagerförändring of a signed inventeringslista: a bokslut verifikat
  // that changes the year's result, undone only by a storno.
  book_inventory_count: 'high',
  // Kvittning books a verifikat and lowers a customer and a supplier invoice;
  // undone only by a storno of that verifikat.
  book_counterparty_setoff: 'high',
  delete_supplier_invoice: 'medium',
  uncredit_supplier_invoice: 'high',
  // Header only (due date, reference, numbers, notes), nothing booked; medium
  // like update_invoice: the due date and the reference steer the payment.
  update_supplier_invoice: 'medium',
  update_supplier_invoice_item_account: 'high',
  // Operation registry, wave 3: documents, transactions, rättelse, filing.
  delete_document: 'medium',
  delete_inbox_item: 'medium',
  detach_document_from_transaction: 'low',
  // Underlag behind a customer invoice (accounted#42): a reference to an
  // archived document, no verifikat, nothing sent; undone by the other one.
  attach_invoice_underlag: 'low',
  detach_invoice_underlag: 'low',
  unmatch_inbox_item_transaction: 'low',
  // What an underlag bought (its purchase category), and with every_time the
  // matched supplier's instruction: a label beside the kontering, no
  // verifikat, undone by setting it again.
  set_inbox_purchase_category: 'low',
  // What an archived document is (its Arkiv type, crm#2016): the shelf it
  // sits on and the schema it is read with, no verifikat; set again to undo.
  set_document_type: 'low',
  undo_bank_import: 'high',
  correct_entry_metadata: 'high',
  correct_entry_lines_inline: 'high',
  // Re-plans months not yet posted; posted verifikat never change.
  replan_accrual_schedule: 'low',
  // A periodisering set up by hand books its elapsed months at approval; its
  // undo stornoes the months it posted (lib/bookkeeping/accruals/manual.ts).
  create_accrual_schedule: 'medium',
  cancel_accrual_schedule: 'medium',
  // K3 (lib/operations/k3.ts): a nedskrivning or a component replacement
  // books a verifikat undone only by storno; the transition voucher too. The
  // split at the transition books nothing but sets the basis every later K3
  // depreciation plans from, and the 18.7 model is an accounting policy.
  post_asset_value_adjustment: 'high',
  replace_asset_component: 'high',
  set_asset_tax_plan: 'low',
  set_asset_transition_split: 'medium',
  save_deferred_tax_inputs: 'low',
  update_accounting_policies: 'medium',
  start_k3_transition: 'low',
  update_k3_transition: 'low',
  delete_k3_transition: 'low',
  commit_k3_transition: 'high',
  redate_entry: 'high',
  mark_no_document_required: 'medium',
  book_vat_settlement: 'high',
  // Momsdeklaration filing record: completes or reopens the period's moms
  // deadline and nothing else (no verifikat, nothing sent to Skatteverket).
  // A Skatteverket-confirmed filing is never relabelled or reopened.
  mark_vat_period_filed: 'low',
  unmark_vat_period_filed: 'low',
  // A person's review of an advisory momsdeklaration WARNING (crm#1171): no
  // verifikat, nothing sent; never applies to an ERROR, lapses when the
  // figures change.
  mark_vat_check_reviewed: 'low',
  // Confirming the opening balance review an SIE import raised on the next
  // year (crm#1967): clears the review and logs who and when; no verifikat.
  acknowledge_opening_balance_review: 'low',
  // "Rättelse, inte momsredovisning" and its withdrawal (crm#1849): no
  // verifikat and reversible, but it changes the rutor and whether the
  // period counts as settled, so never low.
  mark_not_momsredovisning: 'medium',
  withdraw_not_momsredovisning: 'medium',
  mark_agi_period_filed: 'low',
  // A tick on a deadline, or its undo (crm#1848): a reminder, no verifikat,
  // period or filing.
  complete_deadline: 'low',
  // Operation registry, wave 2: booking, payment files, utlägg, payroll.
  send_payslips: 'medium',
  revert_salary_run: 'low',
  unapprove_salary_run: 'medium',
  attach_salary_expense_claims: 'medium',
  // Payroll over MCP (lib/operations/salary-run-structure.ts and
  // salary-employee-setup.ts). No verifikat, but each changes a pay outcome
  // (who is paid, a payslip line, hours, a förmån, a recurring line), so human
  // review at medium like update_payslip_line and set_run_salary, stricter
  // than the v1 doors' 'low'. Marking a run paid records that the money left.
  // Deactivating an employee cannot be undone on the API. The correction run
  // storno-reverses the run's verifikationer: high, like booking it.
  add_salary_run_employee: 'medium',
  remove_salary_run_employee: 'medium',
  add_payslip_line: 'medium',
  delete_payslip_line: 'medium',
  mark_salary_run_paid: 'medium',
  correct_salary_run: 'high',
  set_worked_days: 'medium',
  delete_worked_days: 'medium',
  add_employee_benefit: 'medium',
  update_employee_benefit: 'medium',
  delete_employee_benefit: 'medium',
  add_employee_recurring_line: 'medium',
  update_employee_recurring_line: 'medium',
  delete_employee_recurring_line: 'medium',
  delete_employee: 'medium',
  create_supplier_payment_batch: 'high',
  cancel_supplier_payment_batch: 'medium',
  // Bank payments: a prepared order is a draft a person still approves and
  // signs with BankID; a cancel only counts when the bank confirms it.
  prepare_payment_orders: 'medium',
  cancel_payment_order: 'medium',
  // The signatory link mints a 7-day credential URL (and may mail it); the
  // consent itself is still signed by the firmatecknare with BankID.
  bank_feed_invite: 'medium',
  // The payment signing link mints a 72-hour credential URL (and may mail it); the
  // payments are still signed by the firmatecknare with BankID at the bank.
  request_payment_signature: 'medium',
  // A signing request mints one credential link per signer (up to 90 days) and
  // mails it; each signer still signs in person with BankID. A reminder mails
  // a pending signer a new link.
  request_signature: 'medium',
  remind_signature: 'low',
  // The board's årsredovisning: the same links, one per signer slot.
  request_arsredovisning_signatures: 'medium',
  // Approving new bank details an invoice states releases payment to that
  // account (and by default writes it on the supplier card): the step an
  // invoice fraud needs. High, and approvable in the web UI only.
  confirm_supplier_payee: 'high',
  book_invoice: 'high',
  bulk_book_invoices: 'high',
  book_supplier_invoice: 'high',
  create_expense_claim: 'medium',
  delete_expense_claim: 'medium',
  record_expense_payout: 'medium',
  match_expense_payout: 'medium',
  // Operation registry, wave 1: setup capabilities.
  create_cash_account: 'low',
  update_cash_account: 'medium',
  set_primary_cash_account: 'medium',
  set_invoice_payee_default: 'medium',
  change_bank_ledgers: 'medium',
  create_fiscal_period: 'medium',
  update_fiscal_period: 'medium',
  close_fiscal_period_external: 'high',
  reopen_fiscal_period_external: 'high',
  delete_fiscal_period: 'high',
  delete_account: 'medium',
  activate_accounts: 'low',
  deactivate_accounts: 'low',
  // Two fields on kontoplan rows that decide where the OSS underlag places a
  // verifikat: no verifikat changes, and the same call takes it back.
  set_oss_account_countries: 'low',
  update_company_tax_profile: 'high',
  update_bookkeeping_lock: 'high',
  // Revoking a service account (lib/service-accounts) revokes every key it
  // has, at once and for good: no booking impact, but final, and an
  // integration stops mid-run. The commit re-checks that the approver is an
  // owner or admin (revoke_service_account, migration 20261016120000).
  revoke_service_account: 'high',
  // Package switches (Profiles and Suggestions, step 3; lib/suggestions):
  // a company's choice to show or hide a package such as Lön. No booking
  // impact and no external side-effect, and either switch is undone by the
  // other. Switching off closes the package's start doors only: what is
  // still open keeps it winding down until settled (migration
  // 20261016230000), and the commit re-checks that the approver is an owner
  // or admin.
  enable_package: 'low',
  disable_package: 'low',
  // Grants (Profiles and Suggestions, step 4; lib/grants): a company rule
  // that lets a key credential book one known counterparty's bank lines
  // without a person, within limits. Creating one hands posting authority to
  // agents, so it is high (never in a bulk approval, the approver confirms
  // it) and web-only (WEB_ONLY_APPROVAL_TYPES below): only an owner or admin
  // approving in the app accepts it, never an agent or a key. Revoking only
  // takes authority away and books nothing.
  create_grant: 'high',
  revoke_grant: 'low',
  update_dimension: 'low',
  // Deleting is refused by the DB guard when anything is booked on the
  // dimension, but it removes the dimension and its values for good.
  delete_dimension: 'medium',
  // Account dimension rules: bookkeeping policy over reporting tags, no
  // journal impact. A required rule can refuse a later booking until its
  // line is tagged, and that booking says so (MANDATORY_DIMENSION_MISSING);
  // each change is undone in one call.
  create_dimension_rule: 'low',
  update_dimension_rule: 'low',
  delete_dimension_rule: 'low',
  // Kontoplan reference data: adding an account has no journal impact (a
  // wrong account only becomes bookable, nothing is booked), and update is
  // limited to name/description/VAT-default/SRU/is_active: the same surface
  // update_article covers for articles. No payment routing, no external
  // side-effects.
  create_account: 'low',
  update_account: 'low',
  // Verifikat notes are annotation metadata, not räkenskapsinformation: the
  // journal_entries immutability trigger (20260608120000) permits exactly a
  // notes-only diff on committed entries and rejects anything more, so the
  // op cannot touch booking data even if tampered with.
  set_voucher_note: 'low',
  // A draft holds no voucher number and the row survives as cancelled.
  cancel_draft_entry: 'low',
  // Makulera a quote or proforma: neither carries a verifikat, and the row
  // survives as cancelled (lib/operations/invoice-cancel.ts).
  cancel_quote_or_proforma: 'low',
  // A fact in Arkiv: no journal impact, reverted in one call (revert_company_fact).
  arkiv_propose_fact: 'low',
  // Ignoring a bank transaction flips transactions.is_ignored and nothing
  // else: no verifikat, no ledger impact, reversible with the same op
  // (ignored: false). The DB CHECK transactions_is_ignored_no_journal_entry
  // and the executor's refusal of a booked row keep it off booked rows,
  // so the op cannot hide a booking even if tampered with (issue #1661).
  ignore_transaction: 'low',
  // Kundorder (sales orders) never book: an order is the non-ledger document
  // between agreement and invoice. Creating one, moving it through its
  // header state machine (confirm / cancel / reopen) and registering
  // delivered quantities write only sales_orders / sales_order_items, no
  // verifikat and no external side-effect, and all three are re-editable
  // (cancel is refused while invoices exist, reopen undoes it).
  create_sales_order: 'low',
  transition_sales_order: 'low',
  register_sales_order_delivery: 'low',

  // ── Medium: reversible booking ─────────────────────────────────────
  categorize_transaction: 'medium',
  // An existing credit note linked to the invoice it credits (crm#1852): no
  // verifikat, but the invoice leaves the open kundreskontra and no call
  // unlinks it (lib/invoices/link-credit-note.ts).
  link_credit_note_to_invoice: 'medium',
  match_transaction_invoice: 'medium',
  // Skatteverkets ROT/RUT utbetalning matched to its begäran: one bank row
  // booked debit 19xx / credit 1513 and linked. Storno-reversible, but
  // 'high' (2026-10-11) so it stays out of cross-company batch staging and
  // bulk approval, where the old hand-kept batch list kept it.
  settle_rot_rut_payout: 'high',
  // Linking an existing payout verifikat books nothing and a storno of that
  // verifikat releases the link, so it sits with the other link operations.
  link_rot_rut_payout_voucher: 'medium',
  // Anläggningsregister rows are master data: no voucher, editable until
  // depreciation is posted (then ASSET_CORRECTION_BLOCKED routes to storno).
  create_asset: 'low',
  update_asset: 'low',
  // Removes a register row that never reached the books (crm#1452).
  delete_asset: 'medium',
  // Posts the avyttring voucher (gain/loss, VAT, jämkning). Reversible via
  // storno, but 'high' (2026-10-11) so it stays out of cross-company batch
  // staging and bulk approval, where the old hand-kept batch list kept it.
  dispose_asset: 'high',
  // Link an existing posted verifikat as payment for an invoice. Reversible by
  // deleting the invoice_payments row and reverting invoice status; no journal
  // entry is created or modified. Sits next to match_transaction_invoice
  // semantically: both attach an existing booking to an invoice.
  link_invoice_voucher: 'medium',
  // Supplier-side mirror of link_invoice_voucher: link an existing posted
  // verifikat (Dr 2440) as payment for a leverantörsfaktura. Reversible by
  // deleting the supplier_invoice_payments row and reverting status; no journal
  // entry is created or modified.
  link_supplier_invoice_voucher: 'medium',
  // Creates as draft; sending is a separate op. The same type carries
  // gnubok_register_booked_invoice (params.mode 'register_booked', crm#1094),
  // which links an already-booked invoice to its verifikat and cannot be
  // undone. It stays 'medium' on purpose: a kundreskontra of many open
  // invoices is approved in one bulk approval, and the MCP approve commits it
  // without confirmed=true. /pending says "kan inte ångras" on the row and in
  // the bulk line instead (rowConsentSentence, registerBookedInvoiceBulkLine).
  create_invoice: 'medium',
  create_self_billed_invoice: 'high', // registration posts under the accrual method
  // Rewrites a DRAFT in place (header + full item replace). Same tier as
  // create_invoice: the target has no verifikat yet (isEditableInvoiceDraft
  // is re-checked at commit), so the edit is fully reversible by editing again.
  update_invoice: 'medium',
  // Creates an unnumbered DRAFT kundfaktura from a confirmed order through
  // the same builder as create_invoice (nothing is booked or sent at commit;
  // the draft can be deleted). Same tier as create_invoice.
  create_invoice_from_sales_order: 'medium',
  // Recurring invoice schedules: the commit only creates/edits the monthly
  // template (nothing is booked or sent at commit time), and the schedule is
  // pausable/deletable before the next cron run. Not 'low' because an
  // approved schedule keeps generating numbered invoices without any further
  // approval. With params.auto_send === true the schedule also keeps EMAILING
  // the customer every cycle: a standing order for the same external
  // side-effect that puts one-off send_invoice at 'high', so getRiskLevel
  // escalates these two to 'high' when it can see that param.
  create_recurring_schedule: 'medium',
  update_recurring_schedule: 'medium',
  create_transaction: 'medium', // ingests an uncategorized row; reversible by delete
  // Supplier master data carries payment-routing fields (IBAN, BIC, bankgiro,
  // bank_account) that drive outgoing payment files and supplier invoice
  // postings. A wrong account or org_number can enable supplier-fraud / BEC
  // (silently rerouting payment), so always require explicit human approval
  // rather than auto-commit.
  create_supplier: 'medium',
  // Same fields on an existing supplier: rerouting a known supplier's
  // payments is the more likely fraud, so the update is no lower.
  update_supplier: 'medium',
  // Takes a supplier out of the active register (crm#1796). Nothing is
  // booked and un-archiving undoes it; medium like the v1 DELETE, so a
  // person decides which supplier card goes.
  archive_supplier: 'medium',
  // Moves a duplicate customer's invoices, orders and schedules to the card
  // that stays and archives the duplicate (crm#1299). Nothing is booked and
  // the dashboard can undo it, but issued invoices then show the survivor's
  // buyer details: never a silent auto-commit.
  merge_customers: 'medium',
  // Company payment settings control where customers send money on future
  // invoices. Treat changes like supplier payment-routing data: reversible,
  // but never eligible for silent low-risk auto-commit.
  update_company_settings: 'medium',
  // Pinning a doc to a tx is reversible while pre-categorization, but the link
  // becomes part of the verifikation underlag (BFL 5 kap 6 §) once categorize
  // propagates it. A wrong attachment requires a rättelse, so require human
  // approval rather than auto-commit.
  attach_document_to_transaction: 'medium',
  // Linking a doc to a posted verifikation is part of räkenskapsinformation
  // (BFL 5 kap 6 §) and becomes immutable once the JE is posted. Medium so a
  // human confirms the doc-to-verifikat pairing before it locks.
  link_document_to_voucher: 'medium',
  // Same rationale as link_document_to_voucher, N rows in one staged op.
  link_documents_to_vouchers: 'medium',
  // Dimension-only diff on posted lines (verifikat stays immutable), fully
  // audited via dimension_retag_log, but it rewrites reporting history, so
  // it crosses a human at medium.
  retag_line_dimensions: 'medium',

  // ── High: irreversible, compliance-critical, or external side-effects
  send_invoice: 'high',          // emails the customer
  mark_invoice_paid: 'high',     // posts payment journal entry
  mark_invoice_sent: 'high',     // assigns invoice number, accrual JE

  // ── Stream 1 Phase 1 ops (added when those tools land) ─────────────
  close_period: 'high',
  lock_period: 'high',
  unlock_period: 'high',
  set_opening_balances: 'high',
  run_year_end: 'high',
  post_kontantmetod_cutoff: 'high',
  run_currency_revaluation: 'high',
  // Planenlig avskrivning: one journal entry per asset, each independently
  // reversible (storno). Mid-stakes bokslut posting: staged and human-reviewed,
  // but not the irreversible tier that year-end close / period lock occupy.
  post_annual_depreciation: 'medium',
  import_sie: 'high',
  // Hard-deletes the import's journal entries + resets voucher sequences.
  // Same destructive reach as replace_sie_import; never auto-commit.
  undo_sie_import: 'high',
  explain_voucher_gap: 'medium',
  uncategorize_transaction: 'medium',
  approve_supplier_invoice: 'high',
  credit_supplier_invoice: 'high',
  // Create supplier invoice from inbox: stages a `registered` supplier invoice
  // + its line items + document attachment. Reversible until approved (the
  // approval is a separate high-risk op) but creates a leverantörsskuld row,
  // so we route it through human review at medium tier. The same type carries
  // gnubok_register_booked_supplier_invoice (params.mode 'register_booked',
  // crm#1094), which links an already-booked invoice to its verifikat and
  // cannot be undone. Medium on purpose, as for create_invoice's registration:
  // a leverantörsreskontra is approved in one bulk approval, and /pending says
  // "kan inte ångras" on the row and in the bulk line instead.
  create_supplier_invoice_from_inbox: 'medium',
  credit_invoice: 'high',
  convert_invoice: 'medium',
  // Removes a DRAFT (never a posted invoice): no booking impact, but both
  // outcomes are irreversible: an unnumbered draft is hard-deleted (row gone)
  // and a numbered draft is makulerad, permanently consuming its F-series
  // number. 'high' so a destructive delete is never auto-committed.
  delete_draft_invoice: 'high',

  // ── Phase 4: arbitrary-line bookkeeping primitives ─────────────────
  // Both accept caller-supplied account/amount/period: unlike
  // uncategorize_transaction (medium), which mirrors an existing entry.
  // The arbitrary-line capability is what makes these compliance-critical.
  create_voucher: 'high',
  correct_entry: 'high',
  reverse_entry: 'high',

  // ── Payroll ────────────────────────────────────────────────────────
  // Salary run creation materialises a draft + per-employee base lines. The
  // run is reversible while still draft, so 'medium' aligns with other
  // create-draft operations. AGI generation produces the Skatteverket
  // underlag (XML, BFL 7-year retention): statutory artifact, always
  // staged.
  create_salary_run: 'medium',
  generate_agi: 'high',
  // Payslip line edits are draft-run-only (BFL: once the run advances its
  // numbers feed a verifikation) and re-editable until then, but they change
  // a pay outcome: human review at medium, never silent.
  update_payslip_line: 'medium',
  // Draft-only edit of one employee's per-run base salary; no booking impact
  // until the run is calculated and booked (both separately staged).
  set_run_salary: 'medium',
  // Draft-only header edit (payment_date / voucher_series / notes): freely
  // re-editable while draft and changes no pay outcome, matching the v1
  // PATCH's risk: 'low'. A payment_date change clears the roster's
  // calculation_breakdown so a stale calculation cannot be booked, and the
  // booking that makes payment_date matter is separately staged at 'high'.
  update_salary_run: 'low',
  // Absence rows drive sjuklön math and the statutory AGI Frånvarouppgift.
  // Reversible via delete, but not audit-free: medium.
  register_absence: 'medium',
  // Employee master data carries PII (personnummer, encrypted at staging
  // time: pending_operations.params never holds the plaintext) plus bank
  // payment-routing fields: same BEC rationale as create_supplier.
  create_employee: 'medium',
  update_employee: 'medium',
  // Cutover state for mid-year migrations (YTD, vacation balances, karens
  // adjustment). Editable until the employee has a booked run; wrong values
  // skew payslips and the vacation-liability report, so human review.
  set_employee_opening_balances: 'medium',
  // Booking a salary run posts 2-4 immutable verifikationer via the engine
  // (net, tax, avgifter, vacation accrual) and advances the run through
  // approved/paid on the way. Same irreversible tier as create_voucher.
  book_salary_run: 'high',
  // Deleting absence days is the inverse of register_absence and changes
  // sjuklön/karens math for any draft run covering the range: same tier.
  delete_absence: 'medium',
  // Semesterårsavslut: closes every employee's vacation year, rolls sparade
  // dagar (5-year expiry -> forced payout), and may post a 2920/2940
  // adjustment verifikation. Irreversible in practice (no reopen flow):
  // never auto-committed.
  vacation_year_close: 'high',

  // ── Multi-tx flows (PRs #603/#606/#608/#610) ───────────────────────
  // Allocate 1 bank tx across N customer or supplier invoices into one
  // combined verifikat. Reversible via storno + invoice_payments delete,
  // but 'high' (2026-10-11) so it stays out of cross-company batch staging
  // and bulk approval, where the old hand-kept batch list kept it.
  match_batch_allocate: 'high',
  // Bulk-book N bank txs into 1 verifikat. The create-new branch posts
  // a verifikat with caller-supplied lines (template-expanded or manual),
  // the same compliance-critical surface as create_voucher. 'high'.
  bulk_book_transactions: 'high',
  // Bulk-book N selected Underlag (Dokumentinkorgen): one posted verifikat per
  // matched bank transaction, each with VAT (incl. reverse charge) derived from
  // a shared category. Posting N verifikat at once is the same compliance-
  // critical surface as bulk_book_transactions, so 'high': never auto-commit;
  // approval requires confirmed=true.
  bulk_book_inbox_items: 'high',
  // Link a single bank tx to an already-posted verifikat (no new JE created).
  // Reversible by clearing transactions.journal_entry_id and deleting any
  // invoice_payments row: sits next to link_invoice_voucher semantically;
  // both attach an existing booking to a different entity.
  link_transaction_journal_entry: 'medium',
  // Account-keyed reconciliation (lib/reconciliation/actions.ts). A match
  // pairs outside rows with existing verifikat across any reconcilable
  // account (bank or skattekonto); it writes nothing to the ledger and is
  // undone by reconciliation_unmatch, so 'medium' like its single-bank-tx
  // sibling above. Unmatch only clears a pointer: 'low'.
  reconciliation_match: 'medium',
  reconciliation_unmatch: 'low',
  // Sign-off writes the attestation row others rely on (overview, Hem, auditor)
  // but nothing in the ledger, and reopen undoes it: 'medium'.
  reconciliation_signoff: 'medium',
  // Residual booking writes one small verifikat (bank fee / interest /
  // rounding, capped at RESIDUAL_MAX_AMOUNT) against the bank account and
  // links the selection: a typed, bounded booking like categorize_transaction,
  // undone by storno + unmatch, so 'medium' rather than create_voucher's 'high'.
  reconciliation_residual: 'medium',
  // Book synced skattekonto rows as posted verifikat: 1630 against the
  // skattekonto_rules-matched counter account, amounts straight from the
  // synced Skatteverket data. No caller-supplied lines (the agent passes only
  // row ids), reversible via storno: same bounded-booking tier as
  // book_mileage_period, not create_voucher's arbitrary-line 'high'.
  book_skattekonto_row: 'medium',
  book_skattekonto_rows: 'medium',

  // ── Körjournal (mileage) ───────────────────────────────────────────
  // A trip row is pure travel documentation: no booking impact until a
  // separate book operation. Same tier as create_customer.
  log_mileage_trip: 'low',
  // Books one verifikat with fixed lines derived from logged trips (7331 +
  // whitelisted counter account) at the DB-configured schablon rate: not the
  // arbitrary-line surface that makes create_voucher 'high'. Reversible via
  // storno: same tier as post_annual_depreciation.
  book_mileage_period: 'medium',

  // ── Skatteverket filing (PR5) ──────────────────────────────────────
  // External + irreversible once signed. Commit sends the declaration for
  // BankID signing; the user's signature in the browser is the filing act.
  // (getRiskLevel already defaults unknown → 'high'; explicit for intent.)
  submit_vat_declaration: 'high',
  submit_agi: 'high',

  // ── Bolaget registers (lib/operations/bolaget.ts) ──────────────────
  // No booking impact. An aktiebok entry is permanent (corrected only by a
  // rattelse entry) and moves who owns what, so medium; a class change moves
  // the votes and with them the verkliga huvudmän, medium; an LRVH
  // assessment is a legal record and may raise a filing, medium. Roles, a
  // new class and the firmateckning are end-dated or superseded later: low.
  register_share_event: 'medium',
  create_share_class: 'low',
  update_share_class: 'medium',
  add_company_role: 'low',
  end_company_role: 'low',
  set_signatory_rule: 'low',
  confirm_beneficial_owners: 'medium',

  // ── Bolaget capital events (lib/operations/bolaget-capital.ts) ──────
  // Recording a dividend or a capital change books nothing but enters a
  // legal decision (a nyemission's allotment goes into the aktiebok), so
  // medium. Everything that posts a verifikat (the dividend decision and
  // payout, a tillskott, an emission's payment or registration) moves
  // equity in the ledger and is corrected only by storno: high.
  create_dividend: 'medium',
  book_dividend: 'high',
  pay_dividend: 'high',
  create_shareholder_contribution: 'high',
  create_capital_change: 'medium',
  book_capital_change: 'high',

  // ── Bolaget owner tax (lib/operations/bolaget-owner-tax.ts) ──────────
  // Nothing here books. The owner's K10 figures and a year's interest are
  // figures for a declaration the owner files or a kontrolluppgift: low.
  // An owner loan enters a legal fact the låneförbud (ABL 21 kap.) and the
  // 21:10 special list rest on: medium.
  set_k10_owner_inputs: 'low',
  create_owner_loan: 'medium',
  update_owner_loan: 'medium',
  set_owner_loan_interest: 'low',

  // ── Bolaget meetings and minutes (lib/operations/corporate-meetings.ts) ──
  // No booking impact. A draft meeting, its changes and its decisions stay
  // open until the minutes are signed in the app: low. Holding a meeting
  // gives board minutes their permanent number and writes the AGM date to
  // the årsredovisning: medium.
  create_corporate_meeting: 'low',
  update_corporate_meeting: 'low',
  record_corporate_decision: 'low',
  hold_corporate_meeting: 'medium',

  // ── Commitments and holdings (Bolaget; lib/commitments) ────────────
  // Registers beside the books: agreements with their expected payments and
  // dates, ställda säkerheter and eventualförpliktelser, the group
  // structure. Nothing is booked or sent, and each is changed again by its
  // update: 'low', like create_customer. The årsredovisning reads the
  // securities register only as note text the person still reviews.
  create_agreement: 'low',
  update_agreement: 'low',
  end_agreement: 'low',
  create_security: 'low',
  update_security: 'low',
  create_group_link: 'low',
  update_group_link: 'low',
  // ── Underskottsregistret (IL 40 kap.) ──────────────────────────────
  // Saves a year of prior tax losses: no verifikat, re-saved to undo, but
  // its 4.14 a feeds the year's tax provision and INK2, so a person reviews.
  save_tax_loss_carryforward: 'medium',
} as const satisfies Record<string, RiskLevel>

/** A pending_operations.operation_type: a key of the tier table above. */
export type PendingOperationType = keyof typeof RISK_TIERS

/** The tier of each type, looked up by any string (an unknown type is undefined). */
export const OPERATION_RISK_TIERS: Readonly<Record<string, RiskLevel>> = RISK_TIERS

/** Every pending operation type, in the table's order. */
export const PENDING_OPERATION_TYPES = Object.keys(RISK_TIERS) as PendingOperationType[]

/**
 * Op types whose tier depends on the staged params, not just the type.
 * Checked inside getRiskLevel so every caller that can pass params gets the
 * escalation for free; callers without params in scope fall back to the
 * static (never lower) tier.
 */
function paramEscalatedRisk(
  operationType: string,
  params: Record<string, unknown> | undefined,
): RiskLevel | null {
  // A recurring schedule with auto_send=true is indefinite outbound email
  // with no further approval per send: the exact external side-effect that
  // makes one-off send_invoice 'high'.
  if (
    (operationType === 'create_recurring_schedule' ||
      operationType === 'update_recurring_schedule') &&
    params?.auto_send === true
  ) {
    return 'high'
  }
  return null
}

/**
 * Staged operations that only a person in the web UI may approve: the
 * approver attests something an agent cannot (that the invoice was
 * delivered, that the bank shows no payment, that a customer's answer was
 * handled, that a supplier's new bank details are real), or the operation
 * escalates against a customer. The MCP approve
 * tool refuses them and commitPendingOperation refuses every commit that is
 * not a web user's own approval. Depends on the params for case actions:
 * pausing or withdrawing a case is agent-approvable, approving the next step
 * is not.
 */
export const WEB_ONLY_APPROVAL_TYPES: ReadonlySet<string> = new Set([
  'open_collection_case',
  'collections_daily_batch',
  // A person approves the day's reminder emails (lib/reminders/batch-commit.ts).
  'reminder_daily_batch',
  // A person vouches that the supplier's new bank details are real.
  'confirm_supplier_payee',
  // Accepting a rule for automatic booking (lib/grants) hands posting
  // authority to agents: only the person decides, in the app, so an agent
  // never accepts its own grant whatever key it holds.
  'create_grant',
])

/**
 * The code a door answers when an agent or key tries to approve an
 * operation only a person may approve in the app: a grant names its own
 * (with a message pointing the person to Att göra), everything else the
 * collections code it has always answered.
 */
export function webOnlyRefusalCode(operationType: string): 'GRANT_NEEDS_PERSON' | 'COLLECTION_ATTESTATION_WEB_ONLY' {
  return operationType === 'create_grant' ? 'GRANT_NEEDS_PERSON' : 'COLLECTION_ATTESTATION_WEB_ONLY'
}

export function requiresWebApproval(operationType: string, params?: Record<string, unknown> | null): boolean {
  if (WEB_ONLY_APPROVAL_TYPES.has(operationType)) return true
  if (operationType === 'collection_case_action') {
    const action = params?.action
    // Unknown or missing action: fail safe, a person approves.
    return typeof action !== 'string' || (WEB_ONLY_CASE_ACTIONS as ReadonlySet<string>).has(action)
  }
  return false
}

export function getRiskLevel(
  operationType: string,
  params?: Record<string, unknown>,
): RiskLevel {
  const escalated = paramEscalatedRisk(operationType, params)
  if (escalated) return escalated
  // Default to 'high' for unknown ops, fail-safe: unknown means human review.
  return OPERATION_RISK_TIERS[operationType] ?? 'high'
}

/**
 * High-risk operations are excluded from bulk approval and need a typed
 * confirmation. Encoded here (not in DB config) so it can't be bypassed.
 */
export function isHighRisk(operationType: string, params?: Record<string, unknown>): boolean {
  return getRiskLevel(operationType, params) === 'high'
}
