import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { guardSandbox } from '@/lib/sandbox/guard'
import type { Currency } from '@/types'

const VALID_CURRENCIES: Currency[] = ['EUR', 'USD', 'GBP', 'NOK', 'DKK']

// Riksbanken's open API is IP rate-limited — the sandbox guard keeps demo
// traffic from eating that budget (withRouteContext already refuses
// sessions without an active company).
export const GET = withRouteContext('currency.rate', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const { searchParams } = new URL(request.url)
  const currency = searchParams.get('currency') as Currency | null
  const dateStr = searchParams.get('date')

  if (!currency || !VALID_CURRENCIES.includes(currency)) {
    return NextResponse.json({ error: 'Invalid currency' }, { status: 400 })
  }

  // Reject malformed dates up front — an Invalid Date would otherwise reach
  // the Riksbanken request as "NaN-NaN-NaN".
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return NextResponse.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 })
  }

  const date = dateStr ? new Date(dateStr) : undefined
  const rate = await fetchExchangeRate(currency, date)

  if (!rate) {
    return NextResponse.json({ error: 'Could not fetch exchange rate' }, { status: 502 })
  }

  return NextResponse.json({ data: rate })
})
