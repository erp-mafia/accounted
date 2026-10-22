import { randomUUID } from 'crypto'
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
import {
  applyFortnoxNumberRepair,
  repairFortnoxSupplierNumbers,
  type CompanyRepairResult,
  type RepairRowResult,
} from './repair-fortnox-supplier-numbers'

/**
 * crm#1157, step 3a, run inside the deployment: the same repair as
 * scripts/repair-fortnox-supplier-invoice-numbers.ts, for when the script
 * cannot run because PERSONNUMMER_ENCRYPTION_KEY (which opens the stored
 * import payloads) exists only in Vercel. The key never leaves the deployment;
 * the route answers with the repair report: invoice numbers and counts, no
 * payload. A revert needs no payload, so it stays with the script (--revert).
 *
 * The repair spans every company with Fortnox, which no membership covers, so
 * the gate is the caller: signed in, an MFA (AAL2) session, and one of
 * OPERATOR_USER_IDS. Anyone else gets a 404, as if the route did not exist.
 * One-off: remove this file once the repair has run.
 *
 * One company per request, far under the dispatcher's 800 s ceiling (the
 * Fortnox fetch reads list pages only); the operator's browser loops:
 *
 *   GET  /api/extensions/ext/arcim-migration/fortnox-number-repair/companies
 *   POST /api/extensions/ext/arcim-migration/fortnox-number-repair
 *        { "mode": "dry_run", "company_id": "<uuid>", "stored_only": true }
 *        { "mode": "execute", "company_id": "<uuid>", "expected": <n>, "correlation_id": "<uuid>" }
 *
 * An execute makes a fresh dry run first and writes only when its count of
 * invoices to change equals `expected`, the count the operator approved from
 * the dry run, as the script's typed confirmation does. The operator is the
 * recorded actor. Pass one correlation_id to every company of a run so one
 * --revert undoes it all.
 */

/** The people who may run the repair (crm#1157). */
const OPERATOR_USER_IDS = new Set(['79b67419-5804-4718-bf49-8b2ad2b9e622'])

const log = createLogger('ext:arcim-migration:fortnox-number-repair')

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
    correlation_id: z.uuid().optional(),
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
export async function requireOperator(): Promise<{ userId: string } | { response: NextResponse }> {
  const auth = await requireAuth()
  if (auth.error) return { response: auth.error }
  if (!OPERATOR_USER_IDS.has(auth.user.id)) return { response: error(404, 'NOT_FOUND', 'Not found') }
  const { data } = await auth.supabase.auth.getClaims()
  const claims = data?.claims
  if (!claims || !claimsPinned(claims) || claims.sub !== auth.user.id || claims.aal !== 'aal2') {
    return { response: error(403, 'MFA_REQUIRED', 'Sign in with MFA (AAL2) to run the repair.') }
  }
  return { userId: auth.user.id }
}

/** Invoices a write changes: a new number or payment reference, or a stamped löpnummer. */
export function writes(rows: RepairRowResult[]): number {
  return rows.filter((r) => r.outcome === 'corrected' || r.outcome === 'reused_number' || r.stamped).length
}

/** The report without the collected records themselves (the script's --out shape). */
function report(result: CompanyRepairResult) {
  return {
    ...result,
    collection: result.collection ? { ...result.collection, records: result.collection.records.length } : null,
    writes: writes(result.rows),
  }
}

async function fortnoxCompanyIds(supabase: SupabaseClient, table: string): Promise<string[]> {
  const rows = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
    supabase.from(table).select('company_id').eq('provider', 'fortnox').order('company_id').range(from, to))
  return rows.map((r) => r.company_id)
}

export const fortnoxNumberRepairRoutes: ApiRouteDefinition[] = [
  {
    // Every company that ever connected Fortnox or ran a Fortnox import.
    method: 'GET',
    path: '/fortnox-number-repair/companies',
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
        log.error('fortnox number repair: listing companies failed', err as Error)
        return error(500, 'REPAIR_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  },
  {
    method: 'POST',
    path: '/fortnox-number-repair',
    skipCompanyContext: true,
    handler: async (request) => {
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

        const dry = await repairFortnoxSupplierNumbers(supabase, target.id,
          { dryRun: true, fetchFromFortnox: !input.stored_only })
        log.info('fortnox number repair: dry run', {
          userId: operator.userId, companyId: target.id, mode: input.mode, status: dry.status, writes: writes(dry.rows),
        })
        if (input.mode === 'dry_run') {
          return NextResponse.json({ data: { name: target.name ?? '', ...report(dry) } })
        }

        if (dry.status !== 'dry_run') {
          return error(409, 'NOT_REPAIRABLE', `Not repaired: ${dry.status}. Nothing written.`, { status: dry.status })
        }
        const count = writes(dry.rows)
        if (count !== input.expected) {
          return error(409, 'COUNT_CHANGED',
            `A fresh dry run changes ${count} invoices, not ${input.expected}. Nothing written.`, { writes: count })
        }

        // The records of the dry run above, decided again under the write's
        // lock in one transaction for this company.
        const records = dry.collection?.records ?? []
        const correlationId = input.correlation_id ?? randomUUID()
        const written = await applyFortnoxNumberRepair(supabase, target.id, records, {
          dryRun: false,
          actor: { type: 'user', id: operator.userId, label: 'arcim-migration /fortnox-number-repair (crm#1157)' },
          correlationId,
        })
        log.info('fortnox number repair: written', {
          userId: operator.userId, companyId: target.id, correlationId, counts: written.counts,
        })
        const after = await applyFortnoxNumberRepair(supabase, target.id, records, { dryRun: true })
        return NextResponse.json({
          data: {
            name: target.name ?? '',
            correlationId,
            counts: written.counts,
            rows: written.rows,
            // corrected and reused_number must be absent here.
            after: after.counts,
          },
        })
      } catch (err) {
        log.error('fortnox number repair failed', err as Error, { companyId: input.company_id, mode: input.mode })
        return error(500, 'REPAIR_FAILED', err instanceof Error ? err.message : String(err))
      }
    },
  },
]
