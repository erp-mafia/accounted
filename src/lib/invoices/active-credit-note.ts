import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { hasActiveCreditNote } from '@/lib/transactions/invoice-document-refusal'

/**
 * Whether an active credit note stands against this invoice, read here so a
 * door cannot forget an embed. What counts as active is hasActiveCreditNote's.
 * Throws on a failed read: an unread credit note is not an absent one.
 */
export async function invoiceHasActiveCreditNote(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('invoices')
    .select('status, creation_complete')
    .eq('company_id', companyId)
    .eq('credited_invoice_id', invoiceId)
  if (error) throw dbError(error)
  return hasActiveCreditNote({ credit_notes: (data ?? []) as Array<{ status: string; creation_complete?: boolean | null }> })
}
