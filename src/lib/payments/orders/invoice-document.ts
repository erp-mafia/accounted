/**
 * The supplier's own invoice beside the payment made from it: what the
 * document states (the account, the OCR or reference, the amount, the due
 * date) and whether the payment pays what it states.
 *
 * Pure apart from the one reader at the end, and shared: the dry run of a
 * prepare answers these facts per line, and the approve dialog reads the same
 * columns off an order's invoice, so both call the same thing "the same
 * account". A person checks the payment against the document before signing
 * it; a changed account on an otherwise familiar invoice is the classic
 * invoice fraud, and the document is where it shows.
 *
 * "Stated" means supplier_invoices.payee_* and payment_reference: what the
 * scan, Peppol or a person read off this document. The supplier card is not
 * the document and never answers here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The supplier_invoices columns the facts are read from (plus the document's own row). */
export const INVOICE_DOCUMENT_COLUMNS =
  'id, document_id, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban, payment_reference, total, currency, due_date, document:document_attachments!supplier_invoices_document_id_fkey(mime_type, file_name)'

export interface InvoiceDocumentSource {
  document_id?: string | null
  payee_bankgiro?: string | null
  payee_plusgiro?: string | null
  payee_clearing?: string | null
  payee_account?: string | null
  payee_iban?: string | null
  payment_reference?: string | null
  total?: number | string | null
  currency?: string | null
  due_date?: string | null
  document?: { mime_type?: string | null; file_name?: string | null } | null
}

export interface InvoiceDocumentFacts {
  /** The supplier's document (document_attachments), when one is attached. */
  document_id: string | null
  mime_type: string | null
  file_name: string | null
  /** The account the document states, as a label ("BG 5050-1055"); null when it states none. */
  payee: string | null
  /** The OCR or reference the document states, as read; null when it states none. */
  reference: string | null
  /** The invoice's total and due date, as on the document. */
  amount: number | null
  currency: string | null
  due_date: string | null
}

/** same: the payment pays what the document states; differs: it pays something else; missing: the document states nothing to compare. */
export type DocumentCheck = 'same' | 'differs' | 'missing'

export interface DocumentChecks {
  payee: DocumentCheck
  reference: DocumentCheck
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * The account the document states, in the order the payment rules read it
 * (bankgiro, plusgiro, clearing and account, IBAN) and labelled the way the
 * payment's own account is ("BG 5050-1055", "PG 12345-6", "8327 9123456789").
 * Not validated: a mistyped giro on the document is shown as stated, which is
 * exactly when a person should look.
 */
export function statedPayeeLabel(source: InvoiceDocumentSource): string | null {
  const bg = digits(source.payee_bankgiro)
  if (bg) return bg.length > 4 ? `BG ${bg.slice(0, -4)}-${bg.slice(-4)}` : `BG ${bg}`
  const pg = digits(source.payee_plusgiro)
  if (pg) return pg.length > 1 ? `PG ${pg.slice(0, -1)}-${pg.slice(-1)}` : `PG ${pg}`
  const clearing = digits(source.payee_clearing)
  const account = digits(source.payee_account)
  if (clearing || account) return `${clearing} ${account}`.trim()
  const iban = (source.payee_iban ?? '').replace(/\s+/g, '').toUpperCase()
  return iban || null
}

/** "OCR 4400112233" for a reference of digits, else the reference as written. */
export function referenceLabel(reference: string): string {
  return /^[\d\s-]+$/.test(reference) ? `OCR ${digits(reference)}` : reference
}

export function invoiceDocumentFacts(source: InvoiceDocumentSource): InvoiceDocumentFacts {
  const total = source.total === null || source.total === undefined || source.total === '' ? null : Number(source.total)
  return {
    document_id: source.document_id ?? null,
    mime_type: source.document?.mime_type ?? null,
    file_name: source.document?.file_name ?? null,
    payee: statedPayeeLabel(source),
    reference: text(source.payment_reference),
    amount: total !== null && Number.isFinite(total) ? total : null,
    currency: source.currency ?? null,
    due_date: source.due_date ?? null,
  }
}

/** Case, spaces and separators never make two accounts or references different. */
function comparable(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function check(paid: string | null | undefined, stated: string | null): DocumentCheck {
  if (!stated || !comparable(stated)) return 'missing'
  return paid && comparable(paid) === comparable(stated) ? 'same' : 'differs'
}

/**
 * Whether a payment pays the account and the reference the document states.
 * `paid.payee` is the payment's account label, `paid.reference` the value the
 * bank gets (the OCR digits, or the invoice number as a message).
 */
export function checkAgainstDocument(
  paid: { payee: string | null | undefined; reference: string | null | undefined },
  facts: Pick<InvoiceDocumentFacts, 'payee' | 'reference'>,
): DocumentChecks {
  return { payee: check(paid.payee, facts.payee), reference: check(paid.reference, facts.reference) }
}

/**
 * The facts of each invoice, by id. A failed read throws, like every other
 * read of the prepare: a preview that quietly lost the document would look
 * like an invoice that never had one.
 */
export async function loadInvoiceDocumentFacts(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: string[],
): Promise<Map<string, InvoiceDocumentFacts>> {
  if (invoiceIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select(INVOICE_DOCUMENT_COLUMNS)
    .eq('company_id', companyId)
    .in('id', invoiceIds)
  if (error) throw error
  return new Map(
    ((data ?? []) as unknown as Array<InvoiceDocumentSource & { id: string }>).map((row) => [row.id, invoiceDocumentFacts(row)]),
  )
}

/**
 * A dry-run line with its invoice's document beside it (`document`: the
 * facts and how the payment compares), when the invoice was read. Additive:
 * a line without it is the line as before.
 */
export function withInvoiceDocument(
  line: Record<string, unknown>,
  documents: ReadonlyMap<string, InvoiceDocumentFacts>,
): Record<string, unknown> {
  const facts = documents.get(String(line.supplier_invoice_id))
  if (!facts) return line
  const payee = (line.payee as { label?: string } | null | undefined)?.label
  const reference = (line.reference as { value?: string } | null | undefined)?.value
  return { ...line, document: { ...facts, checks: checkAgainstDocument({ payee, reference }, facts) } }
}
