import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * RLS smoke for skattekonto_transactions. Locks in tenant isolation +
 * the (company_id, dedup_key) unique constraint that the sync UPSERT
 * relies on for idempotency.
 */

async function insertSkattekontoTransaction(params: {
  companyId: string
  dedupKey?: string
  date?: string
  amount?: number
  status?: 'booked' | 'upcoming'
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skattekonto_transactions
       (id, company_id, dedup_key, transaktionsdatum, transaktionstext,
        belopp_skatteverket, status)
     VALUES ($1, $2, $3, $4, 'Test transaction', $5, $6)`,
    [
      id,
      params.companyId,
      params.dedupKey ?? `id:${Math.floor(Math.random() * 1_000_000)}`,
      params.date ?? '2026-04-15',
      params.amount ?? -1000,
      params.status ?? 'booked',
    ],
  )
  return id
}

describe('skattekonto_transactions.pg: RLS tenant isolation', () => {
  it('a user only sees rows for their own company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:111' })
    await insertSkattekontoTransaction({ companyId: b.companyId, dedupKey: 'id:222' })

    const rows = await withUserContext(a.userId, async (client) => {
      const res = await client.query<{ company_id: string; dedup_key: string }>(
        `SELECT company_id, dedup_key FROM public.skattekonto_transactions`,
      )
      return res.rows
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.company_id).toBe(a.companyId)
    expect(rows[0]!.dedup_key).toBe('id:111')
  })

  it('UPDATE WITH CHECK blocks moving a row to another tenant', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:333' })

    // User A authenticates, then tries to set company_id to B's id.
    // Must fail under WITH CHECK on UPDATE.
    await expect(
      withUserContext(a.userId, async (client) => {
        return client.query(
          `UPDATE public.skattekonto_transactions
             SET company_id = $1
           WHERE dedup_key = 'id:333'`,
          [b.companyId],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('enforces unique (company_id, dedup_key) for UPSERT idempotency', async () => {
    const a = await seedCompany()
    await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:444' })
    await expect(
      insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:444' }),
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('allows the same dedup_key in a different tenant', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:555' })
    // Different tenant, same dedup_key: should succeed.
    await expect(
      insertSkattekontoTransaction({ companyId: b.companyId, dedupKey: 'id:555' }),
    ).resolves.toBeDefined()
  })
})
