import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertBalancedLines, insertTransaction, seedCompany } from '@/tests/pg/fixtures'

// delete_last_voucher (migration 20260908095907, issue #2364): deleting a
// correction returns the bank anchors correctEntry moved onto it (the pointer
// transactions.journal_entry_id and the transaction_voucher_links rows) to the
// corrected original, so the two-step undo (delete the correction, then the
// storno, which restores the original to posted) leaves the original
// explaining its bank rows instead of stranding them as bookable.

async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  sourceType?: string
  reversesId?: string
  correctionOfId?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status, reverses_id, correction_of_id)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Test entry', $6, 'draft', $7, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber,
      params.sourceType ?? 'manual',
      params.reversesId ?? null,
      params.correctionOfId ?? null,
    ],
  )
  await insertBalancedLines(id)
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  return id
}

async function insertLink(params: {
  userId: string
  companyId: string
  transactionId: string
  journalEntryId: string
  amount: number
  role?: 'bank_line' | 'other' | 'clearing'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links
       (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      params.userId,
      params.companyId,
      params.transactionId,
      params.journalEntryId,
      params.amount,
      params.role ?? 'bank_line',
    ],
  )
}

/**
 * The end state of correctEntry: original A1 reversed by storno A2, correction
 * A3 posted with correction_of_id = A1. The bank anchors sit on A3.
 */
async function seedCorrectedEntry() {
  const seed = await seedCompany()
  const originalId = await insertPostedEntry({ ...seed, voucherNumber: 1 })
  const stornoId = await insertPostedEntry({
    ...seed,
    voucherNumber: 2,
    sourceType: 'storno',
    reversesId: originalId,
  })
  const correctionId = await insertPostedEntry({
    ...seed,
    voucherNumber: 3,
    sourceType: 'correction',
    correctionOfId: originalId,
  })
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $1 WHERE id = $2`,
    [stornoId, originalId],
  )
  return { ...seed, originalId, stornoId, correctionId }
}

interface LinkRow {
  journal_entry_id: string
  role: string
  allocated_amount: string
}

async function linksOf(client: PoolClient, txId: string): Promise<LinkRow[]> {
  const r = await client.query<LinkRow>(
    `SELECT journal_entry_id, role, allocated_amount::text AS allocated_amount
       FROM public.transaction_voucher_links WHERE transaction_id = $1 ORDER BY journal_entry_id`,
    [txId],
  )
  return r.rows
}

async function pointerOf(client: PoolClient, txId: string): Promise<string | null> {
  const r = await client.query<{ journal_entry_id: string | null }>(
    `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return r.rows[0]!.journal_entry_id
}

async function isBooked(client: PoolClient, txId: string): Promise<boolean> {
  const r = await client.query<{ b: boolean }>(`SELECT public.is_transaction_booked($1::uuid) AS b`, [
    txId,
  ])
  return r.rows[0]!.b
}

async function deleteVoucher(client: PoolClient, companyId: string, entryId: string): Promise<void> {
  await client.query(`SELECT public.delete_last_voucher($1::uuid, $2::uuid)`, [companyId, entryId])
}

describe('delete_last_voucher returns bank anchors to the corrected original (#2364)', () => {
  it('bulk-book N=1 shape: pointer and link go back to the original; deleting the storno then leaves the row booked against it', async () => {
    const s = await seedCorrectedEntry()
    const txId = await insertTransaction({
      userId: s.userId,
      companyId: s.companyId,
      amount: -1000,
      journalEntryId: s.correctionId,
    })
    await getPool().query(`UPDATE public.transactions SET is_business = true WHERE id = $1`, [txId])
    await insertLink({
      userId: s.userId,
      companyId: s.companyId,
      transactionId: txId,
      journalEntryId: s.correctionId,
      amount: -1000,
    })

    await withUserContext(s.userId, async (client) => {
      await deleteVoucher(client, s.companyId, s.correctionId)
      expect(await pointerOf(client, txId)).toBe(s.originalId)
      expect(await linksOf(client, txId)).toEqual([
        { journal_entry_id: s.originalId, role: 'bank_line', allocated_amount: '-1000.00' },
      ])

      await deleteVoucher(client, s.companyId, s.stornoId)
      const original = await client.query<{ status: string }>(
        `SELECT status FROM public.journal_entries WHERE id = $1`,
        [s.originalId],
      )
      expect(original.rows[0]!.status).toBe('posted')
      expect(await isBooked(client, txId)).toBe(true)
    })
  })

  it('samlingsverifikat (N>1, pointer NULL): every link goes back to the original', async () => {
    const s = await seedCorrectedEntry()
    const txA = await insertTransaction({ userId: s.userId, companyId: s.companyId, amount: -600 })
    const txB = await insertTransaction({ userId: s.userId, companyId: s.companyId, amount: -400 })
    for (const [txId, amount] of [
      [txA, -600],
      [txB, -400],
    ] as const) {
      await insertLink({
        userId: s.userId,
        companyId: s.companyId,
        transactionId: txId,
        journalEntryId: s.correctionId,
        amount,
      })
    }

    await withUserContext(s.userId, async (client) => {
      await deleteVoucher(client, s.companyId, s.correctionId)
      expect(await linksOf(client, txA)).toEqual([
        { journal_entry_id: s.originalId, role: 'bank_line', allocated_amount: '-600.00' },
      ])
      expect(await linksOf(client, txB)).toEqual([
        { journal_entry_id: s.originalId, role: 'bank_line', allocated_amount: '-400.00' },
      ])
      expect(await pointerOf(client, txA)).toBeNull()
      expect(await isBooked(client, txA)).toBe(true)
      expect(await isBooked(client, txB)).toBe(true)
    })
  })

  it('a link the original already holds (correction made before the junction followed it) is not duplicated', async () => {
    const s = await seedCorrectedEntry()
    const txId = await insertTransaction({ userId: s.userId, companyId: s.companyId, amount: -1000 })
    await insertLink({
      userId: s.userId,
      companyId: s.companyId,
      transactionId: txId,
      journalEntryId: s.originalId,
      amount: -1000,
    })
    await insertLink({
      userId: s.userId,
      companyId: s.companyId,
      transactionId: txId,
      journalEntryId: s.correctionId,
      amount: -1000,
    })

    await withUserContext(s.userId, async (client) => {
      // UNIQUE (transaction_id, journal_entry_id) would have rejected a blind
      // re-point; the RPC drops the duplicate and keeps the original's row.
      await deleteVoucher(client, s.companyId, s.correctionId)
      expect(await linksOf(client, txId)).toEqual([
        { journal_entry_id: s.originalId, role: 'bank_line', allocated_amount: '-1000.00' },
      ])
    })
  })

  it('deleting a plain voucher (no correction_of_id) still lets the FKs release the row', async () => {
    const seed = await seedCompany()
    const entryId = await insertPostedEntry({ ...seed, voucherNumber: 1 })
    const txId = await insertTransaction({
      userId: seed.userId,
      companyId: seed.companyId,
      amount: -1000,
      journalEntryId: entryId,
    })
    await insertLink({
      userId: seed.userId,
      companyId: seed.companyId,
      transactionId: txId,
      journalEntryId: entryId,
      amount: -1000,
    })

    await withUserContext(seed.userId, async (client) => {
      await deleteVoucher(client, seed.companyId, entryId)
      expect(await pointerOf(client, txId)).toBeNull()
      expect(await linksOf(client, txId)).toEqual([])
      expect(await isBooked(client, txId)).toBe(false)
    })
  })
})
