import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchKommunTaxRates } from '@/lib/salary/tax-tables'

/**
 * GET /api/salary/tax-tables/kommuner?year=2026
 *
 * Returns every Swedish municipality mapped to its derived skattetabell number
 * (29-42), sourced from Skatteverket's open-data API via fetchKommunTaxRates().
 * Powers the folkbokföringskommun picker on the employee form so the user only
 * has to choose their town: the tax table derives itself.
 *
 * The mapping changes once a year, so the result is cached in-process per year.
 */

interface KommunRate {
  kommun: string
  totalRate: number
  tableNumber: number
}

const cache = new Map<number, KommunRate[]>()

export const GET = withRouteContext('salary.tax_tables.kommuner', async (request) => {
  const { searchParams } = new URL(request.url)
  // A non-numeric or out-of-range year would otherwise reach Skatteverket as
  // 'år': 'NaN' and stick a NaN key in the module cache for the process
  // lifetime. Clamp to a sane window and fall back to the current year.
  const parsedYear = parseInt(searchParams.get('year') || '', 10)
  const year =
    Number.isFinite(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
      ? parsedYear
      : new Date().getFullYear()

  let kommuner = cache.get(year)
  if (!kommuner) {
    const list = await fetchKommunTaxRates(year)
    list.sort((a, b) => a.kommun.localeCompare(b.kommun, 'sv'))
    kommuner = list
    cache.set(year, list)
  }

  return NextResponse.json({ data: { year, kommuner } })
})
