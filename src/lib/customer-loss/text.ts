import { formatKronor } from '@/lib/utils'
import type { CustomerLossInvoice } from './state'
import type { CustomerLossView } from './view'

/**
 * An amount by the collections screens' one rule (formatKronor): whole
 * kronor without decimals ("7 500 kr"), öre with both digits only when it
 * is not whole kronor ("1 250,50 kr"). Client-safe: the invoice page's
 * dialogs print it.
 */
export function formatLossAmount(amount: number): string {
  return formatKronor(amount)
}

/** How a voucher names the invoice: its number, or a draft marker. */
export function invoiceLabel(invoice: Pick<CustomerLossInvoice, 'id' | 'invoice_number'>): string {
  return invoice.invoice_number ?? `utkast ${invoice.id.slice(0, 8)}`
}

const MAX_DESCRIPTION = 250

/** "Konstaterad kundförlust faktura 1042 (Konkurs)", capped for the voucher text. */
export function decisionDescription(event: string, label: string, reason: string): string {
  const base = `${event} faktura ${label}`
  const why = reason.trim().replace(/\s+/g, ' ')
  if (!why) return base
  const full = `${base} (${why})`
  return full.length <= MAX_DESCRIPTION ? full : `${full.slice(0, MAX_DESCRIPTION - 2)}…)`
}

/**
 * The customer loss dialog's plain sentence above the voucher (customer_loss
 * namespace): what the booking does, in owner words, before the person opens
 * "Visa verifikationen". Pure and client-safe; amounts are numbers the dialog
 * formats. Null when the chosen kind is not available (its refusal shows
 * instead) or nothing is booked (kontantmetoden: not_booked says so).
 */
export type CustomerLossSummary =
  | { key: 'summary_doubtful'; amount: number }
  | { key: 'summary_confirmed' | 'summary_confirmed_vat'; amount: number; vat: number; reserveReleased: number }

export function customerLossSummary(view: Pick<CustomerLossView, 'doubtful' | 'confirmed'>, kind: 'doubtful' | 'confirmed'): CustomerLossSummary | null {
  if (kind === 'doubtful') {
    return view.doubtful.available ? { key: 'summary_doubtful', amount: view.doubtful.reserve } : null
  }
  const confirmed = view.confirmed
  if (!confirmed.available || confirmed.lines === null) return null
  return {
    key: confirmed.vat > 0 ? 'summary_confirmed_vat' : 'summary_confirmed',
    amount: confirmed.amount,
    vat: confirmed.vat,
    reserveReleased: confirmed.reserveReleased,
  }
}

/**
 * Whether the customer loss dialog may book: the person chose befarad or
 * konstaterad themselves (nothing is preselected: the two differ in what
 * happens to the invoice and its VAT), the chosen kind is available, a
 * reason and a date are given, and a konstaterad loss carries its evidence.
 */
export function customerLossCanSend(input: {
  kind: 'doubtful' | 'confirmed' | null
  view: Pick<CustomerLossView, 'doubtful' | 'confirmed'>
  reason: string
  entryDateValid: boolean
  hasEvidence: boolean
  uploading: boolean
}): boolean {
  if (input.kind === null || input.uploading) return false
  if (!input.view[input.kind].available) return false
  if (input.reason.trim().length === 0 || !input.entryDateValid) return false
  return input.kind === 'doubtful' || input.hasEvidence
}
