import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { savePersonPrivate } from '@/lib/bolaget/people'
import { bolagetGateResponse } from '@/lib/bolaget/session'

const text = (max: number) => z.string().trim().max(max).nullish()

const PersonSchema = z
  .object({
    personnummer: z.string().trim().max(20).nullish(),
    birth_date: saneIsoDateSchema.nullish(),
    foreign_id: text(64),
    address_line1: text(200),
    address_line2: text(200),
    postal_code: text(20),
    city: text(100),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/).nullish(),
    email: z.string().trim().email().max(254).nullish().or(z.literal('')),
    phone: text(40),
  })
  .strict()

/**
 * PATCH /api/bolaget/people/{partyId}: the identity and postal address the
 * aktiebok prints for a holder (ABL 5:5). The personnummer is stored
 * encrypted with a keyed HMAC and answered masked; this is the only door
 * that takes one (never v1 or MCP).
 */
export const PATCH = withRouteContext<{ params: Promise<{ partyId: string }> }>(
  'bolaget.person_update',
  async (request, ctx, { params }) => {
    const { partyId } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, PersonSchema)
    if (!validation.success) return validation.response
    const outcome = await savePersonPrivate(ctx.companyId, partyId, validation.data)
    if (!outcome.ok) return errorResponseFromCode(outcome.code, ctx.log, { requestId: ctx.requestId })
    return NextResponse.json({ data: { party_id: partyId, personnummer_masked: outcome.personnummer_masked } })
  },
  { requireWrite: true },
)
