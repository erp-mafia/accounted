import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { arkivRollout } from '@/lib/arkiv/flag'
import { lintCompanies } from '@/lib/arkiv/lint/run'
import { todayIso } from '@/lib/arkiv/agreements/dates'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/lint/cron
 * Arkiv phase 6, nightly: for every company in the rollout, compares what
 * the archive knows with the settings and the agreements, files findings a
 * person can act on, and recomputes the autonomy level per document type.
 */
export const maxDuration = 300

const MAX_COMPANIES = 500

/** With `*` in the rollout, every company; the nightly budget is one lint per company. */
async function everyCompany(supabase: ReturnType<typeof createServiceRoleClient>): Promise<string[]> {
  const { data, error } = await supabase.from('companies').select('id').limit(MAX_COMPANIES)
  if (error) throw new Error(`companies fetch failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string }>).map((c) => c.id)
}

export const GET = withCronContext('arkiv.lint', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const rollout = arkivRollout()
    const companies = rollout === 'all' ? await everyCompany(supabase) : rollout
    const results = await lintCompanies(supabase, companies, todayIso())
    const totals = Object.values(results).reduce(
      (acc, r) =>
        'error' in r ? { ...acc, failed: acc.failed + 1 } : { ...acc, findings: acc.findings + r.findings, opened: acc.opened + r.opened, closed: acc.closed + r.closed },
      { companies: companies.length, findings: 0, opened: 0, closed: 0, failed: 0 },
    )
    ctx.log.info('arkiv lint', totals)
    return NextResponse.json({ ok: true, ...totals })
  } catch (err) {
    ctx.log.error('arkiv lint failed', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: getErrorMessage(err) }, { status: 500 })
  }
})
