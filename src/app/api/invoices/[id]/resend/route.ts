import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getEmailService } from '@/lib/email/service'
import { resendInvoiceEmail } from '@/lib/invoices/resend-invoice'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

/**
 * POST /api/invoices/[id]/resend (crm#1339)
 *
 * "Skicka igen": emails an issued, unpaid invoice to the customer again with
 * the exact PDF they were first sent, marked as a copy. Not a reminder and
 * not a new issue: the invoice, its verifikat and its status are untouched,
 * and the send is recorded in the delivery history. The rules live in
 * resendInvoiceEmail (lib/invoices/resend-invoice.ts).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.resend',
  async (_request, { user, supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ invoiceId: id })

    // The sandbox must never deliver a real email to a real customer.
    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.email_send)
    if (capBlocked) return capBlocked

    const emailService = await getEmailService()
    if (!emailService.isConfigured()) {
      return errorResponseFromCode('INVOICE_SEND_EMAIL_NOT_CONFIGURED', opLog, { requestId })
    }

    const result = await resendInvoiceEmail({
      supabase,
      emailService,
      companyId,
      userId: user.id,
      userEmail: user.email,
      invoiceId: id,
      log: opLog,
    })

    if (!result.ok) {
      return errorResponseFromCode(result.code, opLog, {
        requestId,
        ...(result.details ? { details: result.details } : {}),
      })
    }

    return NextResponse.json(
      {
        data: {
          delivery_id: result.deliveryId,
          recipient_counts: result.recipientCounts,
          ...(result.trackingWarning ? { tracking_warning: result.trackingWarning } : {}),
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
  { requireWrite: true },
)
