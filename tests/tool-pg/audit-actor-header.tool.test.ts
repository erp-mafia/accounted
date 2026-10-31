/**
 * The audit log names the person a service-role write was made for, end to
 * end over HTTP: the production client constructor (createServiceRoleClient),
 * a real supabase-js, a real PostgREST and the audit triggers of migration
 * 20261031120000. The pg-real test (tests/pg/audit-actor-from-request.pg.test.ts)
 * sets request.headers by hand; this one proves that the header the client
 * sends inside an actor scope is the one PostgREST hands the transaction.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { signServiceRoleJwt, TOOL_PG_REST_URL } from './client'

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

interface AuditActor {
  user_id: string | null
  actor_type: string | null
  actor_label: string | null
}

async function auditActors(table: string, recordId: string, action: string): Promise<AuditActor[]> {
  const { rows } = await getPool().query<AuditActor>(
    `SELECT user_id, actor_type, actor_label FROM public.audit_log
      WHERE table_name = $1 AND record_id = $2 AND action = $3 ORDER BY created_at, id`,
    [table, recordId, action],
  )
  return rows
}

async function companyWithSettings(): Promise<{ creatorId: string; adminId: string; companyId: string; settingsId: string }> {
  const creatorId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: creatorId })
  await insertCompanyMember({ companyId, userId: creatorId, role: 'owner' })
  const adminId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2) RETURNING id`,
    [creatorId, companyId],
  )
  return { creatorId, adminId, companyId, settingsId: rows[0]!.id }
}

describe('audit actor over PostgREST (x-accounted-actor)', () => {
  it("an MCP connector's update for an admin who did not create the row names the admin and the connector", async () => {
    const { creatorId, adminId, companyId, settingsId } = await companyWithSettings()
    const supabase = serviceClient()

    await runWithActor({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: adminId }, async () => {
      const { error } = await supabase
        .from('company_settings')
        .update({ bookkeeping_locked_through: '2026-03-31' })
        .eq('company_id', companyId)
      expect(error).toBeNull()
    })

    expect(await auditActors('company_settings', settingsId, 'UPDATE')).toEqual([
      { user_id: adminId, actor_type: 'mcp_oauth', actor_label: 'Claude (Anthropic)' },
    ])
    expect(adminId).not.toBe(creatorId)
  })

  it("an API key's delete keeps a Swedish key name intact through the header", async () => {
    const { creatorId, adminId, companyId } = await companyWithSettings()
    const supplierId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Leverantör AB')`,
      [supplierId, creatorId, companyId],
    )
    const supabase = serviceClient()

    await runWithActor({ type: 'api_key', label: 'Lagerskript åt Åsa', userId: adminId }, async () => {
      const { error } = await supabase.from('suppliers').delete().eq('id', supplierId).eq('company_id', companyId)
      expect(error).toBeNull()
    })

    expect(await auditActors('suppliers', supplierId, 'DELETE')).toEqual([
      { user_id: adminId, actor_type: 'api_key', actor_label: 'Lagerskript åt Åsa' },
    ])
  })

  it("an RPC's triggers read it too: the COMMIT of a colleague's draft names the member", async () => {
    const { userId: creatorId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: creatorId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId, 1250)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const supabase = serviceClient()

    await runWithActor({ type: 'service_account', label: 'Nattlig synk', userId: memberId }, async () => {
      const { error } = await supabase.rpc('commit_journal_entry', { p_company_id: companyId, p_entry_id: entryId })
      expect(error).toBeNull()
    })

    expect(await auditActors('journal_entries', entryId, 'COMMIT')).toEqual([
      { user_id: memberId, actor_type: 'service_account', actor_label: 'Nattlig synk' },
    ])
  })

  it('outside any actor scope nothing is named and the row user_id stands in, as before', async () => {
    const { creatorId, companyId, settingsId } = await companyWithSettings()
    const supabase = serviceClient()

    const { error } = await supabase
      .from('company_settings')
      .update({ bookkeeping_locked_through: '2026-06-30' })
      .eq('company_id', companyId)
    expect(error).toBeNull()

    expect(await auditActors('company_settings', settingsId, 'UPDATE')).toEqual([
      { user_id: creatorId, actor_type: 'user', actor_label: null },
    ])
  })
})
