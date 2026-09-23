import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * RLS smoke for skattekonto_transactions. Locks in tenant isolation +
 * the (company_id, dedup_key) unique constraint that the sync UPSERT
 * relies on for idempotency, and the is_ignored CHECK (migration
 * 20260819200000): an ignored row must never carry a journal_entry_id.
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

describe('skattekonto_transactions.pg: is_ignored', () => {
  it('defaults to false and can be toggled on an unbooked row by a company member', async () => {
    const a = await seedCompany()
    const id = await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:666' })

    const before = await getPool().query<{ is_ignored: boolean }>(
      `SELECT is_ignored FROM public.skattekonto_transactions WHERE id = $1`,
      [id],
    )
    expect(before.rows[0]!.is_ignored).toBe(false)

    // The pre-existing company-scoped UPDATE policy covers the new column:
    // a member can ignore and unignore under RLS with no policy change.
    // withUserContext ALWAYS rolls back (tests/pg/setup.ts), so the write and
    // its verification must both happen inside the same transaction; reading
    // back on the pool connection afterwards would always see the pre-write
    // value and say nothing about the policy. rowCount is the actual proof:
    // an RLS-filtered UPDATE silently matches zero rows instead of raising.
    await withUserContext(a.userId, async (client) => {
      const ignored = await client.query(
        `UPDATE public.skattekonto_transactions SET is_ignored = true WHERE id = $1`,
        [id],
      )
      expect(ignored.rowCount).toBe(1)
      const mid = await client.query<{ is_ignored: boolean }>(
        `SELECT is_ignored FROM public.skattekonto_transactions WHERE id = $1`,
        [id],
      )
      expect(mid.rows[0]!.is_ignored).toBe(true)

      const unignored = await client.query(
        `UPDATE public.skattekonto_transactions SET is_ignored = false WHERE id = $1`,
        [id],
      )
      expect(unignored.rowCount).toBe(1)
      const after = await client.query<{ is_ignored: boolean }>(
        `SELECT is_ignored FROM public.skattekonto_transactions WHERE id = $1`,
        [id],
      )
      expect(after.rows[0]!.is_ignored).toBe(false)
    })
  })

  it('RLS keeps a non-member from ignoring another company\'s row', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const id = await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:999' })

    // Company B's member is scoped out by the USING clause, so the UPDATE is
    // filtered to zero rows rather than erroring: assert the row is untouched.
    await withUserContext(b.userId, async (client) => {
      const res = await client.query(
        `UPDATE public.skattekonto_transactions SET is_ignored = true WHERE id = $1`,
        [id],
      )
      expect(res.rowCount).toBe(0)
    })

    const after = await getPool().query<{ is_ignored: boolean }>(
      `SELECT is_ignored FROM public.skattekonto_transactions WHERE id = $1`,
      [id],
    )
    expect(after.rows[0]!.is_ignored).toBe(false)
  })

  it('CHECK blocks ignoring a row that has a journal_entry_id', async () => {
    const a = await seedCompany()
    const txId = await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:777' })
    const entryId = await insertDraftJournalEntry({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.skattekonto_transactions SET journal_entry_id = $1 WHERE id = $2`,
      [entryId, txId],
    )

    await expect(
      getPool().query(
        `UPDATE public.skattekonto_transactions SET is_ignored = true WHERE id = $1`,
        [txId],
      ),
    ).rejects.toThrow(/skattekonto_transactions_is_ignored_no_journal_entry|check constraint/i)
  })

  it('CHECK blocks booking (linking a journal entry to) an ignored row', async () => {
    const a = await seedCompany()
    const txId = await insertSkattekontoTransaction({ companyId: a.companyId, dedupKey: 'id:888' })
    await getPool().query(
      `UPDATE public.skattekonto_transactions SET is_ignored = true WHERE id = $1`,
      [txId],
    )
    const entryId = await insertDraftJournalEntry({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
    })

    await expect(
      getPool().query(
        `UPDATE public.skattekonto_transactions SET journal_entry_id = $1 WHERE id = $2`,
        [entryId, txId],
      ),
    ).rejects.toThrow(/skattekonto_transactions_is_ignored_no_journal_entry|check constraint/i)
  })
})
