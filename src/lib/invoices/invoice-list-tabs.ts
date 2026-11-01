import type { Invoice } from '@/types'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { effectiveQuoteStatus } from './quote-status'
import { isInvoiceOverdue } from './overdue'

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
  // "Hos inkasso": open collection cases past delivery (a registered claim
  // included), plus the cases a person must look at (the Att göra row lands
  // here). The ids come from collection_open_invoice_ids (in_collection) and
  // collection_attention_case_ids, passed in as the context; without it the
  // view is empty.
  'collections',
  // "Kundförlust": invoices written off as a konstaterad kundförlust
  // (lib/customer-loss); shown once there is one.
  'written_off',
  'proforma',
  'delivery_note',
  'credit',
  'cancelled',
] as const
export const INVOICE_LIST_TABS = [...INVOICE_LIST_MAIN_TABS, ...INVOICE_LIST_MORE_TABS] as const
export type InvoiceListTab = (typeof INVOICE_LIST_TABS)[number]

/**
 * The quote list's views (/quotes). A quote is not an invoice: it has its own
 * page, and its views follow the quote decision (open, accepted, declined)
 * plus the derived expired state, never the invoice payment states.
 */
export const QUOTE_LIST_TABS = ['all', 'open', 'accepted', 'declined', 'expired', 'cancelled'] as const
export type QuoteListTab = (typeof QUOTE_LIST_TABS)[number]

/** Either list's view id: the two pages share one list component. */
export type AnyListTab = InvoiceListTab | QuoteListTab

/**
 * The views the invoice list shows as a visible segmented control while
 * collections is in play (Förfallna, Hos inkasso). The status picker then
 * leaves them out, so each view has one door, and while one of them is
 * active the picker shows its neutral label with nothing checked.
 */
export const COLLECTIONS_SEGMENT_TABS = ['overdue', 'collections'] as const

export function statusPickerTabs<T extends string>(tabs: readonly T[], segmentShown: boolean): T[] {
  if (!segmentShown) return [...tabs]
  return tabs.filter((tab) => !(COLLECTIONS_SEGMENT_TABS as readonly string[]).includes(tab))
}

/** Whether the active view belongs to the segmented control rather than the status picker. */
export function segmentViewActive(tab: string, segmentShown: boolean): boolean {
  return segmentShown && (COLLECTIONS_SEGMENT_TABS as readonly string[]).includes(tab)
}

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

export function parseQuoteListTab(param: string | null): QuoteListTab | null {
  if (!param) return null
  return (QUOTE_LIST_TABS as readonly string[]).includes(param) ? (param as QuoteListTab) : null
}

type ListInvoice = Pick<Invoice, 'status' | 'invoice_number' | 'credited_invoice_id'> & {
  id?: string
  document_type?: string | null
  is_self_billed?: boolean | null
  quote_status?: string | null
  valid_until?: string | null
  /** Förfallna follows the due date and the open remainder (lib/invoices/overdue.ts). */
  due_date?: string | null
  remaining_amount?: number | null
  /** A credit note is a link or a total below zero (isCreditNoteDocument). */
  total?: number | null
}

export function documentTypeOf(invoice: Pick<ListInvoice, 'document_type'>): string {
  return invoice.document_type || 'invoice'
}

/** Quotes live on /quotes; every invoice list view leaves them out. */
export function isQuoteRow(invoice: Pick<ListInvoice, 'document_type'>): boolean {
  return documentTypeOf(invoice) === 'quote'
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
    !isCreditNoteDocument(invoice) &&
    !invoice.is_self_billed
  )
}

/** Facts a view needs beyond the invoice row itself. */
export interface InvoiceListTabContext {
  /** Invoices with an open collection case past the delivery stages ("Hos inkasso"). */
  inCollection?: ReadonlySet<string>
  /** Invoices whose collection case needs a person (a refused handover, a failed read). */
  collectionAttention?: ReadonlySet<string>
  /** Today (Stockholm, YYYY-MM-DD) for Förfallna; defaults to the current day. */
  today?: string
}

export function matchesInvoiceListTab(invoice: ListInvoice, tab: InvoiceListTab, context: InvoiceListTabContext = {}): boolean {
  if (isQuoteRow(invoice)) return false
  const isCreditNote = isCreditNoteDocument(invoice)
  const docType = documentTypeOf(invoice)
  const inCollectionsView =
    !!invoice.id && (!!context.inCollection?.has(invoice.id) || !!context.collectionAttention?.has(invoice.id))
  switch (tab) {
    case 'all':
      return invoice.status !== 'cancelled'
    case 'unpaid':
      return ['sent', 'overdue'].includes(invoice.status) && !isCreditNote && docType === 'invoice'
    case 'overdue':
      // Derived, never the stored status (crm#1084): an owed invoice past its
      // due date, partly paid included. One "Hos inkasso" lists is that
      // view's, as in the Att göra group (lib/worklist overdue_invoice).
      return !inCollectionsView && isInvoiceOverdue(invoice, context.today)
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
      // An imported credit note can carry 'paid': it is in Kreditfakturor.
      return invoice.status === 'paid' && !isCreditNote
    case 'written_off':
      return invoice.status === 'written_off'
    case 'collections':
      return inCollectionsView
    case 'credit':
      return isCreditNote && invoice.status !== 'cancelled'
    case 'proforma':
      return docType === 'proforma' && invoice.status !== 'cancelled'
    case 'delivery_note':
      return docType === 'delivery_note' && invoice.status !== 'cancelled'
    case 'cancelled':
      return invoice.status === 'cancelled'
  }
}

export function matchesQuoteListTab(invoice: ListInvoice, tab: QuoteListTab, today?: string): boolean {
  if (!isQuoteRow(invoice)) return false
  if (tab === 'cancelled') return invoice.status === 'cancelled'
  if (invoice.status === 'cancelled') return false
  if (tab === 'all') return true
  return effectiveQuoteStatus(invoice, today) === tab
}
