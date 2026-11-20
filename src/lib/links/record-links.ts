import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { readLinkBasis, type LinkBasis, type LinkEvidence } from './link-basis'

/**
 * What one ledger record is tied to, for a reader that holds only that
 * record (MCP gnubok_get_record): a bank row, a customer invoice, a supplier
 * invoice, a skattekonto row or a document. The read side of the link tables
 * the books already keep for every company; nothing here is a model's
 * reading of a file (those links, document_links, stay with the company
 * brain, src/lib/arkiv/flag.ts).
 *
 * Every link names the record it leads to as a record_ref (`<kind>:<uuid>`),
 * so an agent can open it with the same tool, and carries the basis the
 * writer recorded (./link-basis.ts) where the link table has one. null is
 * "not recorded" (links written before 2026-10-16, or a table without a
 * basis column), never a guess. A suggestion the matcher made but nobody
 * confirmed is relation 'suggested_match', never a link.
 *
 * Every query filters by company_id (service-role callers have no RLS) and
 * reads at most RECORD_LINK_LIMIT rows per link table, so a samlingsverifikat
 * or a much-paid invoice cannot blow up the answer.
 */

export const RECORD_LINK_LIMIT = 50

/** The record kinds a link can lead to that gnubok_get_record opens. */
export type LinkedRecordKind =
  | 'document'
  | 'journal_entry'
  | 'transaction'
  | 'invoice'
  | 'supplier_invoice'
  | 'skattekonto_transaction'

export interface RecordLink {
  /** What the linked record is to this one, e.g. booked_by, pays, paid_by, underlag, credits. */
  relation: string
  /** `<kind>:<uuid>` of the linked record; open it with gnubok_get_record. */
  record_ref: string
  /** Why the link exists, as recorded when it was made; null when not recorded. */
  basis: LinkBasis | null
  /** What the writer saw (rule, reference, score, pending operation), when recorded. */
  evidence?: LinkEvidence
  /** How the link is held, when a record can be tied more than one way (pointer, voucher_link, role). */
  via?: string
  /** The part of the money this link carries (a payment, a share of a verifikat), when the link has one. */
  amount?: number
  currency?: string
  date?: string
  /** The verifikat a payment or set-off was booked on. */
  journal_entry_id?: string
  /** suggested_match only: the matcher's confidence, 0 to 1. */
  confidence?: number
  /** Qualified ids of the link row itself, when it has one an agent can act on. */
  invoice_payment_id?: string
  supplier_invoice_payment_id?: string
  settlement_id?: string
  setoff_id?: string
  inbox_item_id?: string
  expense_claim_id?: string
}

const ref = (kind: LinkedRecordKind, id: string) => `${kind}:${id}`
const num = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value))

function rowsOf<T>(result: { data: unknown; error: unknown }): T[] {
  if (result.error) throw dbError(result.error)
  return Array.isArray(result.data) ? (result.data as T[]) : []
}

type BasisRow = { link_basis?: unknown; link_evidence?: unknown }

