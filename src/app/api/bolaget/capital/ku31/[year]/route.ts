import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { loadKu31Status, saveKu31Settings } from '@/lib/bolaget/capital/ku31'
import { Ku31SettingsBody } from '@/lib/bolaget/capital/schemas'
import { isFiscalYear } from '@/lib/invariants/fiscal-year'

/** The inkomstår from the path: four digits, 2000-2099 (the range ku31_filings holds). */
function parseYear(raw: string): number | null {
  if (!isFiscalYear(raw)) return null
  const year = Number(raw)
  return year >= 2000 && year <= 2099 ? year : null
}

/** GET /api/bolaget/capital/ku31/{year}: the KU31 status of an inkomstår (masked identities, blockers). */
export const GET = withRouteContext<{ params: Promise<{ year: string }> }>('bolaget.ku31_status', async (_request, ctx, { params }) => {
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const year = parseYear((await params).year)
  if (year === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  return NextResponse.json({ data: await loadKu31Status(operationContext(ctx), year) })
})

/**
 * PUT /api/bolaget/capital/ku31/{year}: the fåmansföretag answer a person
 * confirms for the year (field 061 or 062) and the KU31 contact person.
 */
export const PUT = withRouteContext<{ params: Promise<{ year: string }> }>(
  'bolaget.ku31_settings',
  async (request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const year = parseYear((await params).year)
    if (year === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const validation = await validateBody(request, Ku31SettingsBody)
    if (!validation.success) return validation.response
    const outcome = await saveKu31Settings(operationContext(ctx), year, validation.data)
    if (!outcome.ok || outcome.dryRun) return errorResponseFromCode('UNKNOWN_ERROR', ctx.log, { requestId: ctx.requestId })
    return NextResponse.json({ data: await loadKu31Status(operationContext(ctx), year) })
  },
  { requireWrite: true },
)
