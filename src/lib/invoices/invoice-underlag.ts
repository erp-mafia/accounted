import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { MAX_UNDERLAG_PER_CALL, MAX_UNDERLAG_PER_INVOICE } from '@/lib/invoices/invoice-underlag-limits'

/**
 * Underlag behind a customer invoice (accounted#42, phase 1): the archived
 * documents an invoice rests on, such as the wholesaler invoices behind
 * material a contractor invoices onward. When the end customer asks what a
 * material line rests on, the contractor opens the invoice and finds them.
 *
 * One rule set for every door (the invoice page, v1, MCP and the approval of
 * a staged MCP write). A link is a reference only:
 *   - it never touches the document's own verifikat link (journal_entry_id),
 *     so a supplier invoice's underlag stays on the supplier invoice's
 *     verifikat and the v1 link route's WORM guard is never in play;
 *   - it can be added or removed in any state of the invoice, since the
 *     question usually comes after the invoice went out;
 *   - removing it leaves the document in the archive;
 *   - nothing here is sent to the customer. The files that go out with the
 *     invoice are its Bilagor (lib/invoices/invoice-attachments.ts), frozen
 *     once it is issued. Sending chosen underlag is phase 2 of accounted#42.
 *
 * The table arrives with migration 20261108073541. Vercel can serve this code
 * before the migration has run: reads then answer an empty list and writes a
 * retryable INVOICE_UNDERLAG_UNAVAILABLE.
 */

export { MAX_UNDERLAG_PER_CALL, MAX_UNDERLAG_PER_INVOICE }

export interface InvoiceUnderlag {
  document_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  /** The verifikat the document is underlag of in its own right, if any. Never changed by a link. */
  journal_entry_id: string | null
  /** That verifikat's number, e.g. "A12". */
  voucher: string | null
  /** When the document reached the archive. */
  document_created_at: string | null
  /** When it was linked to this invoice. */
  attached_at: string
}

interface UnderlagRow {
  document_id: string
  created_at: string
  document: {
    file_name: string
    mime_type: string | null
    file_size_bytes: number | null
    journal_entry_id: string | null
    created_at: string | null
    journal_entry: { voucher_series: string | null; voucher_number: number | null } | null
  } | null
}

interface InvoiceHead {
  id: string
  invoice_number: string | null
}

type Ctx = Pick<OperationContext, 'supabase' | 'companyId'>
type Failure = Extract<OperationOutcome<never>, { ok: false }>

const fail = (code: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  code,
  ...(details ? { details } : {}),
})

const UNAVAILABLE = fail('INVOICE_UNDERLAG_UNAVAILABLE')

const UNDERLAG_SELECT =
  'document_id, created_at, document:document_attachments(file_name, mime_type, file_size_bytes, journal_entry_id, created_at, journal_entry:journal_entries!document_attachments_journal_entry_id_fkey(voucher_series, voucher_number))'

function toUnderlag(row: UnderlagRow): InvoiceUnderlag {
  const doc = row.document
  const voucher = doc?.journal_entry ? formatVoucher(doc.journal_entry) : null
  return {
    document_id: row.document_id,
    file_name: doc?.file_name ?? '',
    mime_type: doc?.mime_type ?? null,
    file_size_bytes: doc?.file_size_bytes ?? null,
    journal_entry_id: doc?.journal_entry_id ?? null,
    voucher: voucher && voucher !== '-' ? voucher : null,
    document_created_at: doc?.created_at ?? null,
    attached_at: row.created_at,
  }
}

/** The invoice's underlag, oldest link first; null when the table is not deployed yet. */
async function readUnderlag(ctx: Ctx, invoiceId: string): Promise<InvoiceUnderlag[] | null> {
  const { data, error } = await ctx.supabase
    .from('invoice_underlag')
    .select(UNDERLAG_SELECT)
    .eq('company_id', ctx.companyId)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) {
    if (isMissingTableError(error)) return null
    throw error
  }
  return ((data ?? []) as unknown as UnderlagRow[]).map(toUnderlag)
}

/**
 * The company's invoice (a credit note included). A quote, proforma,
 * delivery note or order confirmation is answered as not found: underlag is
 * what an invoiced line rests on, and the page shows the section on
 * invoices only.
 */
async function findInvoice(ctx: Ctx, invoiceId: string): Promise<InvoiceHead | null> {
  const { data, error } = await ctx.supabase
    .from('invoices')
    .select('id, invoice_number')
    .eq('id', invoiceId)
    .eq('company_id', ctx.companyId)
    .eq('document_type', 'invoice')
    .maybeSingle()
  if (error) throw error
  return (data as InvoiceHead | null) ?? null
}

export interface InvoiceUnderlagList {
  invoice_id: string
  underlag: InvoiceUnderlag[]
}

