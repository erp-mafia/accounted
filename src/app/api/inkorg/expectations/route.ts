import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  HORIZON_DAYS,
  purchasesOnTheWay,
  upcomingExpectations,
  type ExpectationsResponse,
} from '@/lib/inkorg/expectations'
import { loadExpectations } from '@/lib/inkorg/expectations-read'
import { fetchPurchasesWithoutUnderlag } from '@/lib/receipt-hunt/purchases-without-underlag'
import { vendorLogoUrls } from '@/lib/vendor-logos/read'

/**
 * GET /api/inkorg/expectations
 *
 * What the Inkorg's Saknar underlag view needs beyond the purchases:
 *   - expectations: the next document from each supplier that bills on a
 *     regular cadence, due within the next 45 days (Väntas senare), with its
 *     date window, usual amount and the door it usually comes through;
 *   - on_the_way: the purchases without underlag whose document usually
 *     arrives by itself (Peppol, the intake address) and is still within the
 *     days it usually takes (På väg). Every other purchase needs a person.
 *
 * Each expectation carries the vendor's stored icon (lib/vendor-logos) as
 * logo_url, as the other Inkorg lists do; none stored is null.
 *
 * Computed from the company's own bank rows and supplier invoices
 * (lib/inkorg/expectations.ts), never from extracted agreements. The open
 * purchases are the same canonical read GET /purchases lists, so the two
 * cannot disagree about what is missing.
 *
 * Read only: nothing is stored, and nobody is notified.
 */
export const GET = withRouteContext('inkorg.expectations', async (_request, { supabase, companyId }) => {
  const today = todayIsoStockholm()
  const [expectations, open] = await Promise.all([
    loadExpectations(supabase, companyId, today),
    fetchPurchasesWithoutUnderlag(supabase, companyId),
  ])
  const upcoming = upcomingExpectations(expectations, today)
  const logos = await vendorLogoUrls(upcoming.map((e) => ({ key: e.key, name: e.counterparty })))
  const data: ExpectationsResponse = {
    horizon_days: HORIZON_DAYS,
    expectations: upcoming.map((e) => ({ ...e, logo_url: logos.get(e.key) ?? null })),
    on_the_way: purchasesOnTheWay(open, expectations, today),
  }
  return NextResponse.json({ data })
})
