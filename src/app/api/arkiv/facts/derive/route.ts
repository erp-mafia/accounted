import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { deriveCompanyFacts } from '@/lib/arkiv/facts/derive-company'
import { todayIso } from '@/lib/arkiv/agreements/dates'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/arkiv/facts/derive
 * Recomputes the company's facts from the ledger, the registers and the
 * Bolagsverket snapshot, now, for the active company. The nightly derive
 * cron does the same for every company in the rollout; this is the button.
 */
export const maxDuration = 120

export const POST = withRouteContext('arkiv.facts.derive', async (_request, ctx) => {
  if (!isArkivBrainEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const out = await deriveCompanyFacts(createServiceClient(), ctx.companyId, todayIso(), (account) => getBASReference(account)?.account_name ?? null)
    ctx.log.info('company facts derived', { company: ctx.companyId, ...out })
    return NextResponse.json({ data: out })
  } catch (err) {
    ctx.log.error('company facts derive failed', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }
})
