import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceDocumentType } from '@/types'
import { userFacing } from '@/lib/errors/user-facing'
import { invoiceSeriesBehindMessages, type InvoiceSeriesBehind } from '@/lib/company/invoice-number-series'

type InvoiceShape = Pick<Invoice, 'id' | 'invoice_number'> & {
  invoice_number: string | null
  document_type?: InvoiceDocumentType | null
  is_self_billed?: boolean | null
  external_invoice_number?: string | null
}

/**
 * The company's series already has a higher number than the next one, so
 * issuing would fill a hole in the series or restart it (ML 17 kap 24 § p. 2).
 * Nothing was used up. The company sets where its series continues
 * (next_invoice_number, or a new invoice_prefix) and issues again.
 */
export class InvoiceNumberSeriesBehindError extends Error {
  readonly code = 'INVOICE_NUMBER_SERIES_BEHIND'
  readonly details: InvoiceSeriesBehind
  readonly messageEn: string

  constructor(details: InvoiceSeriesBehind) {
    const messages = invoiceSeriesBehindMessages(details)
    super(messages.sv)
    this.name = 'InvoiceNumberSeriesBehindError'
    this.details = details
    this.messageEn = messages.en
    userFacing(this, this.code)
  }
}

/** generate_invoice_number's refusal (PT409 INVOICE_NUMBER_SERIES_BEHIND), read back from PostgREST. */
function seriesBehindFrom(error: { code?: string; message?: string; details?: string | null }): InvoiceSeriesBehind | null {
  if (error.code !== 'PT409' || error.message !== 'INVOICE_NUMBER_SERIES_BEHIND') return null
  try {
    const raw = JSON.parse(error.details ?? '') as Record<string, unknown>
    const highest = Number(raw.highest_number)
    const firstAllowed = Number(raw.first_allowed)
    if (!Number.isSafeInteger(highest) || !Number.isSafeInteger(firstAllowed)) return null
    return {
      prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
      highest_number: highest,
      first_allowed: firstAllowed,
    }
  } catch {
    return null
  }
}

/**
 * How a door answers a failed numbering: the series refusal with its own code,
 * sentence and numbers (the company can act on it), anything else with the
 * door's own code.
 */
export function invoiceNumberingFailure(
  err: unknown,
  fallbackCode: string,
): { code: string; messageSv?: string; messageEn?: string; details?: Record<string, unknown> } {
  if (err instanceof InvoiceNumberSeriesBehindError) {
    return { code: err.code, messageSv: err.message, messageEn: err.messageEn, details: { ...err.details } }
  }
  return { code: fallbackCode }
}

/**
 * Assign an invoice number to a draft invoice. Idempotent: if the row already
 * has a number, returns it unchanged without consuming a sequence number.
 *
 * Concurrency is handled inside the generate_invoice_number RPC via row lock.
 * Two callers racing on the same draft both return the same final number; the
 * counter advances by exactly one. A proforma takes the next number of its own
 * PF- series, a följesedel the next one of its FS- series; an invoice the
 * next one of the company's invoice_prefix series. Throws
 * InvoiceNumberSeriesBehindError when the series already has a higher number
 * than the next one. A quote is never numbered here: it takes its OF- number
 * at insert.
 */
export async function ensureInvoiceNumber(
  supabase: SupabaseClient,
  companyId: string,
  invoice: InvoiceShape,
): Promise<string> {
  if (invoice.invoice_number) {
    return invoice.invoice_number
  }

  // generate_invoice_number puts every type but a proforma in the invoice
  // series, while the series' position counts invoices only: an F number on a
  // följesedel or an offert was a hole in the invoice series for good (ML 17
  // kap 24 § p. 2, accounted#58). The v1 bulk-create and MCP doors create a
  // följesedel without a number, so it is numbered from its own series when it
  // is issued; a quote without its OF- number is refused.
  if (invoice.document_type === 'delivery_note') {
    return ensureDeliveryNoteNumber(supabase, companyId, invoice)
  }
  if (invoice.document_type === 'quote') {
    throw new Error('Failed to assign invoice number: a quote takes its OF- number at insert, never one from the invoice series')
  }

  // Self-billing invoices we received carry the COUNTERPARTY's number; we must
  // never consume our own löpnummerserie for them (BFL 5 kap 6§). The DB
  // constraint invoices_self_billed_numbering guarantees the external number is
  // present, but guard here so a future caller can't silently mint an F-number.
  if (invoice.is_self_billed) {
    if (!invoice.external_invoice_number) {
      throw new Error('Self-billed invoice is missing external_invoice_number')
    }
    return invoice.external_invoice_number
  }

  const { data: assigned, error: rpcError } = await supabase.rpc('generate_invoice_number', {
    p_company_id: companyId,
    p_invoice_id: invoice.id,
    p_document_type: invoice.document_type ?? 'invoice',
  })

  if (rpcError || !assigned) {
    const behind = rpcError ? seriesBehindFrom(rpcError) : null
    if (behind) throw new InvoiceNumberSeriesBehindError(behind)
    throw new Error(`Failed to assign invoice number: ${rpcError?.message ?? 'no value returned'}`)
  }

  invoice.invoice_number = assigned
  return assigned
}

/**
 * A följesedel's number from its FS- series (generate_delivery_note_number,
 * the number the dashboard and v1 create give one at insert), written only
 * while the row still has none. A caller that lost that race reads the number
 * the winner wrote; the FS number it drew stays unused, a gap in the följesedel
 * series only, never in the invoice series.
 */
async function ensureDeliveryNoteNumber(
  supabase: SupabaseClient,
  companyId: string,
  invoice: InvoiceShape,
): Promise<string> {
  const { data: drawn, error: rpcError } = await supabase.rpc('generate_delivery_note_number', {
    p_company_id: companyId,
  })
  if (rpcError || typeof drawn !== 'string' || !drawn) {
    throw new Error(`Failed to assign delivery note number: ${rpcError?.message ?? 'no value returned'}`)
  }

  const { data: written, error: writeError } = await supabase
    .from('invoices')
    .update({ invoice_number: drawn })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
    .is('invoice_number', null)
    .select('invoice_number')
  if (writeError) {
    throw new Error(`Failed to assign delivery note number: ${writeError.message}`)
  }

  let assigned = (written as Array<{ invoice_number: string | null }> | null)?.[0]?.invoice_number ?? null
  if (!assigned) {
    const { data: current, error: readError } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('id', invoice.id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (readError) throw new Error(`Failed to assign delivery note number: ${readError.message}`)
    assigned = (current as { invoice_number: string | null } | null)?.invoice_number ?? null
  }
  if (!assigned) {
    throw new Error('Failed to assign delivery note number: the delivery note was not found')
  }

  invoice.invoice_number = assigned
  return assigned
}
