import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertBalancedLines, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'

// The underlag import (lib/documents/underlag-import.ts) refuses to propose a
// file whose target verifikat sits in a closed or locked period, and the attach
// route maps the failure to DOC_UPLOAD_PERIOD_LOCKED. Both rest on
// enforce_period_lock_documents (migration 20240101000017): a BEFORE
// INSERT/UPDATE trigger on document_attachments that blocks the LINK, not the
// archive. These tests pin that contract, because the plan surface would
// otherwise be free to drift into promising links the database refuses.
const PERIOD_LOCK_ERROR = /locked\/closed fiscal period/i

async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
}): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
  })
  await insertBalancedLines(entryId)
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
    entryId,
  ])
  return entryId
}

async function insertDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, file_size_bytes,
        mime_type, sha256_hash, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      params.userId,
      params.companyId,
      `documents/${params.userId}/${id}.pdf`,
      'A31_underlag.pdf',
      1024,
      'application/pdf',
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
      params.journalEntryId,
    ],
  )
  return id
}

describe('underlag-attach-period-lock.pg: attaching underlag across a period lock', () => {
  it('allows attaching to a verifikat in an open period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })

    await expect(
      insertDocument({ userId, companyId, journalEntryId: entryId }),
    ).resolves.toBeDefined()
  })

  it('rejects attaching to a verifikat in a CLOSED period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )

    await expect(
      insertDocument({ userId, companyId, journalEntryId: entryId }),
    ).rejects.toThrow(PERIOD_LOCK_ERROR)
  })

  it('rejects attaching to a verifikat in a LOCKED period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
      fiscalPeriodId,
    ])

    await expect(
      insertDocument({ userId, companyId, journalEntryId: entryId }),
    ).rejects.toThrow(PERIOD_LOCK_ERROR)
  })

  it('still archives an UNLINKED document in a closed period: the lock guards the link', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )

    await expect(
      insertDocument({ userId, companyId, journalEntryId: null }),
    ).resolves.toBeDefined()
  })

  it('rejects linking an already-archived document into a locked period', async () => {
    // The UPDATE path matters as much as the INSERT: /api/documents/[id]/link
    // moves an existing inbox document onto a verifikat.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: null })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
      fiscalPeriodId,
    ])

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_id = $1 WHERE id = $2`,
        [entryId, docId],
      ),
    ).rejects.toThrow(PERIOD_LOCK_ERROR)
  })
})
