/**
 * The registration verifikat booked from a supplier invoice that still
 * stands, when there is one.
 *
 * An invoice names its registration verifikat in
 * registration_journal_entry_id. A storno of that verifikat clears the
 * pointer (registration-reversal.ts), so the invoice reads not booked and
 * the Bokför step books it again. If that storno is then deleted with Radera
 * senaste verifikat, the original registration is posted again while the
 * invoice still names none, and Bokför would post the registration a second
 * time. The Bokför step (book-service.ts) asks here first and hands the
 * invoice back to the registration that stands.
 *
 * A registration that was posted and then undone is not found: the clean-up
 * of a lost link race cancels it and a failed registration is reversed, and
 * only a posted verifikat counts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The newest posted registration verifikat booked from the invoice, or null. Throws when the read fails. */
export async function findStandingRegistration(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('source_type', 'supplier_invoice_registered')
    .eq('source_id', supplierInvoiceId)
    .eq('status', 'posted')
    .order('committed_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`supplier invoice registration: standing voucher lookup failed: ${error.message}`)
  const row = ((data ?? []) as Array<{ id: string }>)[0]
  return row ? { id: row.id } : null
}
