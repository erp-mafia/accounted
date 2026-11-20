import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getEmailService } from '@/lib/email/service'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { createEmailReminderChannel } from '@/lib/reminders/channels/email'
import { dispatchReminder } from '@/lib/reminders/dispatch'
import { ReminderInvoiceNotFoundError } from '@/lib/reminders/facts'
import { guardSandbox } from '@/lib/sandbox/guard'
import { createServiceClient } from '@/lib/supabase/server'

/** One reminder mail per picked invoice, one after another. */
export const maxDuration = 120

const BodySchema = z.object({
  /** The invoices a person picked to remind now (the invoice page, or the turn-on sheet's older invoices). */
  invoice_ids: z.array(z.uuid()).min(1).max(50),
  /** The person saw that the bank was not synced in 24 hours (or none is connected) and sends anyway. */
  bank_attested: z.boolean().optional(),
})

/**
 * POST /api/reminders/send: remind the picked invoices now, each at the
 * level the policy decides (a first reminder for an invoice not on the
 * ladder). Every send goes through dispatchReminder, which decides the
 * invoice again from fresh facts and checks the bank: a possible payment
 * stops it, and a bank not synced in 24 hours stops it unless the person
 * attested. Answers each invoice's outcome; nothing is sent twice for one
 * level. Needs only the product switch, not the company's reminders toggle:
 * a pick is a person's own decision.
 */
export const POST = withRouteContext(
  'reminders.send',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const body = await validateBody(request, BodySchema, { log, operation: 'reminders.send' })
    if (!body.success) return body.response
    if (!REMINDERS_SENDING_ENABLED) return errorResponseFromCode('REMINDERS_UNAVAILABLE', log, { requestId })

    // The sandbox must never deliver a real email to a real customer.
    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked
    const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.email_send)
    if (capBlocked) return capBlocked
    const emailService = await getEmailService()
    if (!emailService.isConfigured()) return errorResponseFromCode('INVOICE_SEND_EMAIL_NOT_CONFIGURED', log, { requestId })

    const deps = { db: createServiceClient(), channel: createEmailReminderChannel(emailService), log }
    const results = []
    for (const invoiceId of [...new Set(body.data.invoice_ids)]) {
      try {
        const outcome = await dispatchReminder(deps, {
          companyId,
          invoiceId,
          actorUserId: user.id,
          mode: 'manual',
          bankAttested: body.data.bank_attested === true,
        })
        results.push({ invoice_id: invoiceId, ...outcome })
      } catch (error) {
        if (error instanceof ReminderInvoiceNotFoundError) {
          results.push({ invoice_id: invoiceId, status: 'skipped' as const, reason: 'not_found' as const })
          continue
        }
        log.error('picked reminder failed', error as Error, { invoiceId })
        results.push({ invoice_id: invoiceId, status: 'failed' as const, code: 'INTERNAL_ERROR', outcomeUnknown: true })
      }
    }
    return NextResponse.json({ data: { results } })
  },
  { requireWrite: true },
)
