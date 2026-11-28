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
 * A registration corrected with storno + rättelse is reversed, and what
 * stands for it is the posted correction at the end of its chain
 * (liveEntryOf). The invoice followed it there (correction-payment-relink.ts),
 * and a storno of the correction clears the pointer the same way; deleting
 * that storno posts the correction again. So when no registration is posted,
 * the posted correction of a reversed one is looked for too.
 *
 * A registration that was posted and then undone is not found: the clean-up
 * of a lost link race cancels it and a failed registration is reversed with
 * no correction, and only a posted verifikat counts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { liveEntryOf } from '@/lib/core/bookkeeping/correction-chain'

/**
 * The newest posted registration verifikat booked from the invoice, else the
 * posted correction of one, else null. Throws when a read fails or a
 * correction chain is too long to follow.
 */
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
  if (row) return { id: row.id }

  const { data: reversed, error: reversedError } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('source_type', 'supplier_invoice_registered')
    .eq('source_id', supplierInvoiceId)
    .eq('status', 'reversed')
    .order('committed_at', { ascending: false })
  if (reversedError) {
    throw new Error(`supplier invoice registration: reversed voucher lookup failed: ${reversedError.message}`)
  }
  for (const { id } of (reversed ?? []) as Array<{ id: string }>) {
    const live = await liveEntryOf(supabase, companyId, id)
    if ('exhausted' in live) throw new Error('supplier invoice registration: correction chain too long to follow')
    if ('id' in live) return { id: live.id }
  }
  return null
}
