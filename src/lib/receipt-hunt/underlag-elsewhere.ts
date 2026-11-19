/**
 * The invoice a payment verifikat settles, when its underlag is already in
 * the books on the invoice's own verifikat.
 *
 * A payment of a supplier or customer invoice has no receipt of its own: its
 * underlag is the invoice (BFL 5 kap 7 §), which a mail search can only find
 * a second time. verifikat_without_documents treats the payment as covered
 * when Accounted itself links it to the invoice, but a migrated payment
 * carries that link only as the source system's own words. Bokio writes
 * "Leverantörsfaktura #25601 betald till X (V299)" and
 * "Faktura #1012 betalad av Y (V60)", naming the invoice's verifikat in
 * the source numbering. An agent sent to the mailbox for those forwarded the
 * invoice again, the inbox deduplicated it to the document already on V299,
 * and the link was refused as already linked (crm#1584).
 *
 * This resolves that reference, plus an Accounted payment link whose invoice
 * holds its document on the registration verifikat rather than in
 * supplier_invoices.document_id, so the worklist can hand over the existing
 * document to copy instead of a mail search. It only reads: what counts as
 * missing underlag stays the RPC's decision.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  invoiceSettled,
  registersInvoice,
  type InvoiceSide,
  type PlausibilityLine,
} from '@/lib/bookkeeping/voucher-plausibility'
import {
  buildVoucherIndex,
  candidatesForRef,
  fetchVouchersForNumbers,
  isLiveCopy,
  type SourceVoucherRef,
} from '@/lib/documents/voucher-ref-resolver'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'

export interface UnderlagElsewhere {
  /** The invoice's verifikat, as Accounted numbers it ("V299"). */
  voucher: string
  journal_entry_id: string
  entry_date: string
  /** A current document on that verifikat: stage it here with copy: true. */
  document_id: string
}

export interface SettlementCandidate {
  journal_entry_id: string
  entry_date: string
  description: string | null
}

/** The verifikat an invoice is registered on, as much as the hand-over names. */
interface InvoiceEntry {
  id: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number | null
}

const LOOKUP_CHUNK = 150

/**
 * The verifikat the source system names at the end of a description:
 * "(V299)", "(A 31)". A bare number in parentheses is a year or a count as
 * often as a verifikat, so the series is required. Its case is left to the
 * resolver, which compares series case-insensitively on both sides.
 */
const TRAILING_SOURCE_REF = /\(([A-Za-zÅÄÖåäö]{1,4})[\s-]*(\d{1,9})\)\s*$/

function sourceRefIn(description: string | null): SourceVoucherRef | null {
  const match = TRAILING_SOURCE_REF.exec(description ?? '')
  return match ? { series: match[1], number: Number(match[2]) } : null
}

/**
 * The registration verifikat of the supplier invoice each payment is linked
 * to in Accounted: supplier_invoices.payment_journal_entry_id, or a
 * supplier_invoice_payments row for a part payment.
 */
async function fetchLinkedRegistrations(
  supabase: SupabaseClient,
  companyId: string,
  paymentIds: string[],
): Promise<Map<string, InvoiceEntry>> {
  const registrationByPayment = new Map<string, string>()
  await Promise.all(
    chunk(paymentIds, LOOKUP_CHUNK).map(async (ids) => {
      const [siRes, sipRes] = await Promise.all([
        supabase
          .from('supplier_invoices')
          .select('payment_journal_entry_id, registration_journal_entry_id')
          .eq('company_id', companyId)
          .in('payment_journal_entry_id', ids),
        supabase
          .from('supplier_invoice_payments')
          .select('journal_entry_id, supplier_invoice:supplier_invoices(registration_journal_entry_id)')
          .eq('company_id', companyId)
          .in('journal_entry_id', ids),
      ])
      if (siRes.error) throw new Error(`supplier_invoices lookup failed: ${siRes.error.message}`)
      if (sipRes.error) throw new Error(`supplier_invoice_payments lookup failed: ${sipRes.error.message}`)
      for (const r of (siRes.data ?? []) as {
        payment_journal_entry_id: string | null
        registration_journal_entry_id: string | null
      }[]) {
        if (r.payment_journal_entry_id && r.registration_journal_entry_id) {
          registrationByPayment.set(r.payment_journal_entry_id, r.registration_journal_entry_id)
        }
      }
      for (const r of (sipRes.data ?? []) as unknown as {
        journal_entry_id: string | null
        supplier_invoice: { registration_journal_entry_id: string | null } | null
      }[]) {
        const registration = r.supplier_invoice?.registration_journal_entry_id
        if (r.journal_entry_id && registration) registrationByPayment.set(r.journal_entry_id, registration)
      }
    }),
  )

  // The registration verifikat themselves, posted ones only.
  const entries = new Map<string, InvoiceEntry>()
  await Promise.all(
    chunk([...new Set(registrationByPayment.values())], LOOKUP_CHUNK).map(async (ids) => {
      const { data, error } = await supabase
        .from('journal_entries')
        .select('id, entry_date, voucher_series, voucher_number')
        .eq('company_id', companyId)
        .eq('status', 'posted')
        .in('id', ids)
      if (error) throw new Error(`journal_entries lookup failed: ${error.message}`)
      for (const r of (data ?? []) as InvoiceEntry[]) entries.set(r.id, r)
    }),
  )

  const linked = new Map<string, InvoiceEntry>()
  for (const [payment, registration] of registrationByPayment) {
    const entry = entries.get(registration)
    if (entry) linked.set(payment, entry)
  }
  return linked
}

