/**
 * Risk tier classification for pending_operations.
 *
 * Used by lib/pending-operations/should-auto-commit.ts to decide whether a
 * staged proposal from a trusted agent can be auto-committed without human
 * review.
 *
 * Tiering principles:
 *   - **low**: no booking impact, no external side-effects, no audit risk.
 *     A reasonable bookkeeper would never want to manually approve these.
 *   - **medium**: reversible booking impact (drafts, transaction
 *     categorization that can be uncategorized). Auto-commit is allowed for
 *     trusted agents under a configurable monetary threshold.
 *   - **high**: irreversible or compliance-critical. Sends external messages,
 *     locks/closes periods, or affects tax filings. NEVER auto-committed,
 *     regardless of company opt-in or trust level.
 */

export type RiskLevel = 'low' | 'medium' | 'high'

export const OPERATION_RISK_TIERS: Record<string, RiskLevel> = {
  // ── Low: pure data, no booking impact ─────────────────────────────
  create_customer: 'low',
  update_customer: 'low',
  // Article catalog (artikelregister) is app-level master data: no journal
  // impact, no external side-effect. Unlike create_supplier it carries no
  // payment-routing fields, so there's no BEC/fraud surface; both create and
  // update sit at the lowest tier next to create_customer.
  create_article: 'low',
  update_article: 'low',
  // Dimension values (kostnadsställe/projekt object codes, SIE #OBJEKT) are
  // reporting master data: no journal impact, no external side-effect, no
  // payment-routing surface. Staged (agents never silently mint reporting
  // values) but at the lowest tier next to create_customer/create_article.
  create_dimension_value: 'low',
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
  // Ignoring a bank transaction flips transactions.is_ignored and nothing
  // else: no verifikat, no ledger impact, reversible with the same op
  // (ignored: false). The DB CHECK transactions_is_ignored_no_journal_entry
  // and the executor's isTransactionBooked() refusal keep it off booked rows,
  // so the op cannot hide a booking even if tampered with (issue #1661).
  ignore_transaction: 'low',

  // ── Medium: reversible booking ─────────────────────────────────────
  categorize_transaction: 'medium',
  match_transaction_invoice: 'medium',
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
  create_invoice: 'medium', // creates as draft; sending is a separate op
  // Rewrites a DRAFT in place (header + full item replace). Same tier as
  // create_invoice: the target has no verifikat yet (isEditableInvoiceDraft
  // is re-checked at commit), so the edit is fully reversible by editing again.
  update_invoice: 'medium',
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
  // so we route it through human review at medium tier.
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
  // so 'medium' (same tier as match_transaction_invoice: its single-
  // invoice counterpart).
  match_batch_allocate: 'medium',
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
}

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
 * High-risk operations are NEVER auto-committed, regardless of company opt-in
 * or actor trust. Encoded here (not in DB config) so it can't be bypassed.
 */
export function isHighRisk(operationType: string, params?: Record<string, unknown>): boolean {
  return getRiskLevel(operationType, params) === 'high'
}
