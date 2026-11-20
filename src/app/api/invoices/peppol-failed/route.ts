import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listPeppolFailedInvoiceIds } from '@/lib/invoices/peppol-failed-invoices'

/**
 * GET /api/invoices/peppol-failed: ids of the active company's invoices whose
 * latest Peppol delivery failed, for the invoice list's "Peppol misslyckades"
 * chip. One definition with the Att göra row
 * (lib/invoices/peppol-failed-invoices.ts), so the chips and the count agree.
 *
 * Read on the user's own session client: the peppol_failed_invoice_ids
 * function checks membership and returns invoice ids only.
 */
export const GET = withRouteContext('invoice.peppol.failed.list', async (_request, { supabase, companyId }) => {
  const invoiceIds = await listPeppolFailedInvoiceIds({ supabase, companyId })
  return privateNoStore(NextResponse.json({ data: invoiceIds }))
})
