import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { listRules } from '@/lib/rules/service'
import { readDirectBookingSettings } from '@/lib/transactions/direct-booking-settings'

/**
 * GET /api/rules
 * Every rule (categorization template) of the active company, most used
 * first, with its ladder mode and counters, and the company's one-click
 * switch the page reads each rule's Ett klick under (ruleOneClick). Feeds
 * the Regler page.
 */
export const GET = withRouteContext('rule.list', async (_request, { supabase, companyId }) => {
  try {
    const [data, direct_booking] = await Promise.all([listRules(supabase, companyId), readDirectBookingSettings(supabase, companyId)])
    return NextResponse.json({ data, direct_booking })
  } catch (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }
})
