import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import type { PoolClient } from 'pg'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261011140000_bulk_book_transactions_commit_attribution:
 *   - the samlingsverifikat records the commit method and actor the caller
 *     passes, on journal_entries and on the audit_log COMMIT row. Before the
 *     migration the function called the two-argument commit_journal_entry,
 *     so every bulk-booked verifikat had commit_method and
 *     committed_actor_* NULL whoever booked it;
 *   - both doors: a session caller (dashboard) and a service_role caller
 *     with p_user_id (v1, MCP approval);
 *   - a caller that passes none of the three commits exactly as before.
 */

async function insertTransaction(userId: string, companyId: string, amount: number): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, '2026-06-05', 'Swish inbetalning', $4, 'SEK', 'uncategorized')`,
    [id, userId, companyId, amount],
  )
  return id
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1930', 'Bankkonto',            1, 'asset',     'debit'),
       ('2611', 'Utgående moms 25%',    2, 'liability', 'credit'),
       ('3001', 'Försäljning 25% moms', 3, 'revenue',   'credit')
     ) AS t(n, name, cls, atype, nbal)`,
    [userId, companyId],
  )
  const txIds = [
    await insertTransaction(userId, companyId, 250),
    await insertTransaction(userId, companyId, 350),
  ]
  return { userId, companyId, txIds }
}

const NEW_ENTRY = JSON.stringify({
  description: 'Dagskassa Swish',
  lines: [
    { account_number: '1930', debit_amount: 600, credit_amount: 0, currency: 'SEK' },
    { account_number: '3001', debit_amount: 0, credit_amount: 480, currency: 'SEK' },
    { account_number: '2611', debit_amount: 0, credit_amount: 120, currency: 'SEK' },
  ],
})

interface RpcResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
}

/**
 * What the verifikat and its COMMIT audit row say. Read on the caller's own
 * connection: withUserContext rolls its transaction back, so a session
 * caller's verifikat is only visible inside it (as the superuser again, so
 * audit_log RLS is not what the test measures).
 */
async function attribution(db: Pick<PoolClient, 'query'>, entryId: string) {
  await db.query('RESET ROLE')
  const entry = await db.query(
    `SELECT status, commit_method, committed_actor_type, committed_actor_label
       FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  const audit = await db.query(
    `SELECT actor_type, actor_label FROM public.audit_log
      WHERE record_id = $1 AND action = 'COMMIT'`,
    [entryId],
  )
  return { entry: entry.rows[0], audit: audit.rows }
}

describe('bulk_book_transactions: commit method and actor', () => {
  it('stamps the dashboard caller as user with bulk_accept', async () => {
    const { userId, companyId, txIds } = await seedTenant()

    const { result, stamped } = await withUserContext(userId, async (client) => {
      const r = await client.query<{ result: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], NULL, $2::jsonb, $3, NULL, 'bulk_accept', 'user', NULL) AS result`,
        [txIds, NEW_ENTRY, companyId],
      )
      const result = r.rows[0]!.result
      return { result, stamped: result.ok ? await attribution(client, result.journal_entry_id!) : null }
    })

    expect(result.ok).toBe(true)
    expect(stamped).toEqual({
      entry: {
        status: 'posted',
        commit_method: 'bulk_accept',
        committed_actor_type: 'user',
        committed_actor_label: null,
      },
      audit: [{ actor_type: 'user', actor_label: null }],
    })
  })

  it('stamps an API key relayed through the service role with its label', async () => {
    const { userId, companyId, txIds } = await seedTenant()

    const result = await runAsServiceRole(async (client) => {
      const r = await client.query<{ result: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], NULL, $2::jsonb, $3, $4, 'api_key', 'mcp_oauth', 'MCP-klient (OAuth)') AS result`,
        [txIds, NEW_ENTRY, companyId, userId],
      )
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(true)
    expect(await attribution(getPool(), result.journal_entry_id!)).toEqual({
      entry: {
        status: 'posted',
        commit_method: 'api_key',
        committed_actor_type: 'mcp_oauth',
        committed_actor_label: 'MCP-klient (OAuth)',
      },
      audit: [{ actor_type: 'mcp_oauth', actor_label: 'MCP-klient (OAuth)' }],
    })
  })

  it('commits as before when the caller passes none of the three', async () => {
    const { userId, companyId, txIds } = await seedTenant()

    const { result, stamped } = await withUserContext(userId, async (client) => {
      const r = await client.query<{ result: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], NULL, $2::jsonb, $3) AS result`,
        [txIds, NEW_ENTRY, companyId],
      )
      const result = r.rows[0]!.result
      return { result, stamped: result.ok ? await attribution(client, result.journal_entry_id!) : null }
    })

    expect(result.ok).toBe(true)
    expect(stamped?.entry).toEqual({
      status: 'posted',
      commit_method: null,
      committed_actor_type: null,
      committed_actor_label: null,
    })
  })

  it('refuses a commit method outside the CHECK list', async () => {
    const { userId, companyId, txIds } = await seedTenant()

    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `SELECT bulk_book_transactions($1::uuid[], NULL, $2::jsonb, $3, NULL, 'made_up', 'user', NULL)`,
          [txIds, NEW_ENTRY, companyId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
