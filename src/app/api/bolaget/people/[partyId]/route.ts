import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { renameRegisterParty, savePersonPrivate } from '@/lib/bolaget/people'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'

const text = (max: number) => z.string().trim().max(max).nullish()

const PersonSchema = z
  .object({
    // The name the registers print, and a company's organisationsnummer.
    name: z.string().trim().min(1).max(200).optional(),
    org_number: z.string().trim().max(20).nullish(),
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
 * PATCH /api/bolaget/people/{partyId}: the name, identity and postal address
 * the aktiebok prints for a holder (ABL 5:5). The personnummer is stored
 * encrypted with a keyed HMAC and answered masked; this is the only door
 * that takes one (never v1 or MCP). A changed name or organisationsnummer of
 * a party the aktiebok names is entered in the register by the database as a
 * dated note, and a replaced identity number or address is kept (ABL 5:3,
 * 5:9).
 */
export const PATCH = withRouteContext<{ params: Promise<{ partyId: string }> }>(
  'bolaget.person_update',
  async (request, ctx, { params }) => {
    const { partyId } = await params
    const gate = await bolagetGateResponse(ctx, 'registers')
    if (gate) return gate
    const validation = await validateBody(request, PersonSchema)
    if (!validation.success) return validation.response
    const { name, org_number: orgNumber, ...particulars } = validation.data
    // The name first: a refused name saves nothing.
    if (name !== undefined || orgNumber !== undefined) {
      const renamed = await renameRegisterParty(operationContext(ctx), partyId, {
        ...(name !== undefined ? { name } : {}),
        ...(orgNumber !== undefined ? { org_number: orgNumber } : {}),
      })
      if (!renamed.ok) return sessionFailureResponse(renamed, ctx.log, ctx.requestId)
    }
    const outcome = await savePersonPrivate(ctx.companyId, partyId, particulars)
    if (!outcome.ok) return errorResponseFromCode(outcome.code, ctx.log, { requestId: ctx.requestId })
    return NextResponse.json({ data: { party_id: partyId, personnummer_masked: outcome.personnummer_masked } })
  },
  { requireAdmin: true },
)
