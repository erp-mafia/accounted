/**
 * "Dölj <paket>?": a switchable package the company has not used for six
 * months and that has nothing open, proposed switched off.
 *
 * Behind SUGGESTIONS_HIDE_UNUSED (off unless `true` or `1`). Unlike the event
 * detectors this one reaches every existing company, Standard companies
 * included, so it stays dark until the operator turns it on. It runs from the daily
 * pending-operations cron (app/api/pending-operations/expire/cron) through
 * ./sweep.ts, never from a request.
 *
 * "Not used" is package_usage (migration 20261016200400): nothing created in
 * the package's own tables since the cut-off (an invoice, a salary run, an
 * inbox item, a connection, ...). "Nothing open" is the same
 * package_open_obligations set the commit re-checks before it switches the
 * package off, so a package with an unpaid invoice or an asset still in the
 * register is never proposed. A company younger than six months is skipped:
 * it has not had the time to use anything.
 */
import { getPackage } from '@/lib/modules/packages'
import type { SwitchablePackageId } from '@/lib/modules/profiles'
import { disablePackageProposal, SUGGESTION_RANKS } from '../package-proposals'
import type { Detector, DetectorContext } from '../types'

/** SUGGESTIONS_HIDE_UNUSED: the hide-unused detector runs. Off unless `true` or `1`. */
export function hideUnusedSuggestionsEnabled(): boolean {
  const raw = process.env.SUGGESTIONS_HIDE_UNUSED?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

/** How long a package goes unused before hiding it is proposed. */
export const UNUSED_MONTHS = 6

interface Subject {
  packageId: SwitchablePackageId
}

interface UsageRow {
  package_id: string
  used_since: boolean
  open_obligations: string[]
}

/** The cut-off: UNUSED_MONTHS before now. */
export function unusedSince(now: Date): Date {
  const since = new Date(now.getTime())
  since.setUTCMonth(since.getUTCMonth() - UNUSED_MONTHS)
  return since
}

/** Every switchable package's use and obligations in one call; null when unreadable. */
function usage(ctx: DetectorContext): Promise<Map<string, UsageRow> | null> {
  return ctx.memo('hide-unused:usage', async () => {
    const { data, error } = await ctx.supabase.rpc('package_usage', {
      p_company_id: ctx.companyId,
      p_since: unusedSince(ctx.now).toISOString(),
    })
    if (error) {
      ctx.log.warn('package usage could not be read; no hide suggestion', { companyId: ctx.companyId, error: error.message })
      return null
    }
    return new Map(((data ?? []) as UsageRow[]).map((row) => [row.package_id, row]))
  })
}

/** Whether the company has existed for the whole window. */
function oldEnough(ctx: DetectorContext): Promise<boolean> {
  return ctx.memo('hide-unused:old-enough', async () => {
    const { data, error } = await ctx.supabase.from('companies').select('created_at').eq('id', ctx.companyId).maybeSingle()
    if (error || !data) return false
    const createdAt = (data as { created_at: string | null }).created_at
    return !!createdAt && new Date(createdAt).getTime() <= unusedSince(ctx.now).getTime()
  })
}

export const hideUnusedDetector: Detector<Subject> = {
  id: 'hide-unused',
  trigger: { kind: 'schedule', cadence: 'daily' },
  enabled: hideUnusedSuggestionsEnabled,
  subjects: async (ctx) => {
    if (!(await oldEnough(ctx))) return []
    const capabilities = await ctx.capabilities()
    if (!capabilities) return []
    return capabilities.packages
      .filter((p) => p.switchable && p.availability === 'on')
      .map((p) => ({ packageId: p.id as SwitchablePackageId }))
  },
  condition: async (ctx, subject) => {
    const row = (await usage(ctx))?.get(subject.packageId)
    return !!row && row.used_since === false && Array.isArray(row.open_obligations) && row.open_obligations.length === 0
  },
  propose: (subject) => {
    const name = getPackage(subject.packageId).nameSv
    return disablePackageProposal(subject.packageId, {
      reason: `Du har inte använt ${name} på sex månader, och inget är öppet där. Du kan slå på det igen när du vill.`,
      rank: SUGGESTION_RANKS.hideUnused,
    })
  },
}
