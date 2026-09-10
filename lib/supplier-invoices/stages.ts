/**
 * Supplier-invoice lifecycle stages (UI v2 PR 6, dev_docs/ui_v2_build_plan.md).
 *
 * Founder decision 2026-09-07: Inköp shows the invoice as a flow, Inkommen →
 * Registrerad → Attesterad → I betalfil → Betald → Avstämd. The stage is
 * DERIVED from what already exists (status, approved_at, an open payment
 * batch, the paying bank row and the account's sign-off) instead of adding
 * states to SupplierInvoiceStatus: every consumer of the status enum keeps
 * working, and when payment initiation replaces the bank file the "in file"
 * step swaps its evidence, not its place.
 */

export const SUPPLIER_INVOICE_STAGES = [
  'incoming',
  'registered',
  'approved',
  'in_file',
  'paid',
  'reconciled',
] as const

export type SupplierInvoiceLadderStage = (typeof SUPPLIER_INVOICE_STAGES)[number]

/** Credited and reversed invoices leave the ladder. */
export type SupplierInvoiceStage = SupplierInvoiceLadderStage | 'credited'

/** Steps the system takes without the user. */
export const AUTO_STAGES: ReadonlySet<SupplierInvoiceLadderStage> = new Set(['incoming', 'paid', 'reconciled'])

export interface StageInput {
  status: string
  approved_at: string | null
  is_credit_note: boolean
  /** In a payment batch that is neither cancelled nor settled. */
  in_open_batch: boolean
  /** Every paying bank row is signed off in a reconciliation through its date. */
  reconciled: boolean
}

export function deriveStage(i: StageInput): SupplierInvoiceStage {
  if (i.is_credit_note || i.status === 'credited' || i.status === 'reversed') return 'credited'
  if (i.status === 'paid') return i.reconciled ? 'reconciled' : 'paid'
  if (i.in_open_batch) return 'in_file'
  if (i.approved_at || i.status === 'approved') return 'approved'
  // registered, overdue, partially_paid, disputed: still a debt awaiting attest.
  return 'registered'
}

/** 0-based position on the ladder; -1 for invoices that left it. */
export function stageIndex(stage: SupplierInvoiceStage): number {
  return stage === 'credited' ? -1 : SUPPLIER_INVOICE_STAGES.indexOf(stage)
}

/**
 * Ladder for a company. Kontantmetod companies do not attest (the debt is
 * never booked before payment), so their ladder skips Attesterad.
 */
export function stagesFor(accountingMethod: 'accrual' | 'cash' | null | undefined): readonly SupplierInvoiceLadderStage[] {
  return accountingMethod === 'cash'
    ? SUPPLIER_INVOICE_STAGES.filter((s) => s !== 'approved')
    : SUPPLIER_INVOICE_STAGES
}

export interface InvoiceLifecycle {
  stage: SupplierInvoiceStage
  approved_at: string | null
  /** The open payment batch carrying the invoice, if any. */
  batch: { id: string; created_at: string } | null
  /** The bank row that paid it, if matched. */
  paid: { transaction_id: string; date: string } | null
  /** Sign-off date that covers the payment, when reconciled. */
  reconciled_through: string | null
}

export function countByStage(
  lifecycles: Iterable<InvoiceLifecycle>,
): Record<SupplierInvoiceStage, number> {
  const counts = {
    incoming: 0,
    registered: 0,
    approved: 0,
    in_file: 0,
    paid: 0,
    reconciled: 0,
    credited: 0,
  } satisfies Record<SupplierInvoiceStage, number>
  for (const l of lifecycles) counts[l.stage] += 1
  return counts
}
