import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260824170000_bulk_book_transactions_service_actor:
 *   - service_role caller + p_user_id of a member: the samlingsverifikat
 *     commits. This is the pending-operations commit path
 *     (createServiceClientNoCookies), which before the migration ALWAYS got
 *     BULK_BOOK_UNAUTHORIZED because auth.uid() is NULL on the service
 *     client, and the dispatcher then consumed the op (feedback seq 261545).
 *   - p_user_id is an assertion, honored ONLY under auth.role() =
 *     'service_role': an authenticated non-member spoofing an owner's UUID
 *     and a caller with no JWT at all both stay BULK_BOOK_UNAUTHORIZED.
 *   - Grants: PUBLIC/anon revoked, authenticated + service_role kept; the
 *     old 4-arg signature is gone (the 5th arg has a DEFAULT, so 4-arg call
 *     sites still resolve).
 */

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, '2026-06-05', 'Swish inbetalning', $4, 'SEK', 'uncategorized')`,
    [id, params.userId, params.companyId, params.amount],
  )
  return id
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  // The RPC validates every line's account_number against the company's
  // active chart; seed only the accounts the entry touches.
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
  const tx1 = await insertTransaction({ userId, companyId, amount: 250 })
  const tx2 = await insertTransaction({ userId, companyId, amount: 350 })
  return { userId, companyId, txIds: [tx1, tx2] }
}

const NEW_ENTRY = {
  description: 'Dagskassa Swish',
  lines: [
    { account_number: '1930', debit_amount: 600, credit_amount: 0, currency: 'SEK', line_description: 'Inbetalningar Swish' },
    { account_number: '3001', debit_amount: 0, credit_amount: 480, currency: 'SEK', line_description: 'Försäljning' },
    { account_number: '2611', debit_amount: 0, credit_amount: 120, currency: 'SEK', line_description: 'Utgående moms 25%' },
  ],
}

interface RpcResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
  linked_tx_count?: number
}

const CALL = `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4, $5) AS result`

describe('bulk_book_transactions service actor', () => {
  it('commits for a service_role caller with p_user_id of a member and attributes the verifikat to that user', async () => {
    const { userId, companyId, txIds } = await seedTenant()

    const result = await runAsServiceRole(async (client) => {
      const r = await client.query<{ result: RpcResult }>(CALL, [
        txIds,
        null,
        JSON.stringify(NEW_ENTRY),
        companyId,
        userId,
      ])
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(true)
    expect(result.journal_entry_id).toBeTruthy()
    expect(result.linked_tx_count).toBe(2)

    const je = await getPool().query<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM public.journal_entries WHERE id = $1`,
      [result.journal_entry_id],
    )
    expect(je.rows[0]!.user_id).toBe(userId)
    expect(je.rows[0]!.status).toBe('posted')
  })

  it('still rejects a service_role caller that passes no p_user_id', async () => {
    const { companyId, txIds } = await seedTenant()

    const result = await runAsServiceRole(async (client) => {
      const r = await client.query<{ result: RpcResult }>(CALL, [
        txIds,
        null,
        JSON.stringify(NEW_ENTRY),
        companyId,
        null,
      ])
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('BULK_BOOK_UNAUTHORIZED')
  })

  it('ignores a spoofed p_user_id from an authenticated non-member', async () => {
    const { userId, companyId, txIds } = await seedTenant()
    const stranger = await insertAuthUser()

    const result = await withUserContext(stranger, async (client) => {
      const r = await client.query<{ result: RpcResult }>(CALL, [
        txIds,
        null,
        JSON.stringify(NEW_ENTRY),
        companyId,
        userId,
      ])
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('BULK_BOOK_UNAUTHORIZED')
  })

  it('ignores p_user_id when there is no JWT context at all', async () => {
    const { userId, companyId, txIds } = await seedTenant()

    const r = await getPool().query<{ result: RpcResult }>(CALL, [
      txIds,
      null,
      JSON.stringify(NEW_ENTRY),
      companyId,
      userId,
    ])
    expect(r.rows[0]!.result.ok).toBe(false)
    expect(r.rows[0]!.result.code).toBe('BULK_BOOK_UNAUTHORIZED')
  })

  it('keeps the 4-arg call shape working for authenticated members (web route)', async () => {
    const { userId, companyId, txIds } = await seedTenant()

    const result = await withUserContext(userId, async (client) => {
      const r = await client.query<{ result: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4) AS result`,
        [txIds, null, JSON.stringify(NEW_ENTRY), companyId],
      )
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(true)
  })

  it('keeps least-privilege grants and drops the 4-arg overload', async () => {
    const { rows } = await getPool().query<{
      anon_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
      overloads: string
    }>(
      `SELECT has_function_privilege('anon', 'public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)', 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', 'public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)', 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', 'public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)', 'EXECUTE') AS service_role_can,
              (SELECT count(*) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'bulk_book_transactions')::text AS overloads`,
    )
    expect(rows[0]!.anon_can).toBe(false)
    expect(rows[0]!.authenticated_can).toBe(true)
    expect(rows[0]!.service_role_can).toBe(true)
    expect(rows[0]!.overloads).toBe('1')
  })
})
