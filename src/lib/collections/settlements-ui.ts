import { isAccountNumber } from '@/lib/invariants/account-number'
import { formatKronor } from './amount-text'
import type { CollectedPaymentStatus } from './collected-payment-record'
import type { SettlementLineKind } from './settlement-posting'
import type { SettlementStatus } from './settlements'
import type { CollectedPaymentListItem, SettlementDetail, SettlementListItem, SettlementsOverview } from './settlements-view'

/**
 * What the settlements view (Avräkningar) decides in the browser, kept pure
 * so it is tested: the label keys of the `settlements` namespace per status,
 * line kind and reason, which rows a click can book or rebook, and the
 * account choices sent with a booking. Imports types only, so the client
 * bundle pulls in no server code.
 */

export type { CollectedPaymentListItem, SettlementDetail, SettlementListItem, SettlementsOverview }

/**
 * A settlement amount by the collections screens' one rule (formatKronor):
 * whole kronor without decimals ("10 625 kr"), öre with both digits only
 * when it is not whole kronor ("12 187,50 kr", never "12 187,5 kr").
 */
export function formatSettlementAmount(amount: number): string {
  return formatKronor(amount)
}

/** The two accounts the VAT on the provider's fees takes (SETTLEMENT_VAT_CHOICES in settlements-view.ts). */
export const VAT_DEDUCTIBLE = '2641'
export const VAT_COST = '6062'
const VAT_CHOICES: readonly string[] = [VAT_DEDUCTIBLE, VAT_COST]

export const SETTLEMENT_STATUS_KEYS: Record<SettlementStatus, string> = {
  received: 'status_received',
  booked: 'status_booked',
  needs_mapping: 'status_needs_mapping',
  failed: 'status_failed',
  ignored: 'status_ignored',
}

export const PAYMENT_STATUS_KEYS: Record<CollectedPaymentStatus, string> = {
  pending: 'payment_status_pending',
  booked: 'payment_status_booked',
  needs_review: 'payment_status_needs_review',
  ignored: 'payment_status_ignored',
}

/**
 * Chips mark exceptions (design convention 5): a row waiting for its normal
 * booking, a booked row and a handled row are muted text; only a row a person
 * must look at, or a refused one, wears a chip.
 */
export const SETTLEMENT_STATUS_VARIANTS: Record<SettlementStatus, 'warning' | 'destructive' | 'outline' | null> = {
  received: null,
  booked: null,
  needs_mapping: 'warning',
  failed: 'destructive',
  ignored: null,
}

export const PAYMENT_STATUS_VARIANTS: Record<CollectedPaymentStatus, 'warning' | 'outline' | null> = {
  pending: null,
  booked: null,
  needs_review: 'warning',
  ignored: null,
}

export const LINE_KIND_KEYS: Record<SettlementLineKind, string> = {
  principal: 'line_principal',
  interest_to_creditor: 'line_interest',
  fee_to_creditor: 'line_fee_to_creditor',
  cost_refund_to_creditor: 'line_cost_refund',
  agency_commission: 'line_commission',
  agency_fee_vat: 'line_fee_vat',
  fee_charged_to_creditor: 'line_fee_charged',
  court_fee: 'line_court_fee',
  supplier_invoice_setoff: 'line_supplier_setoff',
  excess_direct_payment: 'line_excess_direct',
  informational: 'line_informational',
  unknown: 'line_unknown',
}

/** Reasons a payout waits for a person (planner reasons and the booking's own), as `reason_*` keys. */
const KNOWN_REASONS = new Set([
  'provider_status',
  'currency',
  'non_positive_payout',
  'unknown_case',
  'collected_payment_unbooked',
  'case_mismatch',
  'unknown_line',
  'vat_on_line_without_vat',
  'vat_unconfirmed',
  'unbalanced',
  'possible_duplicate',
  'no_fiscal_period',
  'document_unavailable',
  'voucher_reversed',
  'account_not_in_chart',
  'period_locked',
])

export function settlementReasonKey(reason: string | null): string | null {
  if (!reason) return null
  return KNOWN_REASONS.has(reason) ? `reason_${reason}` : 'reason_default'
}

/** Review reasons the collected-payment booking writes itself; anything else is an error code. */
const OWN_REVIEW_REASONS = new Set(['NO_CAPITAL', 'CURRENCY_NOT_SEK', 'WRITTEN_OFF_RECOVERY'])

export function paymentReviewKey(reason: string | null): string | null {
  if (!reason) return null
  return OWN_REVIEW_REASONS.has(reason) ? `review_${reason}` : null
}

/**
 * What waits for a person in Avräkningar: collected payments never booked
 * or refused before, and payouts to book or to answer. Att göra counts the
 * same statuses (lib/worklist/categories.ts), so its rows and the page agree.
 * A payout the provider marked invalid (failed) is never booked: shown, not counted.
 */
export const PAYMENT_STATUSES_TO_BOOK: readonly CollectedPaymentStatus[] = ['pending', 'needs_review']
export const SETTLEMENT_STATUSES_TO_BOOK: readonly SettlementStatus[] = ['received', 'needs_mapping']

