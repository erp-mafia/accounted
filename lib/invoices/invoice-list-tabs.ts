import type { Invoice } from '@/types'

/**
 * The invoice list's status views. One predicate for the visible rows, the
 * per-view counts and the status sections, so the three can never drift.
 *
 * `unsent` and `draft` split the DB status 'draft' in two: an invoice that
 * went through Granska & skapa carries an F-number and is waiting to be sent
 * or booked (#2399), while an unnumbered draft is still being written.
 */
export const INVOICE_LIST_MAIN_TABS = ['all', 'unpaid', 'overdue', 'unsent', 'draft'] as const
export const INVOICE_LIST_MORE_TABS = [
  'paid',
  'proforma',
  'quote',
  'delivery_note',
  'credit',
  'cancelled',
] as const
export const INVOICE_LIST_TABS = [...INVOICE_LIST_MAIN_TABS, ...INVOICE_LIST_MORE_TABS] as const
export type InvoiceListTab = (typeof INVOICE_LIST_TABS)[number]

/** ?status= values that are not tab ids: older bookmarks and the words users
 *  reach for ("godkända" is what Visma calls a finalized, unsent invoice). */
export const INVOICE_LIST_TAB_ALIASES: Record<string, InvoiceListTab> = {
  drafts: 'draft',
  godkanda: 'unsent',
  approved: 'unsent',
}

export function parseInvoiceListTab(param: string | null): InvoiceListTab | null {
  if (!param) return null
  const candidate = INVOICE_LIST_TAB_ALIASES[param] ?? param
  return (INVOICE_LIST_TABS as readonly string[]).includes(candidate)
    ? (candidate as InvoiceListTab)
    : null
}

type ListInvoice = Pick<Invoice, 'status' | 'invoice_number' | 'credited_invoice_id'> & {
  document_type?: string | null
  is_self_billed?: boolean | null
}

function documentTypeOf(invoice: ListInvoice): string {
  return invoice.document_type || 'invoice'
}

/**
 * A faktura with an F-number whose DB status is still 'draft': finalized but
 * neither sent nor booked. Self-billed invoices arrive already issued and
 * credit notes have their own view, so both are excluded.
 */
export function isUnsentNumberedInvoice(invoice: ListInvoice): boolean {
  return (
    invoice.status === 'draft' &&
    !!invoice.invoice_number &&
    documentTypeOf(invoice) === 'invoice' &&
    !invoice.credited_invoice_id &&
    !invoice.is_self_billed
  )
}

export function matchesInvoiceListTab(invoice: ListInvoice, tab: InvoiceListTab): boolean {
  const isCreditNote = !!invoice.credited_invoice_id
  const docType = documentTypeOf(invoice)
  switch (tab) {
    case 'all':
      return invoice.status !== 'cancelled'
    case 'unpaid':
      return ['sent', 'overdue'].includes(invoice.status) && !isCreditNote && docType === 'invoice'
    case 'overdue':
      return invoice.status === 'overdue' && !isCreditNote && docType === 'invoice'
    case 'unsent':
      return isUnsentNumberedInvoice(invoice)
    case 'draft':
      return (
        invoice.status === 'draft' &&
        docType === 'invoice' &&
        !isCreditNote &&
        !isUnsentNumberedInvoice(invoice)
      )
    case 'paid':
      return invoice.status === 'paid'
    case 'credit':
      return isCreditNote && invoice.status !== 'cancelled'
    case 'proforma':
      return docType === 'proforma' && invoice.status !== 'cancelled'
    case 'quote':
      return docType === 'quote' && invoice.status !== 'cancelled'
    case 'delivery_note':
      return docType === 'delivery_note' && invoice.status !== 'cancelled'
    case 'cancelled':
      return invoice.status === 'cancelled'
  }
}
