import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { setAvstamningsbolag } from '@/lib/bolaget/share-register'

const SettingsSchema = z.object({ is_avstamningsbolag: z.boolean() }).strict()

/**
 * PATCH /api/bolaget/settings: mark the company an avstämningsbolag (or
 * not). The central securities depository then keeps the aktiebok (ABL
 * 5:11-12) and this register takes no entries; what is in it stays.
 */
export const PATCH = withRouteContext(
  'bolaget.settings_update',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, SettingsSchema)
    if (!validation.success) return validation.response
    await setAvstamningsbolag(operationContext(ctx), validation.data.is_avstamningsbolag)
    return NextResponse.json({ data: { is_avstamningsbolag: validation.data.is_avstamningsbolag } })
  },
  { requireWrite: true },
)
