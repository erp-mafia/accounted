import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'

// correctEntry (lib/core/bookkeeping/storno-service.ts, relinkTransactionsToEntry)
// re-points BOTH anchors of a bank row from the reversed original to the
// posted correction: the pointer column (transactions.journal_entry_id) and
// the transaction_voucher_links junction (#2364). These tests run the exact
// two UPDATE statements the service issues, as the correcting user, against
// real Postgres: the junction move must not be blocked by RLS, the
// aa_enforce_company_writer_role gate or the immutability triggers (which
// guard journal_entries and document_attachments, not the junction), and
// role + allocated_amount must survive the move.

const POINTER_RELINK = `
  UPDATE public.transactions
     SET journal_entry_id = $3
   WHERE company_id = $1 AND journal_entry_id = $2`

const JUNCTION_RELINK = `
  UPDATE public.transaction_voucher_links
     SET journal_entry_id = $3
   WHERE company_id = $1 AND journal_entry_id = $2`

interface LinkRow {
  journal_entry_id: string
  role: string
  allocated_amount: string
}

async function insertLink(params: {
  userId: string
  companyId: string
  transactionId: string
  journalEntryId: string
  amount: number
  role?: 'bank_line' | 'other' | 'clearing'
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
      params.role ?? 'bank_line',
    ],
  )
  return id
}

async function insertEntryAtStatus(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  status?: 'posted' | 'reversed'
  correctionOfId?: string
}): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
  })
  await insertBalancedLines(entryId)
  if (params.correctionOfId) {
    await getPool().query(
      `UPDATE public.journal_entries SET correction_of_id = $2 WHERE id = $1`,
      [entryId, params.correctionOfId],
    )
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  if (params.status === 'reversed') {
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [
      entryId,
    ])
  }
  return entryId
}

