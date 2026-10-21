import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sendPayslips } from '@/lib/salary/payslips/send'
import { sessionFailureResponse } from '@/lib/operations/session'
import { capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { sandboxBlockedResponse } from '@/lib/sandbox/guard'

/**
 * Send payslips to all employees with email addresses: as secure LINKS,
 * never PDF attachments (salary data + personnummer must not sit in
 * inboxes). Each send rotates the employee's link: previously emailed links
 * stop resolving.
 *
 * Per BFL 7 kap.: every attempt (sent/failed/skipped) is persisted to
 * salary_payslip_deliveries as the audit trail.
 *
 * The rules (sandbox, email_send capability, approved+ status, the delivery
 * log) live in lib/salary/payslips/send.ts, shared with the v1 operation
 * salary-runs.send-payslips and gnubok_send_payslips. The sandbox and
 * capability refusals keep the envelopes the UI has always read.
 *
 * Optional body { channel: 'email' | 'kivra' | 'billo' }: a digital mailbox
 * channel sends each payslip's PDF to the employee's Kivra or Billo mailbox
 * where it reaches them and the email link to the rest
 * (lib/salary/payslips/send-digital-mailbox.ts). No body is the email link.
 */
const SendPayslipsBody = z.object({ channel: z.enum(['email', 'kivra', 'billo']).optional() })
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary_run.payslips_send',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const text = await request.text()
    let raw: unknown = {}
    if (text.trim()) {
      try {
        raw = JSON.parse(text)
      } catch {
        return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { field: 'body' } })
      }
    }
    const body = SendPayslipsBody.safeParse(raw)
    if (!body.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { field: 'channel' } })
    }

    const outcome = await sendPayslips({ supabase, companyId, userId: user.id, log }, id, { channel: body.data.channel })
    if (!outcome.ok) {
      if (outcome.code === 'SALARY_PAYSLIPS_SEND_SANDBOX') return sandboxBlockedResponse()
      if (outcome.code === 'SALARY_PAYSLIPS_SEND_CAPABILITY_BLOCKED') {
        return capabilityBlockedResponse(CAPABILITY.email_send)
      }
      return sessionFailureResponse(outcome, log, requestId)
    }
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    const { sent, skipped, errors, total } = outcome.data
    return NextResponse.json({
      data: {
        sent,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
        total,
      },
    })
  },
  { requireWrite: true },
)
