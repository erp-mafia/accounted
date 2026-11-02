import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { acceptUsageCharges, revokeUsageCharges } from '@/lib/usage/consent'
import { billedUsageKinds, USAGE_GATED_KINDS, USAGE_KINDS, USAGE_PRICES } from '@/lib/usage/kinds'
import { readCompanyPays } from '@/lib/usage/paying'
import { includedOverrideFor } from '@/lib/usage/summary'

const ConsentSchema = z.object({
  kind: z.enum(USAGE_KINDS),
  accepted: z.boolean(),
})

/**
 * PUT /api/billing/usage/consent { kind, accepted }: an admin accepts that
 * use of a priced service above what the month includes costs its unit
 * price, or turns that off again (lib/usage/consent.ts). Accepting records
 * who, when, and the price and included amount shown; it holds until turned
 * off. Admin only, and a session route only: an agent never accepts a cost.
 * A kind that is not billed here answers 409 USAGE_CHARGES_NOT_OFFERED, and
 * a company without a subscription of its own 409 USAGE_SUBSCRIPTION_REQUIRED.
 */
export const PUT = withRouteContext(
  'billing.usage.consent',
  async (request, { companyId, user, log, requestId }) => {
    const validation = await validateBody(request, ConsentSchema, { log, operation: 'billing.usage.consent' })
    if (!validation.success) return validation.response
    const { kind, accepted } = validation.data
    const service = createServiceClient()

    if (!accepted) {
      await revokeUsageCharges(service, { companyId, kind, userId: user.id })
      return NextResponse.json({ data: { kind, accepted: false, accepted_at: null } })
    }

    if (!billedUsageKinds().has(kind) || !USAGE_GATED_KINDS.has(kind)) {
      return errorResponseFromCode('USAGE_CHARGES_NOT_OFFERED', log, { requestId, details: { kind } })
    }
    if (!(await readCompanyPays(service, companyId))) {
      return errorResponseFromCode('USAGE_SUBSCRIPTION_REQUIRED', log, { requestId, details: { kind } })
    }
    const included = (await includedOverrideFor(service, companyId, kind)) ?? USAGE_PRICES[kind].includedPerMonth ?? 0
    const consent = await acceptUsageCharges(service, { companyId, kind, userId: user.id, included })
    log.info('usage charges accepted', { kind, unit_price_ore: consent.unit_price_ore })
    return NextResponse.json({ data: { kind, accepted: true, accepted_at: consent.accepted_at } })
  },
  { requireAdmin: true },
)
