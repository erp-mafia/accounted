import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { createLogger } from '@/lib/logger'

const log = createLogger('pending-operations/supersede')

/**
 * A staged operation whose subject has been handled another way must stop
 * looking approvable. An agent stages create_supplier_invoice_from_inbox, the
 * person then registers the same inbox item themselves, and the staged
 * operation stayed 'pending' like a second registration (crm#1074): the list
 * and the expiry sweep only look at age.
 *
 * Writes the row the commit dispatcher writes for a 409 auto-reject
 * (commit.ts): 'rejected' with result_data { auto_rejected, reason,
 * error_code, details }, so no reader needs a new status. CAS on 'pending':
 * an operation being approved right now ('committing') is its executor's.
 * Never throws: the conversion it follows has already happened.
 */
export async function rejectSupersededInboxConversions(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
  supplierInvoiceId: string,
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        result_data: {
          auto_rejected: true,
          reason:
            getErrorEntry('INBOX_ITEM_ALREADY_CONVERTED')?.message_sv ??
            'Posten är redan kopplad till en leverantörsfaktura.',
          error_code: 'INBOX_ITEM_ALREADY_CONVERTED',
          details: { inbox_item_id: inboxItemId, supplier_invoice_id: supplierInvoiceId },
        },
      })
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .eq('operation_type', 'create_supplier_invoice_from_inbox')
      .contains('params', { inbox_item_id: inboxItemId })
      .select('id')
    if (error) throw new Error(error.message)
    return ((data ?? []) as unknown[]).length
  } catch (err) {
    log.warn('superseded inbox conversions not rejected', {
      companyId,
      inboxItemId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
