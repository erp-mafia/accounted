import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertTransaction } from './fixtures'

// transaction_assistant_reads (20260910120000): one row per transaction,
// company-scoped RLS on all four verbs via user_company_ids(), the
// confidence CHECK [0,1], and the row dies with its transaction.

type Client = { query: (q: string, p: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }

async function insertRead(client: Client, companyId: string, transactionId: string, confidence = 0.8) {
  return client.query(
    `INSERT INTO public.transaction_assistant_reads
       (company_id, transaction_id, account, confidence, reasoning)
     VALUES ($1, $2, '5410', $3, 'first read')
     ON CONFLICT (transaction_id) DO UPDATE
       SET account = EXCLUDED.account, confidence = EXCLUDED.confidence, reasoning = EXCLUDED.reasoning
     RETURNING id, reasoning`,
    [companyId, transactionId, confidence],
  )
}

describe('transaction_assistant_reads', () => {
  it('lets a member write and read the reads of their own company', async () => {
    const { userId, companyId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId })
    await withUserContext(userId, async (client) => {
      await insertRead(client, companyId, txId)
      const { rows } = await client.query(
        `SELECT account, has_underlag FROM public.transaction_assistant_reads WHERE transaction_id = $1`,
        [txId],
      )
      expect(rows).toEqual([{ account: '5410', has_underlag: false }])
    })
  })

  it('keeps one row per transaction: a second read replaces the first', async () => {
    const { userId, companyId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId })
    await withUserContext(userId, async (client) => {
      const first = await insertRead(client, companyId, txId, 0.4)
      const second = await insertRead(client, companyId, txId, 0.9)
      expect((second.rows[0] as { id: string }).id).toBe((first.rows[0] as { id: string }).id)
      const { rows } = await client.query(
        `SELECT confidence::text AS confidence FROM public.transaction_assistant_reads WHERE transaction_id = $1`,
        [txId],
      )
      expect(rows).toEqual([{ confidence: '0.9' }])
    })
  })

  it('hides another company reads (RLS SELECT)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const txId = await insertTransaction({ companyId: a.companyId, userId: a.userId })
    await insertRead({ query: (q, p) => getPool().query(q, p) }, a.companyId, txId)
    await withUserContext(b.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.transaction_assistant_reads WHERE transaction_id = $1`,
        [txId],
      )
      expect(rows.length).toBe(0)
    })
  })

  it('refuses a read written into another company (RLS WITH CHECK)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const txId = await insertTransaction({ companyId: b.companyId, userId: b.userId })
    await withUserContext(a.userId, async (client) => {
      await expect(insertRead(client, b.companyId, txId)).rejects.toThrow()
    })
  })

  it('enforces the confidence CHECK [0,1]', async () => {
    const { userId, companyId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId })
    await expect(
      insertRead({ query: (q, p) => getPool().query(q, p) }, companyId, txId, 1.5),
    ).rejects.toThrow()
  })

  it('dies with its transaction', async () => {
    const { userId, companyId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId })
    await insertRead({ query: (q, p) => getPool().query(q, p) }, companyId, txId)
    await getPool().query(`DELETE FROM public.transactions WHERE id = $1`, [txId])
    const { rows } = await getPool().query(
      `SELECT id FROM public.transaction_assistant_reads WHERE transaction_id = $1`,
      [txId],
    )
    expect(rows.length).toBe(0)
  })
})
