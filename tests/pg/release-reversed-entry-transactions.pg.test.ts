import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'

// release_reversed_entry_transactions(p_company_id, p_entry_id) is the storno
// helper reverseEntry (lib/bookkeeping/engine.ts) calls right after the CAS
// that marks the original entry reversed (migration
// 20260906172540_release_reversed_entry_transactions.sql, issue #2061). In one
// statement it nulls the pointer column of every transaction that pointed at
// the reversed entry and drops those transactions' transaction_voucher_links
// rows to OTHER entries: the residual booking's supplementary anchor. Links to
// the reversed entry itself are the engine's junction cleanup's business.

interface TxState {
  journal_entry_id: string | null
  is_business: boolean | null
  category: string | null
  reconciliation_method: string | null
}

async function insertLink(params: {
  userId: string
  companyId: string
  transactionId: string
  journalEntryId: string
  amount: number
  role: 'bank_line' | 'other' | 'clearing'
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links
       (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      params.userId,
      params.companyId,
      params.transactionId,
      params.journalEntryId,
      params.amount,
      params.role,
    ],
  )
  return id
}

// A residual booking as lib/reconciliation/residual.ts leaves it: the bank row
// points at the main verifikat and one 'other' link anchors the residual.
async function seedResidualBooking() {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const mainId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    voucherNumber: 1,
    lines: [
      { accountNumber: '6212', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  const residualId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    voucherNumber: 2,
    lines: [
      { accountNumber: '6570', debitAmount: 10, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 10 },
    ],
  })
  const txId = await insertTransaction({
    userId,
    companyId,
    amount: -1010,
    journalEntryId: mainId,
  })
  await getPool().query(
    `UPDATE public.transactions
        SET is_business = true, category = 'office', reconciliation_method = 'manual'
      WHERE id = $1`,
    [txId],
  )
  const otherLinkId = await insertLink({
    userId,
    companyId,
    transactionId: txId,
    journalEntryId: residualId,
    amount: -10,
    role: 'other',
  })
  return { userId, companyId, fiscalPeriodId, mainId, residualId, txId, otherLinkId }
}

async function readTx(client: PoolClient, txId: string): Promise<TxState> {
  const r = await client.query<TxState>(
    `SELECT journal_entry_id, is_business, category, reconciliation_method
       FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return r.rows[0]
}

async function countLinks(client: PoolClient, txId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.transaction_voucher_links WHERE transaction_id = $1`,
    [txId],
  )
  return Number(r.rows[0].n)
}

describe('release_reversed_entry_transactions.pg (#2061)', () => {
  it('storno of the MAIN verifikat releases the row whole: pointer reset and the residual link dropped', async () => {
    const { userId, companyId, mainId, residualId, txId } = await seedResidualBooking()

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ out: { released: number; dropped: number } }>(
        `SELECT public.release_reversed_entry_transactions($1::uuid, $2::uuid) AS out`,
        [companyId, mainId],
      )
      expect(r.rows[0].out).toEqual({ released: 1, dropped: 1 })

      expect(await readTx(client, txId)).toEqual({
        journal_entry_id: null,
        is_business: null,
        category: null,
        reconciliation_method: null,
      })
      expect(await countLinks(client, txId)).toBe(0)
      // is_transaction_booked() is the SQL twin of the readers that used to
      // disagree with the worklist: it must now say unbooked.
      const booked = await client.query<{ b: boolean }>(
        `SELECT public.is_transaction_booked($1::uuid) AS b`,
        [txId],
      )
      expect(booked.rows[0].b).toBe(false)
      // The residual verifikat is untouched: still posted, lines intact.
      const residual = await client.query<{ status: string; n: string }>(
        `SELECT je.status, (SELECT count(*)::text FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id) AS n
           FROM public.journal_entries je WHERE je.id = $1`,
        [residualId],
      )
      expect(residual.rows[0]).toEqual({ status: 'posted', n: '2' })
    })
  })

  it('storno of the RESIDUAL verifikat touches nothing: the row keeps its pointer and its link', async () => {
    const { userId, companyId, mainId, residualId, txId } = await seedResidualBooking()

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ out: { released: number; dropped: number } }>(
        `SELECT public.release_reversed_entry_transactions($1::uuid, $2::uuid) AS out`,
        [companyId, residualId],
      )
      expect(r.rows[0].out).toEqual({ released: 0, dropped: 0 })
      const tx = await readTx(client, txId)
      expect(tx.journal_entry_id).toBe(mainId)
      expect(tx.is_business).toBe(true)
      // The 'other' link to the residual is the junction cleanup's job in
      // reverseEntry, not this RPC's.
      expect(await countLinks(client, txId)).toBe(1)
    })
  })

  it('leaves a bank_line link to the reversed entry itself for the junction cleanup (bulk-book N=1 shape)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const txId = await insertTransaction({ userId, companyId, amount: 1000, journalEntryId: entryId })
    await getPool().query(`UPDATE public.transactions SET is_business = true WHERE id = $1`, [txId])
    await insertLink({ userId, companyId, transactionId: txId, journalEntryId: entryId, amount: 1000, role: 'bank_line' })

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ out: { released: number; dropped: number } }>(
        `SELECT public.release_reversed_entry_transactions($1::uuid, $2::uuid) AS out`,
        [companyId, entryId],
      )
      expect(r.rows[0].out).toEqual({ released: 1, dropped: 0 })
      expect((await readTx(client, txId)).journal_entry_id).toBeNull()
      expect(await countLinks(client, txId)).toBe(1)
    })
  })

  it('is tenant-scoped: a member of another company releases nothing', async () => {
    const { companyId, mainId, txId } = await seedResidualBooking()
    const outsider = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: otherCompany, userId: outsider, role: 'owner' })

    await withUserContext(outsider, async (client) => {
      const r = await client.query<{ out: { released: number; dropped: number } }>(
        `SELECT public.release_reversed_entry_transactions($1::uuid, $2::uuid) AS out`,
        [companyId, mainId],
      )
      expect(r.rows[0].out).toEqual({ released: 0, dropped: 0 })
      // RLS hides the row from the outsider; verify on the pool instead.
    })
    const after = await getPool().query<TxState>(
      `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(after.rows[0].journal_entry_id).toBe(mainId)
    const links = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.transaction_voucher_links WHERE transaction_id = $1`,
      [txId],
    )
    expect(Number(links.rows[0].n)).toBe(1)
  })

  it('a viewer cannot release: the writer-role gate or RLS stops the write', async () => {
    const { companyId, mainId, txId } = await seedResidualBooking()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    let threw = false
    let released = -1
    try {
      await withUserContext(viewer, async (client) => {
        const r = await client.query<{ out: { released: number; dropped: number } }>(
          `SELECT public.release_reversed_entry_transactions($1::uuid, $2::uuid) AS out`,
          [companyId, mainId],
        )
        released = r.rows[0].out.released
      })
    } catch {
      threw = true
    }
    if (!threw) expect(released).toBe(0)
    const after = await getPool().query<TxState>(
      `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(after.rows[0].journal_entry_id).toBe(mainId)
  })
})