/** A collected payment a click can book: never booked yet, or refused before and waiting for a person. */
export function paymentBookable(payment: Pick<CollectedPaymentListItem, 'status'>): boolean {
  return PAYMENT_STATUSES_TO_BOOK.includes(payment.status)
}

/** A booked collected payment no booked payout settled yet: the rebook (storno and book again) is open. */
export function paymentRebookable(payment: Pick<CollectedPaymentListItem, 'status' | 'settlementId' | 'journalEntryId'>): boolean {
  return payment.status === 'booked' && !payment.settlementId && !!payment.journalEntryId
}

export function settlementBookable(settlement: Pick<SettlementListItem, 'status' | 'needsMappingReason'>): boolean {
  return (settlement.status === 'received' || settlement.status === 'needs_mapping') && settlement.needsMappingReason !== 'possible_duplicate'
}

/** How many rows wait for a person: payments to book or review, payouts to book or answer (the Att göra rows count the same). */
export function attentionCount(overview: Pick<SettlementsOverview, 'settlements' | 'collectedPayments'>): number {
  return (
    overview.collectedPayments.filter(paymentBookable).length +
    overview.settlements.filter((s) => SETTLEMENT_STATUSES_TO_BOOK.includes(s.status)).length
  )
}

export interface LineChoiceState {
  account?: string
  vatAccount?: string
}

/**
 * The choices to send with the booking: every line that waits for an
 * account. Nothing is prefilled: the VAT on the provider's fees waits for
 * the person to pick deductible input VAT or a cost (SETTLEMENT_VAT_INVOICE_ACCEPTED
 * is off until the accountant has seen a settlement), like any other
 * account a line waits for. Null while a choice is still missing.
 */
export function bookingChoices(
  detail: Pick<SettlementDetail, 'lines'>,
  state: Readonly<Record<number, LineChoiceState>>,
): { position: number; account_number?: string; vat_account_number?: string }[] | null {
  const choices: { position: number; account_number?: string; vat_account_number?: string }[] = []
  for (const line of detail.lines) {
    if (!line.needsAccount && !line.needsVatAccount) continue
    const chosen = state[line.position] ?? {}
    const choice: { position: number; account_number?: string; vat_account_number?: string } = { position: line.position }
    if (line.needsAccount === 'vat') {
      if (!chosen.account || !VAT_CHOICES.includes(chosen.account)) return null
      choice.account_number = chosen.account
    }
    if (line.needsAccount === 'any') {
      if (!chosen.account || !isAccountNumber(chosen.account)) return null
      choice.account_number = chosen.account
    }
    if (line.needsVatAccount) {
      if (!chosen.vatAccount || !VAT_CHOICES.includes(chosen.vatAccount)) return null
      choice.vat_account_number = chosen.vatAccount
    }
    choices.push(choice)
  }
  return choices
}

/** Line kinds that are the provider's own charges taken out of a payout. */
const PROVIDER_CHARGE_KINDS: ReadonlySet<SettlementLineKind> = new Set<SettlementLineKind>([
  'agency_commission',
  'agency_fee_vat',
  'fee_charged_to_creditor',
  'court_fee',
])

/**
 * The booking confirm's plain sentence (settlements namespace): what the
 * voucher does in owner words, with the provider's fees named only when the
 * payout carries any. The voucher's own rows sit behind "Visa
 * verifikationen".
 */
export function settlementBookingSentenceKey(
  lines: ReadonlyArray<Pick<SettlementDetail['lines'][number], 'kind' | 'inPayout'>>,
): 'confirm_book_plain' | 'confirm_book_plain_fees' {
  return lines.some((line) => line.inPayout && PROVIDER_CHARGE_KINDS.has(line.kind)) ? 'confirm_book_plain_fees' : 'confirm_book_plain'
}

/** A row of the voucher the person sees before booking: its account, or null while it waits for their choice. */
export interface VoucherPreviewRow {
  accountNumber: string | null
  debit: number
  credit: number
  /** The account comes from a choice the person has not made yet. */
  waiting: boolean
}

/**
 * The voucher a payout will book, with the person's account choices as
 * they stand: a row waiting for a choice takes it as soon as it is made
 * (live, before anything is saved) and reads as waiting until then. Null
 * while something other than a choice holds the payout (its reason shows).
 */
export function settlementVoucherRows(
  detail: Pick<SettlementDetail, 'voucherDraft'>,
  state: Readonly<Record<number, LineChoiceState>>,
): VoucherPreviewRow[] | null {
  if (!detail.voucherDraft) return null
  return detail.voucherDraft.map((row) => {
    if (!row.waitsFor) return { accountNumber: row.accountNumber, debit: row.debit, credit: row.credit, waiting: false }
    const chosen = state[row.waitsFor.position]?.[row.waitsFor.field === 'account' ? 'account' : 'vatAccount']
    const account = chosen && isAccountNumber(chosen) ? chosen : null
    return { accountNumber: account, debit: row.debit, credit: row.credit, waiting: account === null }
  })
}
