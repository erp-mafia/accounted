/**
 * Invoices whose latest Peppol delivery failed. The Att göra row
 * "Peppol-leveranser som misslyckades" and the invoice list's
 * "Peppol misslyckades" chip read this one definition, so the count and the
 * chips cannot disagree.
 *
 * The definition lives in SQL: peppol_failed_invoice_ids (migration
 * 20260929200000). An invoice counts while its newest delivery is 'failed'
 * or 'no_route' and it is still sent or overdue; it drops out when a newer
 * delivery goes through (a resend of changed content stages a new delivery
 * row) or the invoice is paid, credited or cancelled.
 *
 * peppol_deliveries is not granted to authenticated, so the function is
 * SECURITY DEFINER, returns invoice ids only, and returns nothing unless the
 * caller is a member of the company. Call it on the user's own session
 * client: a service-role client has no auth.uid() and gets nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * At most this many ids per call (the function caps at 500). A count read
 * from the list is therefore capped too, which is fine for a to-do badge.
 */
export const PEPPOL_FAILED_INVOICE_LIMIT = 200

export async function listPeppolFailedInvoiceIds(args: {
  supabase: SupabaseClient
  companyId: string
}): Promise<string[]> {
  const { data, error } = await args.supabase.rpc('peppol_failed_invoice_ids', {
    p_company_id: args.companyId,
    p_limit: PEPPOL_FAILED_INVOICE_LIMIT,
  })
  if (error) throw new Error(`Failed to list invoices with a failed Peppol delivery: ${error.message}`)
  return ((data ?? []) as unknown[]).filter((id): id is string => typeof id === 'string')
}
