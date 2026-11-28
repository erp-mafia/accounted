/**
 * The audit log keeps the trace id of the request that wrote each row, end to
 * end over HTTP: the production client constructor (createServiceRoleClient),
 * a real supabase-js, a real PostgREST and the column default of migration
 * 20261128110000. The pg-real test (tests/pg/audit-trace-and-rule-versions.pg.test.ts)
 * sets request.headers by hand; this one proves that the header the client
 * sends inside a trace scope is the one PostgREST hands the transaction.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { insertBalancedLines, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { runWithTrace } from '@/lib/observability/trace-context-node'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { signServiceRoleJwt, TOOL_PG_REST_URL } from './client'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

/** Realtime is never used here; Node 20 has no WebSocket to resolve (see ./client.ts). */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('tool-pg: realtime is not used by these tests')
  }
}

/**
 * The service-role client the API-key and MCP doors use, built by the
 * production constructor. Only the URL is rewritten after it: a bare
 * PostgREST serves at the root, not under /rest/v1 (see ./client.ts).
 */
function serviceClient(): SupabaseClient {
  const key = signServiceRoleJwt()
  return createServiceRoleClient(TOOL_PG_REST_URL, key, {
    db: { schema: 'public' },
    realtime: { transport: UnusedRealtimeTransport as never },
    global: {
      headers: { apikey: key },
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return fetch(url.replace('/rest/v1/', '/').replace(/\/rest\/v1$/, ''), init)
      },
    },
  })
}

async function auditTraces(table: string, recordId: string, action: string): Promise<Array<string | null>> {
  const { rows } = await getPool().query<{ trace_id: string | null }>(
    `SELECT trace_id FROM public.audit_log
      WHERE table_name = $1 AND record_id = $2 AND action = $3 ORDER BY created_at, id`,
    [table, recordId, action],
  )
  return rows.map((r) => r.trace_id)
}

async function insertRule(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.categorization_templates (id, user_id, company_id, counterparty_name, debit_account, credit_account)
     VALUES ($1, $2, $3, 'telia', '6212', '1930')`,
    [id, userId, companyId],
  )
  return id
}

describe('audit trace over PostgREST (x-accounted-trace)', () => {
  it("a rule changed inside a request's scope is audited under its trace, with the rule's new version", async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)
    const supabase = serviceClient()

    await runWithTrace(TRACE, async () => {
      const { data, error } = await supabase
        .from('categorization_templates')
        .update({ debit_account: '6540' })
        .eq('id', ruleId)
        .eq('company_id', companyId)
        .select('version')
        .single()
      expect(error).toBeNull()
      expect(data).toEqual({ version: 2 })
    })

    expect(await auditTraces('categorization_templates', ruleId, 'UPDATE')).toEqual([TRACE])
  })

  it("an RPC's triggers read it too: the COMMIT of a verifikat names the request", async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId, 1250)
    const supabase = serviceClient()

    // A door binds both scopes; the trace travels beside the actor.
    await runWithTrace(TRACE, () =>
      runWithActor({ type: 'cron', label: 'bank.sync' }, async () => {
        const { error } = await supabase.rpc('commit_journal_entry', { p_company_id: companyId, p_entry_id: entryId })
        expect(error).toBeNull()
      }),
    )

    expect(await auditTraces('journal_entries', entryId, 'COMMIT')).toEqual([TRACE])
  })

  it('outside any trace scope no trace is recorded', async () => {
    const { userId, companyId } = await seedCompany()
    const ruleId = await insertRule(companyId, userId)
    const supabase = serviceClient()

    const { error } = await supabase
      .from('categorization_templates')
      .update({ debit_account: '6540' })
      .eq('id', ruleId)
      .eq('company_id', companyId)
    expect(error).toBeNull()

    expect(await auditTraces('categorization_templates', ruleId, 'UPDATE')).toEqual([null])
  })
})
