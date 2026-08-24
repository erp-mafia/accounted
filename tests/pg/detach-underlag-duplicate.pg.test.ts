import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  seedCompany,
  insertAuthUser,
  insertPostedJournalEntry,
  insertTransaction,
} from './fixtures'

/**
 * Invariants for detach_underlag_duplicate (support case 2026-08-24): the ONE
 * sanctioned path for removing a redundant duplicate underlag from a posted
 * verifikat. The RPC must only detach when another anchored current-version
 * document remains, must refuse pinned/last/locked-period docs, and must be
 * the only way past enforce_document_journal_entry_immutability (the direct
 * UPDATE stays blocked).
 */

async function attachDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string | null
  fileName?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, journal_entry_id, file_name, mime_type,
        file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, $4, $5, 'application/pdf', 1024, $6, $7, 'file_upload')`,
    [
      id,
      params.userId,
      params.companyId,
      params.journalEntryId,
      params.fileName ?? 'underlag.pdf',
      `documents/${params.companyId}/${id}.pdf`,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
    ],
  )
  return id
}

async function insertEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
}): Promise<string> {
  return insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
    entryDate: '2026-06-10',
    description: `detach test ${params.voucherNumber}`,
    lines: [
      { accountNumber: '1930', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 100 },
    ],
  })
}

describe('detach_underlag_duplicate RPC', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string
  let voucherNumber = 0

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    fiscalPeriodId = s.fiscalPeriodId
  })

  it('detaches a duplicate when another anchored underlag remains', async () => {
    const entryId = await insertEntry({ userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber })
    const keptId = await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'kept.pdf' })
    const dupId = await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'dup.pdf' })

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: { detached: boolean; remaining_documents: number } }>(
        `SELECT public.detach_underlag_duplicate($1, $2) AS result`,
        [companyId, dupId],
      )
      expect(rows[0].result.detached).toBe(true)
      expect(rows[0].result.remaining_documents).toBe(1)

      const after = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
        [dupId],
      )
      expect(after.rows[0].journal_entry_id).toBeNull()

      const kept = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
        [keptId],
      )
      expect(kept.rows[0].journal_entry_id).toBe(entryId)

      const audit = await client.query(
        `SELECT 1 FROM public.audit_log
          WHERE table_name = 'document_attachments' AND record_id = $1 AND action = 'UPDATE'`,
        [dupId],
      )
      expect(audit.rowCount).toBe(1)
    })
  })

  it('refuses to detach the last anchored underlag', async () => {
    const entryId = await insertEntry({ userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber })
    const onlyId = await attachDocument({ userId, companyId, journalEntryId: entryId })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, onlyId]),
      ).rejects.toThrow(/sista underlaget/)
    })
  })

  it('refuses to detach a document pinned to a bank transaction', async () => {
    const entryId = await insertEntry({ userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber })
    await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'other.pdf' })
    const pinnedId = await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'pinned.pdf' })
    const txId = await insertTransaction({
      userId,
      companyId,
      amount: -100,
      description: 'pinned tx',
    })
    // NULL -> doc pin is the allowed direction on the transactions side.
    await getPool().query(
      `UPDATE public.transactions SET document_id = $1 WHERE id = $2`,
      [pinnedId, txId],
    )

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, pinnedId]),
      ).rejects.toThrow(/banktransaktion/)
    })
  })

  it('refuses a caller who is not a member of the company', async () => {
    const entryId = await insertEntry({ userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber })
    await attachDocument({ userId, companyId, journalEntryId: entryId })
    const dupId = await attachDocument({ userId, companyId, journalEntryId: entryId })
    const outsiderId = await insertAuthUser()

    await withUserContext(outsiderId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, dupId]),
      ).rejects.toThrow(/not a member/)
    })
  })

  it('refuses when the fiscal period is closed', async () => {
    const closed = await seedCompany({ isClosed: true })
    const entryId = await insertEntry({
      userId: closed.userId,
      companyId: closed.companyId,
      fiscalPeriodId: closed.fiscalPeriodId,
      voucherNumber: 1,
    })
    await attachDocument({ userId: closed.userId, companyId: closed.companyId, journalEntryId: entryId })
    const dupId = await attachDocument({
      userId: closed.userId,
      companyId: closed.companyId,
      journalEntryId: entryId,
    })

    await withUserContext(closed.userId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [closed.companyId, dupId]),
      ).rejects.toThrow(/stängd eller låst/)
    })
  })

  it('keeps the direct UPDATE path blocked by the immutability trigger', async () => {
    const entryId = await insertEntry({ userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber })
    await attachDocument({ userId, companyId, journalEntryId: entryId })
    const dupId = await attachDocument({ userId, companyId, journalEntryId: entryId })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
          [dupId],
        ),
      ).rejects.toThrow(/BFL_DOCUMENT_IMMUTABILITY/)
    })
  })
})