/** A reversed original + its posted correction, mirroring correctEntry()'s end state before the relink. */
async function seedCorrectionPair(seed: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<{ originalId: string; correctionId: string }> {
  const originalId = await insertEntryAtStatus({ ...seed, voucherNumber: 1, status: 'reversed' })
  const correctionId = await insertEntryAtStatus({ ...seed, voucherNumber: 2, correctionOfId: originalId })
  return { originalId, correctionId }
}

async function linksOf(client: PoolClient, txId: string): Promise<LinkRow[]> {
  const r = await client.query<LinkRow>(
    `SELECT journal_entry_id, role, allocated_amount::text AS allocated_amount
       FROM public.transaction_voucher_links WHERE transaction_id = $1 ORDER BY journal_entry_id`,
    [txId],
  )
  return r.rows
}

async function isBooked(client: PoolClient, txId: string): Promise<boolean> {
  const r = await client.query<{ b: boolean }>(`SELECT public.is_transaction_booked($1::uuid) AS b`, [
    txId,
  ])
  return r.rows[0]!.b
}

async function relinkAsUser(
  client: PoolClient,
  companyId: string,
  fromId: string,
  toId: string,
): Promise<{ pointer: number; junction: number }> {
  const pointer = await client.query(POINTER_RELINK, [companyId, fromId, toId])
  const junction = await client.query(JUNCTION_RELINK, [companyId, fromId, toId])
  return { pointer: pointer.rowCount ?? 0, junction: junction.rowCount ?? 0 }
}

describe('correction-junction-relink.pg (#2364)', () => {
  it('bulk-book N=1 shape: pointer and bank_line link both move to the correction, role and amount intact', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)
    const txId = await insertTransaction({
      userId: seed.userId,
      companyId: seed.companyId,
      amount: -1000,
      journalEntryId: originalId,
    })
    await insertLink({
      userId: seed.userId,
      companyId: seed.companyId,
      transactionId: txId,
      journalEntryId: originalId,
      amount: -1000,
    })

    await withUserContext(seed.userId, async (client) => {
      expect(await relinkAsUser(client, seed.companyId, originalId, correctionId)).toEqual({
        pointer: 1,
        junction: 1,
      })
      const tx = await client.query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
        [txId],
      )
      expect(tx.rows[0]!.journal_entry_id).toBe(correctionId)
      expect(await linksOf(client, txId)).toEqual([
        { journal_entry_id: correctionId, role: 'bank_line', allocated_amount: '-1000.00' },
      ])
      expect(await isBooked(client, txId)).toBe(true)
      // Nothing is left anchored to the reversed original.
      const stale = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.transaction_voucher_links WHERE journal_entry_id = $1`,
        [originalId],
      )
      expect(stale.rows[0]!.n).toBe('0')
    })
  })

  it('samlingsverifikat (N>1, pointer NULL): the junction is the only anchor and follows the correction', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)
    const txA = await insertTransaction({ userId: seed.userId, companyId: seed.companyId, amount: -600 })
    const txB = await insertTransaction({ userId: seed.userId, companyId: seed.companyId, amount: -400 })
    for (const [txId, amount] of [
      [txA, -600],
      [txB, -400],
    ] as const) {
      await insertLink({
        userId: seed.userId,
        companyId: seed.companyId,
        transactionId: txId,
        journalEntryId: originalId,
        amount,
      })
    }

    await withUserContext(seed.userId, async (client) => {
      expect(await relinkAsUser(client, seed.companyId, originalId, correctionId)).toEqual({
        pointer: 0,
        junction: 2,
      })
      expect(await linksOf(client, txA)).toEqual([
        { journal_entry_id: correctionId, role: 'bank_line', allocated_amount: '-600.00' },
      ])
      expect(await linksOf(client, txB)).toEqual([
        { journal_entry_id: correctionId, role: 'bank_line', allocated_amount: '-400.00' },
      ])
      // Both rows still read as booked: deleting the links (the issue's
      // proposal) would have pushed them back into Att bokföra.
      expect(await isBooked(client, txA)).toBe(true)
      expect(await isBooked(client, txB)).toBe(true)
    })
  })

  it('1:N split and residual shapes: only the slice on the corrected entry moves, other anchors are untouched', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)
    const otherId = await insertEntryAtStatus({ ...seed, voucherNumber: 3 })
    const txId = await insertTransaction({ userId: seed.userId, companyId: seed.companyId, amount: -1010 })
    await insertLink({
      userId: seed.userId,
      companyId: seed.companyId,
      transactionId: txId,
      journalEntryId: originalId,
      amount: -1000,
    })
    await insertLink({
      userId: seed.userId,
      companyId: seed.companyId,
      transactionId: txId,
      journalEntryId: otherId,
      amount: -10,
      role: 'other',
    })

    await withUserContext(seed.userId, async (client) => {
      expect(await relinkAsUser(client, seed.companyId, originalId, correctionId)).toEqual({
        pointer: 0,
        junction: 1,
      })
      const rows = await linksOf(client, txId)
      expect(rows).toHaveLength(2)
      expect(rows).toContainEqual({
        journal_entry_id: correctionId,
        role: 'bank_line',
        allocated_amount: '-1000.00',
      })
      expect(rows).toContainEqual({ journal_entry_id: otherId, role: 'other', allocated_amount: '-10.00' })
    })
  })

  it('is tenant-scoped: a member of another company moves nothing', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)
    const txId = await insertTransaction({
      userId: seed.userId,
      companyId: seed.companyId,
      amount: -1000,
      journalEntryId: originalId,
    })
    await insertLink({
      userId: seed.userId,
      companyId: seed.companyId,
      transactionId: txId,
      journalEntryId: originalId,
      amount: -1000,
    })
    const outsider = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: otherCompany, userId: outsider, role: 'owner' })

    await withUserContext(outsider, async (client) => {
      expect(await relinkAsUser(client, seed.companyId, originalId, correctionId)).toEqual({
        pointer: 0,
        junction: 0,
      })
    })
    await withUserContext(seed.userId, async (client) => {
      expect(await linksOf(client, txId)).toEqual([
        { journal_entry_id: originalId, role: 'bank_line', allocated_amount: '-1000.00' },
      ])
    })
  })
})
