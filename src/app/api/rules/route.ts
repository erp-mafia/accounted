import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { listRules } from '@/lib/rules/service'

/**
 * GET /api/rules
 * Every rule (categorization template) of the active company, most used
 * first, with its ladder mode and counters. Feeds the Regler page.
 */
export const GET = withRouteContext('rule.list', async (_request, { supabase, companyId }) => {
  try {
    const data = await listRules(supabase, companyId)
    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }
})
