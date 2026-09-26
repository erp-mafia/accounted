import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sendPayslips } from '@/lib/salary/payslips/send'
import { sessionFailureResponse } from '@/lib/operations/session'
import { capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { sandboxBlockedResponse } from '@/lib/sandbox/guard'

ensureInitialized()

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
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary_run.payslips_send',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const outcome = await sendPayslips({ supabase, companyId, userId: user.id, log }, id)
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
