import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceDocumentType } from '@/types'

type InvoiceShape = Pick<Invoice, 'id' | 'invoice_number'> & {
  invoice_number: string | null
  document_type?: InvoiceDocumentType | null
  is_self_billed?: boolean | null
  external_invoice_number?: string | null
}

/**
 * Assign an invoice number to a draft invoice. Idempotent: if the row already
 * has a number, returns it unchanged without consuming a sequence number.
 *
 * Concurrency is handled inside the generate_invoice_number RPC via row lock.
 * Two callers racing on the same draft both return the same final number; the
 * counter advances by exactly one. Proforma document_type produces a 'PF-'
 * prefix; everything else uses the company's configured invoice_prefix.
 */
export async function ensureInvoiceNumber(
  supabase: SupabaseClient,
  companyId: string,
  invoice: InvoiceShape,
): Promise<string> {
  if (invoice.invoice_number) {
    return invoice.invoice_number
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
    throw new Error(`Failed to assign invoice number: ${rpcError?.message ?? 'no value returned'}`)
  }

  invoice.invoice_number = assigned
  return assigned
}
