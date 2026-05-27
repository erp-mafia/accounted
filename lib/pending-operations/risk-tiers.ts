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

  // ── Medium: reversible booking ─────────────────────────────────────
  categorize_transaction: 'medium',
  match_transaction_invoice: 'medium',
  create_invoice: 'medium', // creates as draft; sending is a separate op
  create_transaction: 'medium', // ingests an uncategorized row; reversible by delete
  // Supplier master data carries payment-routing fields (IBAN, BIC, bankgiro,
  // bank_account) that drive outgoing payment files and supplier invoice
  // postings. A wrong account or org_number can enable supplier-fraud / BEC
  // (silently rerouting payment), so always require explicit human approval
  // rather than auto-commit.
  create_supplier: 'medium',
  // Pinning a doc to a tx is reversible while pre-categorization, but the link
  // becomes part of the verifikation underlag (BFL 5 kap 6 §) once categorize
  // propagates it. A wrong attachment requires a rättelse, so require human
  // approval rather than auto-commit.
  attach_document_to_transaction: 'medium',

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
  run_currency_revaluation: 'high',
  // Planenlig avskrivning: one journal entry per asset, each independently
  // reversible (storno). Mid-stakes bokslut posting — staged and human-reviewed,
  // but not the irreversible tier that year-end close / period lock occupy.
  post_annual_depreciation: 'medium',
  import_sie: 'high',
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

  // ── Phase 4: arbitrary-line bookkeeping primitives ─────────────────
  // Both accept caller-supplied account/amount/period — unlike
  // uncategorize_transaction (medium), which mirrors an existing entry.
  // The arbitrary-line capability is what makes these compliance-critical.
  create_voucher: 'high',
  correct_entry: 'high',
  reverse_entry: 'high',

  // ── Payroll ────────────────────────────────────────────────────────
  // Salary run creation materialises a draft + per-employee base lines. The
  // run is reversible while still draft, so 'medium' aligns with other
  // create-draft operations. AGI generation produces the Skatteverket
  // underlag (XML, BFL 7-year retention) — statutory artifact, always
  // staged.
  create_salary_run: 'medium',
  generate_agi: 'high',
}

export function getRiskLevel(operationType: string): RiskLevel {
  // Default to 'high' for unknown ops — fail-safe: unknown means human review.
  return OPERATION_RISK_TIERS[operationType] ?? 'high'
}

/**
 * High-risk operations are NEVER auto-committed, regardless of company opt-in
 * or actor trust. Encoded here (not in DB config) so it can't be bypassed.
 */
export function isHighRisk(operationType: string): boolean {
  return getRiskLevel(operationType) === 'high'
}
