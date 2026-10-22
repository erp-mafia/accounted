import type { JournalEntrySourceType } from '@/types'

/**
 * What happened, in business terms: the closed list of business event kinds.
 *
 * Derived from journal_entries.source_type, so every verifikat the engine can
 * post has a kind, and the read-side projection (./project.ts) answers the
 * same vocabulary for history; a few acts booked under a generic source type
 * are named only by their producer (KINDS_WITHOUT_SOURCE_TYPE). Several source types can be one business act
 * (an invoice paid by bank or in cash is one payment received). Sweden-only
 * acts carry the se. prefix.
 *
 * Closed and add-only: a kind is never renamed or removed, because events
 * are kept seven years (BFL 7 kap.). Add one here with a decision record
 * (docs/decisions). The database checks the shape only
 * (business_events_kind_check), so adding one needs no migration.
 */
export const BUSINESS_EVENT_KINDS = [
  'ledger.manual',
  'ledger.storno',
  'ledger.correction',
  'ledger.opening_balance',
  'ledger.history_import',
  'ledger.system',
  'ledger.accrual',
  'ledger.currency_revaluation',
  'bank.categorized',
  'sale.invoiced',
  'sale.payment_received',
  'sale.credited',
  'sale.reminder_fee',
  'sale.webshop_order',
  'sale.pos_daily_takings',
  'sale.payout_settled',
  'purchase.registered',
  'purchase.paid',
  'purchase.credited',
  'purchase.document_booked',
  'payroll.salary_paid',
  'expense.claimed',
  'expense.paid_out',
  'vat.settled',
  'year_end.closing',
  'year_end.result_appropriated',
  'se.rot_rut.payout_received',
  'se.rot_rut.reclaimed',
  'se.rot_rut.reclassified',
  'expense.mileage_allowance',
  'asset.depreciated',
  'asset.disposed',
  'se.tax_account.booked',
  'payroll.vacation_liability_adjusted',
  'sale.customer_loss',
  'counterparty.set_off',
] as const

export type BusinessEventKind = (typeof BUSINESS_EVENT_KINDS)[number]

/**
 * The kinds no source type maps to: business acts whose verifikat carries a
 * generic source type, so only the producer that records the event can name
 * them. Milersättning (a kostnadsersättning, not an utlägg) is booked with
 * source_type 'manual'; its history projects as ledger.manual. A planenlig
 * avskrivning is booked as 'year_end' and an asset disposal as 'system'
 * (lib/bokslut/assets); a skattekonto row booked from the Skatteverket feed
 * is 'system' too (the skatteverket extension). Their history projects as
 * year_end.closing and ledger.system. The semesterårsavslut's adjustment of
 * the semesterlöneskuld (lib/salary/semesterberedning.ts) is booked as
 * 'salary_payment' although no salary is paid; its history projects as
 * payroll.salary_paid.
 */
export const KINDS_WITHOUT_SOURCE_TYPE: readonly BusinessEventKind[] = [
  'expense.mileage_allowance',
  'asset.depreciated',
  'asset.disposed',
  'se.tax_account.booked',
  'payroll.vacation_liability_adjusted',
]

/** The shape business_events_kind_check enforces. */
export const BUSINESS_EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/**
 * The kind of every source type. A Record, so a new source type fails the
 * type check until it is given a kind.
 */
export const KIND_BY_SOURCE_TYPE: Readonly<Record<JournalEntrySourceType, BusinessEventKind>> = Object.freeze({
  manual: 'ledger.manual',
  storno: 'ledger.storno',
  correction: 'ledger.correction',
  opening_balance: 'ledger.opening_balance',
  import: 'ledger.history_import',
  system: 'ledger.system',
  accrual: 'ledger.accrual',
  currency_revaluation: 'ledger.currency_revaluation',
  bank_transaction: 'bank.categorized',
  invoice_created: 'sale.invoiced',
  invoice_paid: 'sale.payment_received',
  invoice_cash_payment: 'sale.payment_received',
  credit_note: 'sale.credited',
  reminder_fee: 'sale.reminder_fee',
  webshop_order: 'sale.webshop_order',
  pos_daily_sales: 'sale.pos_daily_takings',
  stripe_payout: 'sale.payout_settled',
  supplier_invoice_registered: 'purchase.registered',
  supplier_invoice_paid: 'purchase.paid',
  supplier_invoice_cash_payment: 'purchase.paid',
  supplier_invoice_privately_paid: 'purchase.paid',
  supplier_credit_note: 'purchase.credited',
  inbox_item: 'purchase.document_booked',
  salary_payment: 'payroll.salary_paid',
  expense_claim: 'expense.claimed',
  expense_payout: 'expense.paid_out',
  vat_settlement: 'vat.settled',
  year_end: 'year_end.closing',
  result_appropriation: 'year_end.result_appropriated',
  rot_rut_payout: 'se.rot_rut.payout_received',
  rot_rut_reclaim: 'se.rot_rut.reclaimed',
  rot_rut_reclassification: 'se.rot_rut.reclassified',
  // A collections provider's payout: what it collected for the company's
  // invoices, net of its fees, settled to the bank, as a PSP payout is.
  collection_settlement: 'sale.payout_settled',
  // A kundförlust decision: befarad, its reversal, konstaterad or recovered.
  customer_loss: 'sale.customer_loss',
  // Kvittning: a customer invoice and a supplier invoice of the same
  // counterparty settled against each other (lib/invoices/counterparty-setoff).
  counterparty_setoff: 'counterparty.set_off',
})

export function isBusinessEventKind(value: unknown): value is BusinessEventKind {
  return typeof value === 'string' && (BUSINESS_EVENT_KINDS as readonly string[]).includes(value)
}

/** The kind a source type maps to, or null for a value outside the list (a row from a newer schema). */
export function kindForSourceType(sourceType: string | null | undefined): BusinessEventKind | null {
  if (!sourceType) return null
  return Object.prototype.hasOwnProperty.call(KIND_BY_SOURCE_TYPE, sourceType)
    ? KIND_BY_SOURCE_TYPE[sourceType as JournalEntrySourceType]
    : null
}
