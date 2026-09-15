import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getPropertyFacts, requireBrfForm } from '@/lib/company/brf-tax-profile'
import { brfErrorResponse } from '@/lib/company/brf-route-helpers'
import { computeFastighetsavgift } from '@/lib/brf/fastighetsavgift'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/brf/fastighetsavgift?fiscal_year=YYYY
 *
 * Kommunal fastighetsavgift (bostadsdelen, lag 2007:1398) and statlig
 * fastighetsskatt (lokaler, lag 1984:1052) for the calendar year, computed
 * from the association's property facts. Read-only: the response names the
 * booking template (brf_fastighetsavgift, 5191 against bank) and the INK2
 * boxes the pre-filled underlag lands in; nothing is booked. Every other
 * legal form gets 409.
 */
export const GET = withRouteContext('brf.fastighetsavgift_get', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireBrfForm(supabase, companyId)
    const raw = new URL(request.url).searchParams.get('fiscal_year')
    const incomeYear = Number(raw)
    if (raw === null || !Number.isInteger(incomeYear) || incomeYear < 1990 || incomeYear > 2200) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'fiscal_year must be a calendar year' })
    }
    const facts = await getPropertyFacts(supabase, companyId)
    const toNumber = (value: number | string | null | undefined): number | null =>
      value === null || value === undefined ? null : Number(value)
    const computation = computeFastighetsavgift({
      incomeYear,
      antalBostadslagenheter: facts?.antal_bostadslagenheter ?? null,
      taxeringsvardeBostader: toNumber(facts?.taxeringsvarde_bostader),
      taxeringsvardeLokaler: toNumber(facts?.taxeringsvarde_lokaler),
      vardear: facts?.vardear ?? null,
    })
    if (!facts) {
      computation.warnings.unshift('Fastighetsuppgifter saknas: fyll i dem under Skatt > Bostadsrättsförening.')
    }
    return NextResponse.json({ data: computation })
  } catch (err) {
    return brfErrorResponse(err, log, requestId)
  }
})
