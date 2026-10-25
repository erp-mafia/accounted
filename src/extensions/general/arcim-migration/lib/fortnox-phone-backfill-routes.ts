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
import { applyPhoneFills, planFortnoxPhoneBackfill, type PhoneBackfillPlan } from './backfill-fortnox-phones'
import { isMigrationResetSource } from './repair-fortnox-supplier-numbers'

/**
 * crm#1436, run inside the deployment: fills in the phone numbers Fortnox
 * imports left out (backfill-fortnox-phones). Inside, because the stored
 * import payloads open only with PERSONNUMMER_ENCRYPTION_KEY, which exists
 * only in Vercel (decision 2026-10-22, crm#1157). The route answers with
 * counts, never a phone number or a payload.
 *
 * The backfill spans every company with Fortnox, which no membership covers,
 * so the gate is the caller: signed in, an MFA (AAL2) session, and one of
 * OPERATOR_USER_IDS. Anyone else gets a 404, as if the route did not exist.
 * One-off: remove this file once the backfill has run.
 *
 * One company per request; the operator's browser loops:
 *
 *   GET  /api/extensions/ext/arcim-migration/fortnox-phone-backfill/companies
 *   POST /api/extensions/ext/arcim-migration/fortnox-phone-backfill
 *        { "mode": "dry_run", "company_id": "<uuid>" }
 *        { "mode": "execute", "company_id": "<uuid>", "expected": <n> }
 *
 * An execute makes a fresh dry run first and writes only when its count of
 * cards to fill equals `expected`, the count the operator approved. A run
 * that reaches the time budget reports `remaining`; a new dry run and execute
 * pick those up, since a filled card is no longer a candidate.
 */

/** The people who may run the backfill (crm#1436). */
const OPERATOR_USER_IDS = new Set(['79b67419-5804-4718-bf49-8b2ad2b9e622'])

/** Under the dispatcher's 800 s ceiling with room to answer. */
const RUN_BUDGET_MS = 600_000

const log = createLogger('ext:arcim-migration:fortnox-phone-backfill')

const RunSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('dry_run'),
    company_id: z.uuid(),
    stored_only: z.boolean().default(false),
  }).strict(),
  z.object({
    mode: z.literal('execute'),
    company_id: z.uuid(),
    stored_only: z.boolean().default(false),
    expected: z.number().int().positive(),
  }).strict(),
])

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status })
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

/** The plan without the fills themselves: they hold the phone numbers. */
function report({ fills, ...plan }: PhoneBackfillPlan) {
  return { ...plan, fills: fills.length }
}

async function fortnoxCompanyIds(supabase: SupabaseClient, table: string): Promise<string[]> {
  const rows = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
    supabase.from(table).select('company_id').eq('provider', 'fortnox').order('company_id').range(from, to))
  return rows.map((r) => r.company_id)
}

export const fortnoxPhoneBackfillRoutes: ApiRouteDefinition[] = [
  {
    // Every company that ever connected Fortnox or ran a Fortnox import.
    method: 'GET',
    path: '/fortnox-phone-backfill/companies',
    skipCompanyContext: true,
    handler: async () => {
      const operator = await requireOperator()
      if ('response' in operator) return operator.response
      try {
        const supabase = createServiceClientNoCookies()
        const ids = [...new Set([
          ...(await fortnoxCompanyIds(supabase, 'provider_consents')),
          ...(await fortnoxCompanyIds(supabase, 'migration_jobs')),
        ])]
        const companies: { id: string; name: string; archived: boolean }[] = []
        for (let i = 0; i < ids.length; i += 100) {
          const { data, error: err } = await supabase.from('companies').select('id, name, archived_at')
            .in('id', ids.slice(i, i + 100))
          if (err) throw new Error(`companies: ${err.message}`)
          for (const c of (data ?? []) as { id: string; name: string | null; archived_at: string | null }[]) {
            companies.push({ id: c.id, name: c.name ?? '', archived: c.archived_at !== null })
          }
        }
        companies.sort((a, b) => a.name.localeCompare(b.name, 'sv'))
        return NextResponse.json({ data: companies }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (err) {
        log.error('fortnox phone backfill: listing companies failed', err as Error)
        return error(500, 'BACKFILL_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  },
  {
    method: 'POST',
    path: '/fortnox-phone-backfill',
    skipCompanyContext: true,
    handler: async (request) => {
      const started = Date.now()
      const operator = await requireOperator()
      if ('response' in operator) return operator.response
      const body = await validateBody(request, RunSchema)
      if (!body.success) return body.response
      const input = body.data
      const supabase = createServiceClientNoCookies()
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

        const plan = await planFortnoxPhoneBackfill(supabase, target.id, { fetchFromFortnox: !input.stored_only })
        log.info('fortnox phone backfill: dry run', {
          userId: operator.userId, companyId: target.id, mode: input.mode, fortnox: plan.fortnox,
          stored: plan.stored, fetched: plan.fetched, fills: plan.fills.length,
        })
        if (input.mode === 'dry_run') {
          return NextResponse.json({ data: { name: target.name ?? '', ...report(plan) } })
        }

        if (plan.fills.length !== input.expected) {
          return error(409, 'COUNT_CHANGED',
            `A fresh dry run fills ${plan.fills.length} cards, not ${input.expected}. Nothing written.`,
            { fills: plan.fills.length })
        }
        const written = await applyPhoneFills(supabase, target.id, plan.fills, { deadline: started + RUN_BUDGET_MS })
        log.info('fortnox phone backfill: written', { userId: operator.userId, companyId: target.id, ...written })
        return NextResponse.json({ data: { name: target.name ?? '', ...written } })
      } catch (err) {
        log.error('fortnox phone backfill failed', err as Error, { companyId: input.company_id, mode: input.mode })
        return error(500, 'BACKFILL_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  },
]