/** GET: the documents the invoice rests on. */
export async function listInvoiceUnderlag(
  ctx: Ctx,
  invoiceId: string,
): Promise<OperationOutcome<InvoiceUnderlagList>> {
  const invoice = await findInvoice(ctx, invoiceId)
  if (!invoice) return fail('INVOICE_NOT_FOUND')
  // Not deployed yet: nothing can have been linked.
  const underlag = (await readUnderlag(ctx, invoiceId)) ?? []
  return { ok: true, data: { invoice_id: invoiceId, underlag } }
}

export interface AttachInvoiceUnderlagResult {
  invoice_id: string
  /** Documents this call linked; already linked ones are left as they are. */
  attached_document_ids: string[]
  underlag: InvoiceUnderlag[]
}

/**
 * Link archived documents to an invoice as its underlag. Repeating a call is
 * harmless: a document already linked stays linked once. Every document must
 * be a current version in the invoice's company; an id from another company
 * is answered exactly like one that does not exist.
 */
export async function attachInvoiceUnderlag(
  ctx: Ctx,
  input: { invoice_id: string; document_ids: string[] },
  options: { dryRun: boolean },
): Promise<OperationOutcome<AttachInvoiceUnderlagResult>> {
  const wanted = [...new Set(input.document_ids)]
  const invoice = await findInvoice(ctx, input.invoice_id)
  if (!invoice) return fail('INVOICE_NOT_FOUND')

  const existing = await readUnderlag(ctx, input.invoice_id)
  if (existing === null) return UNAVAILABLE
  const linked = new Set(existing.map((u) => u.document_id))
  const added = wanted.filter((id) => !linked.has(id))

  const { data: docs, error: docsError } = added.length
    ? await ctx.supabase
        .from('document_attachments')
        .select('id, file_name, is_current_version')
        .eq('company_id', ctx.companyId)
        .in('id', added)
    : { data: [], error: null }
  if (docsError) throw docsError
  const found = new Map(
    ((docs ?? []) as Array<{ id: string; file_name: string; is_current_version: boolean | null }>)
      // A superseded version is history: link the version that stands.
      .filter((d) => d.is_current_version !== false)
      .map((d) => [d.id, d]),
  )
  const missing = added.filter((id) => !found.has(id))
  if (missing.length > 0) return fail('INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND', { document_ids: missing })

  if (existing.length + added.length > MAX_UNDERLAG_PER_INVOICE) {
    return fail('INVOICE_UNDERLAG_TOO_MANY', { limit: MAX_UNDERLAG_PER_INVOICE, current: existing.length })
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        attach: added.map((id) => ({ document_id: id, file_name: found.get(id)!.file_name })),
        already_attached_document_ids: wanted.filter((id) => linked.has(id)),
        underlag_count_after: existing.length + added.length,
      },
    }
  }

  // One row at a time, in the order given: created_at orders the list.
  for (const documentId of added) {
    const { error } = await ctx.supabase
      .from('invoice_underlag')
      .insert({ company_id: ctx.companyId, invoice_id: invoice.id, document_id: documentId })
    if (!error) continue
    // A concurrent call linked the same document: the outcome is the same.
    if ((error as { code?: string }).code === '23505') continue
    if (isMissingTableError(error)) return UNAVAILABLE
    throw error
  }

  return {
    ok: true,
    data: {
      invoice_id: invoice.id,
      attached_document_ids: added,
      underlag: (await readUnderlag(ctx, invoice.id)) ?? [],
    },
  }
}

export interface DetachInvoiceUnderlagResult {
  invoice_id: string
  document_id: string
  detached: true
}

/** Remove one document from the invoice's underlag. Only the link goes; the document stays in the archive. */
export async function detachInvoiceUnderlag(
  ctx: Ctx,
  input: { invoice_id: string; document_id: string },
  options: { dryRun: boolean },
): Promise<OperationOutcome<DetachInvoiceUnderlagResult>> {
  const invoice = await findInvoice(ctx, input.invoice_id)
  if (!invoice) return fail('INVOICE_NOT_FOUND')

  const existing = await readUnderlag(ctx, input.invoice_id)
  if (existing === null) return UNAVAILABLE
  const link = existing.find((u) => u.document_id === input.document_id)
  if (!link) return fail('INVOICE_UNDERLAG_NOT_FOUND', { document_id: input.document_id })

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        document_id: link.document_id,
        file_name: link.file_name,
      },
    }
  }

  const { data, error } = await ctx.supabase
    .from('invoice_underlag')
    .delete()
    .eq('company_id', ctx.companyId)
    .eq('invoice_id', invoice.id)
    .eq('document_id', input.document_id)
    .select('id')
  if (error) {
    if (isMissingTableError(error)) return UNAVAILABLE
    throw error
  }
  // Removed by a concurrent call between the read and the delete.
  if (!data || data.length === 0) return fail('INVOICE_UNDERLAG_NOT_FOUND', { document_id: input.document_id })
  return { ok: true, data: { invoice_id: invoice.id, document_id: input.document_id, detached: true } }
}
