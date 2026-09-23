import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchTaxTableRates, TaxTableUnavailableError } from '@/lib/salary/tax-tables'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Probe Skatteverket's open data API to confirm tax tables are reachable.
 * Used by the salary settings page to surface that fetching is automatic.
 */
export const GET = withRouteContext('salary.tax_tables.status', async (request) => {
  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || String(new Date().getFullYear()))

  try {
    const { source } = await fetchTaxTableRates(year, 30, 1)
    return NextResponse.json({
      data: {
        year,
        source,
        reachable: source === 'api',
        checkedAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    if (err instanceof TaxTableUnavailableError) {
      return NextResponse.json({
        data: {
          year,
          source: 'unavailable' as const,
          reachable: false,
          checkedAt: new Date().toISOString(),
          message: getUserErrorMessage(err),
        },
      })
    }
    throw err
  }
})