/**
 * The verifikat each source reference names: the latest live one carrying it
 * dated on or before the payment. An invoice is paid after it is booked, and
 * voucher numbers restart every year, so that is the one the payment means
 * (the reported V27 of 2026 paid V299 of 2025). Resolved through the one
 * source-ref resolver (lib/documents/voucher-ref-resolver).
 */
async function resolveSourceRefs(
  supabase: SupabaseClient,
  companyId: string,
  refs: Map<string, { ref: SourceVoucherRef; paidOn: string }>,
): Promise<Map<string, InvoiceEntry>> {
  const resolved = new Map<string, InvoiceEntry>()
  if (refs.size === 0) return resolved
  const rows = await fetchVouchersForNumbers(
    supabase,
    companyId,
    [...refs.values()].map(({ ref }) => ref.number),
  )
  const index = buildVoucherIndex(rows.filter(isLiveCopy))
  for (const [paymentId, { ref, paidOn }] of refs) {
    let latest: InvoiceEntry | undefined
    for (const row of candidatesForRef(index, ref)) {
      if (row.id === paymentId || row.entry_date > paidOn) continue
      if (!latest || row.entry_date > latest.entry_date) {
        latest = { id: row.id, entry_date: row.entry_date, voucher_series: row.voucher_series ?? null, voucher_number: row.voucher_number ?? null }
      }
    }
    if (latest) resolved.set(paymentId, latest)
  }
  return resolved
}

/** The first current document on each verifikat, by upload time. */
async function fetchFirstDocuments(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
): Promise<Map<string, string>> {
  const first = new Map<string, string>()
  const pages = await Promise.all(
    chunk(entryIds, LOOKUP_CHUNK).map((ids) =>
      fetchAllRows<{ id: string; journal_entry_id: string }>(({ from, to }) =>
        supabase
          .from('document_attachments')
          .select('id, journal_entry_id, created_at')
          .eq('company_id', companyId)
          .eq('is_current_version', true)
          .in('journal_entry_id', ids)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ),
  )
  for (const doc of pages.flat()) {
    if (!first.has(doc.journal_entry_id)) first.set(doc.journal_entry_id, doc.id)
  }
  return first
}

/**
 * For each settlement among `candidates` whose invoice verifikat already
 * carries a current document: that verifikat and the document.
 * `linesByEntry` holds the candidates' own lines.
 *
 * The invoice's verifikat comes from Accounted's own payment link first, and
 * otherwise from the source system's reference in the text. A referenced
 * verifikat must register the invoice the payment settles (credit
 * leverantörsskulder for a supplier payment, debit kundfordringar for a
 * customer payment): a number that landed on anything else is not the
 * invoice, and its document is not this payment's underlag.
 */
export async function resolveUnderlagElsewhere(
  supabase: SupabaseClient,
  companyId: string,
  candidates: readonly SettlementCandidate[],
  linesByEntry: ReadonlyMap<string, readonly PlausibilityLine[]>,
): Promise<Map<string, UnderlagElsewhere>> {
  const sides = new Map<string, InvoiceSide>()
  const supplierPayments: string[] = []
  const refs = new Map<string, { ref: SourceVoucherRef; paidOn: string }>()
  for (const c of candidates) {
    const side = invoiceSettled(linesByEntry.get(c.journal_entry_id) ?? [])
    if (!side) continue
    sides.set(c.journal_entry_id, side)
    if (side === 'supplier') supplierPayments.push(c.journal_entry_id)
    const ref = sourceRefIn(c.description)
    if (ref) refs.set(c.journal_entry_id, { ref, paidOn: c.entry_date })
  }
  const result = new Map<string, UnderlagElsewhere>()
  if (sides.size === 0) return result

  const [linked, referenced] = await Promise.all([
    supplierPayments.length > 0
      ? fetchLinkedRegistrations(supabase, companyId, supplierPayments)
      : new Map<string, InvoiceEntry>(),
    resolveSourceRefs(supabase, companyId, refs),
  ])
  // Accounted's own link wins over the words.
  for (const id of linked.keys()) referenced.delete(id)

  const targetIds = [...new Set([...linked.values(), ...referenced.values()].map((e) => e.id))]
  if (targetIds.length === 0) return result
  const [referencedLines, documents] = await Promise.all([
    fetchLinesByEntryIds<PlausibilityLine & { id: string; journal_entry_id: string }>(
      supabase,
      [...new Set([...referenced.values()].map((e) => e.id))],
      'account_number, debit_amount, credit_amount',
    ),
    fetchFirstDocuments(supabase, companyId, targetIds),
  ])
  const linesByReferenced = new Map<string, PlausibilityLine[]>()
  for (const line of referencedLines) {
    const list = linesByReferenced.get(line.journal_entry_id)
    if (list) list.push(line)
    else linesByReferenced.set(line.journal_entry_id, [line])
  }
  const targets = new Map(linked)
  for (const [paymentId, entry] of referenced) {
    if (registersInvoice(linesByReferenced.get(entry.id) ?? [], sides.get(paymentId)!)) targets.set(paymentId, entry)
  }

  for (const [paymentId, entry] of targets) {
    const documentId = documents.get(entry.id)
    if (!documentId) continue
    result.set(paymentId, {
      voucher: formatVoucher(entry),
      journal_entry_id: entry.id,
      entry_date: entry.entry_date,
      document_id: documentId,
    })
  }
  return result
}
