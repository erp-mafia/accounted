import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { invoiceMailboxOptions, listInvoiceMailboxDispatches } from '@/lib/invoices/digital-mailbox-send'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET /api/invoices/{id}/digital-mailbox: the mailbox channels this invoice
 * can go through (providers whose sending the company activated, each with
 * whether the invoice and its customer allow it; local checks only) and the
 * invoice's dispatches so far.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.digital_mailbox.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const options = await invoiceMailboxOptions({ supabase, service: createServiceClient(), companyId }, id)
    if (!options) return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    const dispatches = await listInvoiceMailboxDispatches(supabase, companyId, id)
    return privateNoStore(NextResponse.json({ data: { options, dispatches } }))
  },
)
