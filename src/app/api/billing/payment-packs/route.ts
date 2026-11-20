import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getCompanyRole } from '@/lib/auth/require-write'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { readBankPaymentsAllowance } from '@/lib/payments/usage'
import { guardSandbox, isSandboxCompany, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { getStripe } from '@/lib/stripe/client'
import {
  MAX_PAYMENT_PACKS,
  changePaymentPacks,
  paymentPacksOffered,
  readCompanySubscription,
  readPaymentPacksView,
} from '@/lib/stripe/payment-packs'
import { paymentPacksOn } from '@/lib/stripe/subscription-items'
import { applyPaymentPacks } from '@/lib/stripe/subscription-sync'
import { createServiceClient } from '@/lib/supabase/server'

const PacksSchema = z.object({
  /** The packs the company should hold: the total, not a change. */
  packs: z.number().int().min(0).max(MAX_PAYMENT_PACKS),
})

/**
 * GET /api/billing/payment-packs: the company's bank payment packs (issue
 * #132) and whether this person may buy more. Every member reads it: the pay
 * dialogs show the owner "Köp fler betalningar" and everyone else "Begär
 * fler". Stripe is asked only for an owner who could buy.
 */
export const GET = withRouteContext('billing.payment_packs.read', async (_request, { user, supabase, companyId, role, log }) => {
  const resolved = await getCompanyRole(supabase, user.id, { companyId, role })
  const view = await readPaymentPacksView({
    supabase,
    service: createServiceClient(),
    companyId,
    role: resolved.ok ? resolved.role : null,
    isDemo: async () => user.is_anonymous === true || (await isSandboxCompany(supabase, companyId)),
    log,
  })
  return NextResponse.json({ data: view })
})

/**
 * POST /api/billing/payment-packs { packs }: set the packs on the company's
 * subscription. Owner only. More packs take effect now and the rest of the
 * period is charged at once; fewer take effect at the period end
 * (lib/stripe/payment-packs.ts). An increase is mirrored into
 * purchased_packs straight away, by the webhook's own function, so the cap
 * rises before the webhook lands. Not sold (no pack price set, or bank
 * payments not open to the company): 409 PAYMENT_PACKS_NOT_OFFERED, and
 * "Begär fler" stays the way.
 */
export const POST = withRouteContext('billing.payment_packs', async (request, { user, supabase, companyId, role, log, requestId }) => {
  // Demo accounts never reach Stripe (billing/checkout explains why).
  if (user.is_anonymous) return sandboxBlockedResponse()
  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const resolved = await getCompanyRole(supabase, user.id, { companyId, role })
  if (!resolved.ok) return resolved.response
  if (resolved.role !== 'owner') {
    return errorResponseFromCode('FORBIDDEN', log, {
      requestId,
      messageSv: 'Bara företagets ägare kan köpa fler betalningar.',
      messageEn: 'Only the company owner can buy more payments.',
      details: { required_roles: ['owner'] },
    })
  }

  const validation = await validateBody(request, PacksSchema, { log, operation: 'billing.payment_packs' })
  if (!validation.success) return validation.response

  const service = createServiceClient()
  const [offered, subscription] = await Promise.all([paymentPacksOffered(supabase, companyId), readCompanySubscription(service, companyId)])
  if (!offered) return errorResponseFromCode('PAYMENT_PACKS_NOT_OFFERED', log, { requestId })
  // Whether the subscription takes the change is Stripe's to answer (changePaymentPacks).
  if (!subscription) return errorResponseFromCode('PAYMENT_PACKS_SUBSCRIPTION_NOT_ACTIVE', log, { requestId })

  const change = await changePaymentPacks(getStripe(), subscription.id, validation.data.packs)
  if (!change.ok) return errorResponseFromCode(change.code, log, { requestId })
  if (change.updated) await applyPaymentPacks(service, companyId, paymentPacksOn(change.updated))
  log.info('payment packs changed', { packs: validation.data.packs, scheduledAt: change.scheduled?.at ?? null })

  const allowance = await readBankPaymentsAllowance(service, companyId)
  return NextResponse.json({ data: { included_payments: allowance.included, scheduled: change.scheduled } })
})