/** A link with its recorded basis; undefined optional fields are left out. */
function link(relation: string, recordRef: string, basisRow: BasisRow | null, extra: Partial<RecordLink> = {}): RecordLink {
  const { basis, evidence } = readLinkBasis(basisRow)
  const out: RecordLink = { relation, record_ref: recordRef, basis }
  if (evidence) out.evidence = evidence
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) (out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

/** Keep the first link per relation and record (a payment and the pointer it also set name one tie once). */
function dedupe(links: RecordLink[]): RecordLink[] {
  const seen = new Set<string>()
  return links.filter((l) => {
    const key = `${l.relation}|${l.record_ref}|${l.invoice_payment_id ?? l.supplier_invoice_payment_id ?? l.settlement_id ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const none = Promise.resolve({ data: [], error: null })

/** The documents' own verifikat link basis (document_attachments.link_basis), by id. */
async function documentBasis(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Map<string, BasisRow>> {
  if (ids.length === 0) return new Map()
  const result = await supabase
    .from('document_attachments')
    .select('id, link_basis, link_evidence')
    .eq('company_id', companyId)
    .in('id', ids)
    .limit(RECORD_LINK_LIMIT)
  return new Map(rowsOf<BasisRow & { id: string }>(result).map((r) => [r.id, r]))
}

export interface TransactionLinkInput {
  transaction_id: string
  journal_entry_id: string | null
  invoice_id: string | null
  supplier_invoice_id: string | null
  potential_invoice_id: string | null
  potential_supplier_invoice_id: string | null
  potential_journal_entry_id: string | null
  potential_match_confidence: number | null
  documents: Array<{ document_id: string; journal_entry_id: string | null; pinned_to_transaction: boolean }>
}

/**
 * A bank row's links: the verifikat that book it (its own pointer, or a
 * share of a samlingsverifikat with the amount), the invoices and supplier
 * invoices it pays (each payment with its amount), its underlag, and the
 * match the transactions page suggests.
 */
export async function transactionLinks(supabase: SupabaseClient, companyId: string, tx: TransactionLinkInput): Promise<RecordLink[]> {
  const [pointer, voucherLinks, payments, supplierPayments] = await Promise.all([
    tx.journal_entry_id
      ? supabase.from('transactions').select('link_basis, link_evidence').eq('company_id', companyId).eq('id', tx.transaction_id).limit(1)
      : none,
    supabase
      .from('transaction_voucher_links')
      .select('journal_entry_id, allocated_amount, role, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.transaction_id)
      .order('created_at', { ascending: true })
      .limit(RECORD_LINK_LIMIT),
    supabase
      .from('invoice_payments')
      .select('id, invoice_id, amount, currency, payment_date, journal_entry_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.transaction_id)
      .order('payment_date', { ascending: true })
      .limit(RECORD_LINK_LIMIT),
    supabase
      .from('supplier_invoice_payments')
      .select('id, supplier_invoice_id, amount, currency, payment_date, journal_entry_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.transaction_id)
      .order('payment_date', { ascending: true })
      .limit(RECORD_LINK_LIMIT),
  ])
  const docBasis = await documentBasis(supabase, companyId, tx.documents.map((d) => d.document_id))

  const links: RecordLink[] = []
  if (tx.journal_entry_id) {
    links.push(link('booked_by', ref('journal_entry', tx.journal_entry_id), rowsOf<BasisRow>(pointer)[0] ?? null, { via: 'pointer' }))
  }
  for (const v of rowsOf<BasisRow & { journal_entry_id: string; allocated_amount: unknown; role: string | null }>(voucherLinks)) {
    links.push(link('booked_by', ref('journal_entry', v.journal_entry_id), v, { via: v.role ?? 'bank_line', amount: num(v.allocated_amount) }))
  }
  type PaymentRow = BasisRow & { id: string; amount: unknown; currency: string | null; payment_date: string | null; journal_entry_id: string | null }
  for (const p of rowsOf<PaymentRow & { invoice_id: string }>(payments)) {
    links.push(link('pays', ref('invoice', p.invoice_id), p, {
      amount: num(p.amount), currency: p.currency ?? undefined, date: p.payment_date ?? undefined, journal_entry_id: p.journal_entry_id ?? undefined, invoice_payment_id: p.id,
    }))
  }
  if (tx.invoice_id) links.push(link('pays', ref('invoice', tx.invoice_id), null, { via: 'pointer' }))
  for (const p of rowsOf<PaymentRow & { supplier_invoice_id: string }>(supplierPayments)) {
    links.push(link('pays', ref('supplier_invoice', p.supplier_invoice_id), p, {
      amount: num(p.amount), currency: p.currency ?? undefined, date: p.payment_date ?? undefined, journal_entry_id: p.journal_entry_id ?? undefined, supplier_invoice_payment_id: p.id,
    }))
  }
  if (tx.supplier_invoice_id) links.push(link('pays', ref('supplier_invoice', tx.supplier_invoice_id), null, { via: 'pointer' }))
  for (const d of tx.documents) {
    links.push(link('underlag', ref('document', d.document_id), d.pinned_to_transaction ? null : docBasis.get(d.document_id) ?? null, {
      via: d.pinned_to_transaction ? 'pin' : 'verifikat', journal_entry_id: d.journal_entry_id ?? undefined,
    }))
  }
  const confidence = num(tx.potential_match_confidence)
  if (tx.potential_invoice_id) links.push(link('suggested_match', ref('invoice', tx.potential_invoice_id), null, { confidence }))
  if (tx.potential_supplier_invoice_id) links.push(link('suggested_match', ref('supplier_invoice', tx.potential_supplier_invoice_id), null, { confidence }))
  if (tx.potential_journal_entry_id) links.push(link('suggested_match', ref('journal_entry', tx.potential_journal_entry_id), null, { confidence }))
  return dedupeKeepingPaymentOverPointer(links)
}

/** A payment row names the same tie as the row's pointer with more (amount, basis): keep it and drop the bare pointer. */
function dedupeKeepingPaymentOverPointer(links: RecordLink[]): RecordLink[] {
  const paid = new Set(links.filter((l) => l.relation === 'pays' && l.via !== 'pointer').map((l) => l.record_ref))
  return dedupe(links.filter((l) => !(l.relation === 'pays' && l.via === 'pointer' && paid.has(l.record_ref))))
}

/**
 * A customer invoice's links: the verifikat that booked it, every payment
 * (bank row or verifikat, with its amount), bank rows that point at it, the
 * credit note pairing in both directions, the quote it came from, its
 * underlag and the files sent with it, and set-offs against a supplier
 * invoice.
 */
export async function invoiceLinks(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<RecordLink[]> {
  const [head, payments, bankRows, creditNotes, underlag, attachments, setoffs] = await Promise.all([
    supabase.from('invoices').select('journal_entry_id, credited_invoice_id, converted_from_id').eq('company_id', companyId).eq('id', invoiceId).limit(1),
    supabase
      .from('invoice_payments')
      .select('id, amount, currency, payment_date, journal_entry_id, transaction_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('invoice_id', invoiceId)
      .order('payment_date', { ascending: true })
      .limit(RECORD_LINK_LIMIT),
    supabase.from('transactions').select('id').eq('company_id', companyId).eq('invoice_id', invoiceId).limit(RECORD_LINK_LIMIT),
    supabase.from('invoices').select('id').eq('company_id', companyId).eq('credited_invoice_id', invoiceId).limit(RECORD_LINK_LIMIT),
    supabase.from('invoice_underlag').select('document_id').eq('company_id', companyId).eq('invoice_id', invoiceId).limit(RECORD_LINK_LIMIT),
    supabase.from('invoice_attachments').select('document_id').eq('company_id', companyId).eq('invoice_id', invoiceId).limit(RECORD_LINK_LIMIT),
    supabase
      .from('counterparty_setoffs')
      .select('id, supplier_invoice_id, amount, currency, setoff_date, journal_entry_id')
      .eq('company_id', companyId)
      .eq('invoice_id', invoiceId)
      .eq('status', 'booked')
      .limit(RECORD_LINK_LIMIT),
  ])
  const h = rowsOf<{ journal_entry_id: string | null; credited_invoice_id: string | null; converted_from_id: string | null }>(head)[0]
  const links: RecordLink[] = []
  if (h?.journal_entry_id) links.push(link('booked_by', ref('journal_entry', h.journal_entry_id), null))
  for (const p of rowsOf<BasisRow & { id: string; amount: unknown; currency: string | null; payment_date: string | null; journal_entry_id: string | null; transaction_id: string | null }>(payments)) {
    const target = p.transaction_id ? ref('transaction', p.transaction_id) : p.journal_entry_id ? ref('journal_entry', p.journal_entry_id) : null
    if (!target) continue
    links.push(link('paid_by', target, p, {
      amount: num(p.amount), currency: p.currency ?? undefined, date: p.payment_date ?? undefined, journal_entry_id: p.journal_entry_id ?? undefined, invoice_payment_id: p.id,
    }))
  }
  for (const t of rowsOf<{ id: string }>(bankRows)) links.push(link('paid_by', ref('transaction', t.id), null, { via: 'pointer' }))
  if (h?.credited_invoice_id) links.push(link('credits', ref('invoice', h.credited_invoice_id), null))
  for (const c of rowsOf<{ id: string }>(creditNotes)) links.push(link('credited_by', ref('invoice', c.id), null))
  if (h?.converted_from_id) links.push(link('converted_from', ref('invoice', h.converted_from_id), null))
  for (const u of rowsOf<{ document_id: string }>(underlag)) links.push(link('underlag', ref('document', u.document_id), null))
  for (const a of rowsOf<{ document_id: string }>(attachments)) links.push(link('sent_attachment', ref('document', a.document_id), null))
  for (const s of rowsOf<{ id: string; supplier_invoice_id: string; amount: unknown; currency: string | null; setoff_date: string | null; journal_entry_id: string | null }>(setoffs)) {
    links.push(link('set_off_against', ref('supplier_invoice', s.supplier_invoice_id), null, {
      amount: num(s.amount), currency: s.currency ?? undefined, date: s.setoff_date ?? undefined, journal_entry_id: s.journal_entry_id ?? undefined, setoff_id: s.id,
    }))
  }
  return dropPointerShadowedByPayment(links)
}

/** A bank row that points at the invoice and also carries a payment row is one tie: keep the payment. */
function dropPointerShadowedByPayment(links: RecordLink[]): RecordLink[] {
  const paid = new Set(links.filter((l) => l.relation === 'paid_by' && l.via !== 'pointer').map((l) => l.record_ref))
  return dedupe(links.filter((l) => !(l.relation === 'paid_by' && l.via === 'pointer' && paid.has(l.record_ref))))
}

/**
 * A supplier invoice's links: the verifikat that registered and paid it,
 * every payment with its amount, the bank rows that point at it, its
 * document and the inbox item it came from, the credit note pairing in both
 * directions, and set-offs against a customer invoice.
 */
export async function supplierInvoiceLinks(supabase: SupabaseClient, companyId: string, supplierInvoiceId: string): Promise<RecordLink[]> {
  const [head, payments, bankRows, creditNotes, inbox, setoffs] = await Promise.all([
    supabase
      .from('supplier_invoices')
      .select('registration_journal_entry_id, payment_journal_entry_id, transaction_id, document_id, credited_invoice_id')
      .eq('company_id', companyId)
      .eq('id', supplierInvoiceId)
      .limit(1),
    supabase
      .from('supplier_invoice_payments')
      .select('id, amount, currency, payment_date, journal_entry_id, transaction_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('supplier_invoice_id', supplierInvoiceId)
      .order('payment_date', { ascending: true })
      .limit(RECORD_LINK_LIMIT),
    supabase.from('transactions').select('id').eq('company_id', companyId).eq('supplier_invoice_id', supplierInvoiceId).limit(RECORD_LINK_LIMIT),
    supabase.from('supplier_invoices').select('id').eq('company_id', companyId).eq('credited_invoice_id', supplierInvoiceId).limit(RECORD_LINK_LIMIT),
    supabase.from('invoice_inbox_items').select('id, document_id').eq('company_id', companyId).eq('created_supplier_invoice_id', supplierInvoiceId).limit(RECORD_LINK_LIMIT),
    supabase
      .from('counterparty_setoffs')
      .select('id, invoice_id, amount, currency, setoff_date, journal_entry_id')
      .eq('company_id', companyId)
      .eq('supplier_invoice_id', supplierInvoiceId)
      .eq('status', 'booked')
      .limit(RECORD_LINK_LIMIT),
  ])
  const h = rowsOf<{
    registration_journal_entry_id: string | null
    payment_journal_entry_id: string | null
    transaction_id: string | null
    document_id: string | null
    credited_invoice_id: string | null
  }>(head)[0]
  const links: RecordLink[] = []
  if (h?.registration_journal_entry_id) links.push(link('booked_by', ref('journal_entry', h.registration_journal_entry_id), null))
  for (const p of rowsOf<BasisRow & { id: string; amount: unknown; currency: string | null; payment_date: string | null; journal_entry_id: string | null; transaction_id: string | null }>(payments)) {
    const target = p.transaction_id ? ref('transaction', p.transaction_id) : p.journal_entry_id ? ref('journal_entry', p.journal_entry_id) : null
    if (!target) continue
    links.push(link('paid_by', target, p, {
      amount: num(p.amount), currency: p.currency ?? undefined, date: p.payment_date ?? undefined, journal_entry_id: p.journal_entry_id ?? undefined, supplier_invoice_payment_id: p.id,
    }))
  }
  if (h?.payment_journal_entry_id) links.push(link('paid_by', ref('journal_entry', h.payment_journal_entry_id), null, { via: 'pointer' }))
  if (h?.transaction_id) links.push(link('paid_by', ref('transaction', h.transaction_id), null, { via: 'pointer' }))
  for (const t of rowsOf<{ id: string }>(bankRows)) links.push(link('paid_by', ref('transaction', t.id), null, { via: 'pointer' }))
  if (h?.document_id) links.push(link('underlag', ref('document', h.document_id), null))
  for (const i of rowsOf<{ id: string; document_id: string | null }>(inbox)) {
    links.push(link('from_inbox', i.document_id ? ref('document', i.document_id) : ref('supplier_invoice', supplierInvoiceId), null, { inbox_item_id: i.id }))
  }
  if (h?.credited_invoice_id) links.push(link('credits', ref('supplier_invoice', h.credited_invoice_id), null))
  for (const c of rowsOf<{ id: string }>(creditNotes)) links.push(link('credited_by', ref('supplier_invoice', c.id), null))
  for (const s of rowsOf<{ id: string; invoice_id: string; amount: unknown; currency: string | null; setoff_date: string | null; journal_entry_id: string | null }>(setoffs)) {
    links.push(link('set_off_against', ref('invoice', s.invoice_id), null, {
      amount: num(s.amount), currency: s.currency ?? undefined, date: s.setoff_date ?? undefined, journal_entry_id: s.journal_entry_id ?? undefined, setoff_id: s.id,
    }))
  }
  // The payment's verifikat pointer and a payment row on the same verifikat are one tie.
  const paidEntries = new Set(links.filter((l) => l.relation === 'paid_by' && l.journal_entry_id).map((l) => ref('journal_entry', l.journal_entry_id!)))
  return dropPointerShadowedByPayment(links.filter((l) => !(l.relation === 'paid_by' && l.via === 'pointer' && paidEntries.has(l.record_ref))))
}

/**
 * The columns of one skattekonto row read in full: Skatteverket's own id
 * (transaktionsidentitet), the dates and text as Skatteverket sent them, the
 * amounts, and the verifikat it is linked or suggested to. The first single
 * row read of the table; the list reads keep their own lists.
 */
export const SKATTEKONTO_ROW_COLUMNS =
  'id, transaktionsidentitet, transaktionsdatum, forfallodatum, ranteberakningsdatum, transaktionstext, ' +
  'belopp_skatteverket, belopp_kronofogden, status, is_ignored, journal_entry_id, suggested_journal_entry_id, suggested_at, ' +
  'source, imported_at, updated_at'

export interface SkattekontoRowRecord {
  skattekonto_transaction_id: string
  transaktionsidentitet: number | null
  transaktionsdatum: string | null
  forfallodatum: string | null
  ranteberakningsdatum: string | null
  transaktionstext: string | null
  belopp_skatteverket: number | null
  belopp_kronofogden: number | null
  status: string | null
  is_ignored: boolean
  journal_entry_id: string | null
  suggested_journal_entry_id: string | null
  suggested_at: string | null
  source: string | null
  imported_at: string | null
  updated_at: string | null
  links: RecordLink[]
}

/**
 * One skattekonto row with its links: the verifikat it is linked to (one
 * pointer), the verifikat it is suggested to, the other rows that share its
 * verifikat (one AGI line for skatt and avgifter), and, when the event was
 * split over several verifikat (lib/reconciliation/skattekonto-split.ts),
 * the other verifikat of that settlement with the amount each holds.
 */
export async function readSkattekontoRow(supabase: SupabaseClient, companyId: string, rowId: string): Promise<SkattekontoRowRecord | null> {
  const { data, error } = await supabase
    .from('skattekonto_transactions')
    .select(SKATTEKONTO_ROW_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', rowId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) return null
  const row = data as unknown as Record<string, unknown> & { id: string; journal_entry_id: string | null; suggested_journal_entry_id: string | null }

  const [siblings, settlements] = await Promise.all([
    row.journal_entry_id
      ? supabase
          .from('skattekonto_transactions')
          .select('id')
          .eq('company_id', companyId)
          .eq('journal_entry_id', row.journal_entry_id)
          .neq('id', row.id)
          .limit(RECORD_LINK_LIMIT)
      : none,
    row.journal_entry_id
      ? supabase
          .from('account_reconciliation_settlements')
          .select('settlement_id')
          .eq('company_id', companyId)
          .eq('journal_entry_id', row.journal_entry_id)
          .is('undone_at', null)
          .limit(RECORD_LINK_LIMIT)
      : none,
  ])
  const settlementIds = [...new Set(rowsOf<{ settlement_id: string }>(settlements).map((s) => s.settlement_id))]
  const members = settlementIds.length
    ? await supabase
        .from('account_reconciliation_settlements')
        .select('settlement_id, journal_entry_id, amount, link_basis, link_evidence')
        .eq('company_id', companyId)
        .in('settlement_id', settlementIds)
        .is('undone_at', null)
        .limit(RECORD_LINK_LIMIT)
    : { data: [], error: null }

  const links: RecordLink[] = []
  if (row.journal_entry_id) links.push(link('booked_by', ref('journal_entry', row.journal_entry_id), null, { via: 'pointer' }))
  for (const m of rowsOf<BasisRow & { settlement_id: string; journal_entry_id: string; amount: unknown }>(members)) {
    if (m.journal_entry_id === row.journal_entry_id) continue
    links.push(link('settled_with', ref('journal_entry', m.journal_entry_id), m, { amount: num(m.amount), settlement_id: m.settlement_id }))
  }
  for (const s of rowsOf<{ id: string }>(siblings)) links.push(link('shares_verifikat', ref('skattekonto_transaction', s.id), null))
  if (row.suggested_journal_entry_id && row.suggested_journal_entry_id !== row.journal_entry_id) {
    links.push(link('suggested_match', ref('journal_entry', row.suggested_journal_entry_id), null))
  }

  const { id, transaktionsidentitet, belopp_skatteverket, belopp_kronofogden, is_ignored, ...fields } = row
  return {
    skattekonto_transaction_id: id,
    ...(fields as Omit<SkattekontoRowRecord, 'skattekonto_transaction_id' | 'transaktionsidentitet' | 'belopp_skatteverket' | 'belopp_kronofogden' | 'is_ignored' | 'links'>),
    transaktionsidentitet: num(transaktionsidentitet) ?? null,
    belopp_skatteverket: num(belopp_skatteverket) ?? null,
    belopp_kronofogden: num(belopp_kronofogden) ?? null,
    is_ignored: is_ignored === true,
    links: dedupe(links),
  }
}

/** The ledger side of what holds a document, as gnubok_get_document_content's links part reads it (lib/documents/read/document-detail.ts). */
export interface DocumentLedgerLinksInput {
  journal_entry: { journal_entry_id: string } | null
  transactions: Array<{ transaction_id: string; journal_entry_id: string | null }>
  inbox_items: Array<{ inbox_item_id: string; created_journal_entry_id: string | null; created_supplier_invoice_id: string | null; matched_transaction_id: string | null }>
  supplier_invoices: Array<{ supplier_invoice_id: string }>
  expense_claims: Array<{ expense_claim_id: string; journal_entry_id: string | null }>
}

/**
 * A document's ledger links for everyone: the verifikat it is underlag for
 * (with the basis recorded on the link), the bank rows it is pinned to, the
 * supplier invoice and utlägg it is the document of, the inbox item it came
 * through (and what that item became), and the customer invoices it is
 * underlag of or was sent with. The links part of the shared document read
 * supplies most of them, so the two doors agree.
 */
export async function documentLedgerLinks(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  part: DocumentLedgerLinksInput,
): Promise<RecordLink[]> {
  const [basis, underlag, attachments] = await Promise.all([
    part.journal_entry
      ? supabase.from('document_attachments').select('link_basis, link_evidence').eq('company_id', companyId).eq('id', documentId).limit(1)
      : none,
    supabase.from('invoice_underlag').select('invoice_id').eq('company_id', companyId).eq('document_id', documentId).limit(RECORD_LINK_LIMIT),
    supabase.from('invoice_attachments').select('invoice_id').eq('company_id', companyId).eq('document_id', documentId).limit(RECORD_LINK_LIMIT),
  ])
  const links: RecordLink[] = []
  if (part.journal_entry) {
    links.push(link('supports', ref('journal_entry', part.journal_entry.journal_entry_id), rowsOf<BasisRow>(basis)[0] ?? null))
  }
  for (const t of part.transactions) links.push(link('pinned_to', ref('transaction', t.transaction_id), null))
  for (const s of part.supplier_invoices) links.push(link('document_of', ref('supplier_invoice', s.supplier_invoice_id), null))
  for (const u of rowsOf<{ invoice_id: string }>(underlag)) links.push(link('underlag_of', ref('invoice', u.invoice_id), null))
  for (const a of rowsOf<{ invoice_id: string }>(attachments)) links.push(link('sent_with', ref('invoice', a.invoice_id), null))
  for (const i of part.inbox_items) {
    // The item itself is no record_ref kind: the ref is what it became, or the document when it is still in the inbox.
    const became = i.created_supplier_invoice_id
      ? ref('supplier_invoice', i.created_supplier_invoice_id)
      : i.created_journal_entry_id
        ? ref('journal_entry', i.created_journal_entry_id)
        : i.matched_transaction_id
          ? ref('transaction', i.matched_transaction_id)
          : null
    if (became) links.push(link('arrived_as', became, null, { inbox_item_id: i.inbox_item_id }))
  }
  for (const x of part.expense_claims) {
    if (x.journal_entry_id) links.push(link('expense_claim', ref('journal_entry', x.journal_entry_id), null, { expense_claim_id: x.expense_claim_id }))
  }
  return dedupe(links)
}

/**
 * The records a verifikat books, for the journal_entry record: the customer
 * invoice it booked, the supplier invoice it registered or paid (a payment
 * row's tie is in the voucher links already), and the skattekonto rows linked
 * to it. Without these an agent that opened a verifikat could not hop to the
 * invoice behind it.
 */
export async function verifikatBookedRecords(supabase: SupabaseClient, companyId: string, journalEntryId: string): Promise<RecordLink[]> {
  const [invoices, registered, paid, skattekonto] = await Promise.all([
    supabase.from('invoices').select('id').eq('company_id', companyId).eq('journal_entry_id', journalEntryId).limit(RECORD_LINK_LIMIT),
    supabase.from('supplier_invoices').select('id').eq('company_id', companyId).eq('registration_journal_entry_id', journalEntryId).limit(RECORD_LINK_LIMIT),
    supabase.from('supplier_invoices').select('id').eq('company_id', companyId).eq('payment_journal_entry_id', journalEntryId).limit(RECORD_LINK_LIMIT),
    supabase.from('skattekonto_transactions').select('id').eq('company_id', companyId).eq('journal_entry_id', journalEntryId).limit(RECORD_LINK_LIMIT),
  ])
  return [
    ...rowsOf<{ id: string }>(invoices).map((r) => link('books', ref('invoice', r.id), null)),
    ...rowsOf<{ id: string }>(registered).map((r) => link('books', ref('supplier_invoice', r.id), null)),
    ...rowsOf<{ id: string }>(paid).map((r) => link('pays', ref('supplier_invoice', r.id), null, { via: 'pointer' })),
    ...rowsOf<{ id: string }>(skattekonto).map((r) => link('books', ref('skattekonto_transaction', r.id), null)),
  ]
}
