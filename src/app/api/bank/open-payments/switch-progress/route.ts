import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { getBankSwitchProgress } from '@/lib/bank-feed/switch-campaign'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET /api/bank/open-payments/switch-progress: the switch campaign for the
 * active company. `campaign` (on, deadline, days left) and `company` (where
 * this company stands: the connections still to switch, the uncovered ones)
 * for every member; `totals` across companies (counts per bank, no company
 * identities) for the company's owners and admins, from the service-role RPC
 * bank_switch_progress. The Kopplingar page reads it for the deep link and
 * the "Byt senast" line; the operation bank-feed.switch-progress is the
 * same read for the doors.
 */
export const GET = withRouteContext('bank_feed.switch_progress', async (_request, { supabase, companyId, role, log }) => {
  const admin = role ? role === 'owner' || role === 'admin' : await isCompanyAdmin(supabase, companyId)
  const data = await getBankSwitchProgress({ supabase, companyId }, { totalsClient: admin ? createServiceClient() : null })
  if (admin && data.campaign.on && !data.totals) log.warn('bank switch totals unavailable')
  return NextResponse.json({ data })
})
