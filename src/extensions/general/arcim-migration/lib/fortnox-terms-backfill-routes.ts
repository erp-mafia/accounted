import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApiRouteDefinition } from '@/lib/extensions/types'
import { validateBody } from '@/lib/api/validate'
import { requireAuth } from '@/lib/auth/require-auth'
import { claimsPinned } from '@/lib/auth/claims'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'
import { applyTermsFills, planFortnoxTermsBackfill, type TermsBackfillPlan } from './backfill-fortnox-terms'
import { isMigrationResetSource } from './repair-fortnox-supplier-numbers'

/**
 * crm#1245, run inside the deployment: gives Fortnox-imported customers and
 * suppliers the payment terms Fortnox holds (backfill-fortnox-terms). Inside,
 * because the Fortnox tokens open only with keys that exist only in Vercel
 * (decision 2026-10-22, crm#1157). The route answers with counts and the
 * cursor, never a card.
 *
 * The backfill spans every company with Fortnox, which no membership covers,
 * so the gate is the caller: signed in, an MFA (AAL2) session, and one of
 * OPERATOR_USER_IDS. Anyone else gets a 404, as if the route did not exist.
 * One-off: remove this file once the backfill has run.
 *
 * One company per request; the operator's browser loops:
 *
 *   GET  /api/extensions/ext/arcim-migration/fortnox-terms-backfill/companies
 *   POST /api/extensions/ext/arcim-migration/fortnox-terms-backfill
 *        { "mode": "dry_run" | "execute", "company_id": "<uuid>", "from": "<next>" }
 *
 * Every card needs its own Fortnox read, so a dry run costs what an execute
 * costs; the safety is in the write instead, which happens only while the
 * card is still on 30. A run that reaches the time budget answers `next`;
 * the following request passes it as `from`, until `next` is null.
 */

/** The people who may run the backfill (as for crm#1157 and crm#1436). */
const OPERATOR_USER_IDS = new Set(['79b67419-5804-4718-bf49-8b2ad2b9e622'])

/** Under the dispatcher's 800 s ceiling with room to write and answer. */
const READ_BUDGET_MS = 540_000

const log = createLogger('ext:arcim-migration:fortnox-terms-backfill')

const RunSchema = z.object({
  mode: z.enum(['dry_run', 'execute']),
  company_id: z.uuid(),
  from: z.string().min(1).max(200).nullable().default(null),
}).strict()

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status })
}

/**
 * The operator's user id, or the refusal. The dispatcher has already signed
 * the caller in; this asks again for the user and for an AAL2 session, which
 * requireAuth alone does not demand of a user without a factor.
 */
async function requireOperator(): Promise<{ userId: string } | { response: NextResponse }> {
  const auth = await requireAuth()
  if (auth.error) return { response: auth.error }
  if (!OPERATOR_USER_IDS.has(auth.user.id)) return { response: error(404, 'NOT_FOUND', 'Not found') }
  const { data } = await auth.supabase.auth.getClaims()
  const claims = data?.claims
  if (!claims || !claimsPinned(claims) || claims.sub !== auth.user.id || claims.aal !== 'aal2') {
    return { response: error(403, 'MFA_REQUIRED', 'Sign in with MFA (AAL2) to run the backfill.') }
  }
  return { userId: auth.user.id }
}

/** The plan without the fills themselves. */
function report({ fills, ...plan }: TermsBackfillPlan) {
  return { ...plan, fills: fills.length }
}

export const fortnoxTermsBackfillRoutes: ApiRouteDefinition[] = [
  {
    // Every live company that has a Fortnox connection to read from.
    method: 'GET',
    path: '/fortnox-terms-backfill/companies',
    skipCompanyContext: true,
    handler: async () => {
      const operator = await requireOperator()
      if ('response' in operator) return operator.response
      try {
        const supabase = createServiceClientNoCookies()
        const rows = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
          supabase.from('provider_consents').select('company_id').eq('provider', 'fortnox').in('status', [0, 1])
            .order('company_id').range(from, to))
        const ids = [...new Set(rows.map((r) => r.company_id))]
        const companies: { id: string; name: string }[] = []
        for (let i = 0; i < ids.length; i += 100) {
          const { data, error: err } = await supabase.from('companies').select('id, name, archived_at')
            .in('id', ids.slice(i, i + 100))
          if (err) throw new Error(`companies: ${err.message}`)
          for (const c of (data ?? []) as { id: string; name: string | null; archived_at: string | null }[]) {
            if (c.archived_at === null) companies.push({ id: c.id, name: c.name ?? '' })
          }
        }
        companies.sort((a, b) => a.name.localeCompare(b.name, 'sv'))
        return NextResponse.json({ data: companies }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (err) {
        log.error('fortnox terms backfill: listing companies failed', err as Error)
        return error(500, 'BACKFILL_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  },
  {
    method: 'POST',
    path: '/fortnox-terms-backfill',
    skipCompanyContext: true,
    handler: async (request) => {
      const started = Date.now()
      const operator = await requireOperator()
      if ('response' in operator) return operator.response
      const body = await validateBody(request, RunSchema)
      if (!body.success) return body.response
      const input = body.data
      const supabase: SupabaseClient = createServiceClientNoCookies()
      try {
        const { data: company, error: companyError } = await supabase.from('companies')
          .select('id, name, archived_at').eq('id', input.company_id).maybeSingle()
        if (companyError) throw new Error(`companies: ${companyError.message}`)
        const target = company as { id: string; name: string | null; archived_at: string | null } | null
        if (!target) return error(404, 'COMPANY_NOT_FOUND', 'No such company.')
        if (target.archived_at !== null) return error(409, 'COMPANY_ARCHIVED', 'This company is archived. Nothing written.')
        // Its cards are immutable (block_migration_reset_source_mutation).
        if (await isMigrationResetSource(supabase, target.id)) {
          return error(409, 'MIGRATION_RESET_SOURCE', 'This company was archived by a migration reset. Nothing written.')
        }

        const plan = await planFortnoxTermsBackfill(supabase, target.id,
          { from: input.from, deadline: started + READ_BUDGET_MS })
        log.info('fortnox terms backfill: read', {
          userId: operator.userId, companyId: target.id, mode: input.mode, from: input.from, fortnox: plan.fortnox,
          listed: plan.listed, candidates: plan.candidates, fills: plan.fills.length, next: plan.next,
        })
        if (input.mode === 'dry_run') {
          return NextResponse.json({ data: { name: target.name ?? '', ...report(plan) } })
        }

        const { filledIds, ...written } = await applyTermsFills(supabase, target.id, plan.fills)
        // Every card here was on 30 before, so these ids are the whole revert.
        log.info('fortnox terms backfill: written', {
          userId: operator.userId, companyId: target.id, ...written, filledIds,
        })
        return NextResponse.json({ data: { name: target.name ?? '', ...report(plan), ...written } })
      } catch (err) {
        log.error('fortnox terms backfill failed', err as Error, { companyId: input.company_id, mode: input.mode })
        return error(500, 'BACKFILL_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  },
]
