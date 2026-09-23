import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompanyMember,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

// relink_documents_to_correction (20260704103000) is the ONLY legal path for
// moving underlag from a corrected (reversed) entry to its correction. The
// immutability triggers block the direct UPDATE unconditionally; the RPC
// validates the correction chain and performs the move under the narrow
// gnubok.allow_correction_relink GUC. These tests reproduce the production
// failure ([storno] relinkDocumentsToEntry: BFL_DOCUMENT_IMMUTABILITY) and
// prove the RPC path works while every abuse path stays blocked.

const BFL_RETENTION_ERROR = /BFL [57] kap/i

async function insertDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string | null
  journalEntryLineId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, file_size_bytes,
        mime_type, sha256_hash, journal_entry_id, journal_entry_line_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      params.userId,
      params.companyId,
      `documents/${params.userId}/${id}.pdf`,
      'underlag.pdf',
      1024,
      'application/pdf',
      'a'.repeat(64),
      params.journalEntryId,
      params.journalEntryLineId ?? null,
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
    // Drafts are mutable — set the correction link before posting; the
    // immutability trigger blocks changing it afterwards.
    await getPool().query(
      `UPDATE public.journal_entries SET correction_of_id = $2 WHERE id = $1`,
      [entryId, params.correctionOfId],
    )
  }
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [entryId],
  )
  if (params.status === 'reversed') {
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [entryId],
    )
  }
  return entryId
}

/** A reversed original + its posted correction, mirroring correctEntry()'s end state. */
async function seedCorrectionPair(seed: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<{ originalId: string; correctionId: string }> {
  const originalId = await insertEntryAtStatus({
    ...seed,
    voucherNumber: 1,
    status: 'reversed',
  })
  const correctionId = await insertEntryAtStatus({
    ...seed,
    voucherNumber: 2,
    correctionOfId: originalId,
  })
  return { originalId, correctionId }
}

describe('correction-document-relink.pg — relink_documents_to_correction RPC', () => {
  it('reproduces the production failure: direct relink UPDATE is blocked', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)
    const docId = await insertDocument({
      userId: seed.userId,
      companyId: seed.companyId,
      journalEntryId: originalId,
    })

    // This is exactly what relinkDocumentsToEntry used to run — and why it
    // failed 100% of the time in production.
    await expect(
      getPool().query(
        `UPDATE public.document_attachments
         SET journal_entry_id = $1, journal_entry_line_id = NULL
         WHERE id = $2`,
        [correctionId, docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)
  })

  it('moves underlag along a genuine correction chain and clears the line link', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)
    const lineRow = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 LIMIT 1`,
      [originalId],
    )
    const docId = await insertDocument({
      userId: seed.userId,
      companyId: seed.companyId,
      journalEntryId: originalId,
      journalEntryLineId: lineRow.rows[0]!.id,
    })

    await withUserContext(seed.userId, async (client) => {
      const result = await client.query<{ moved: number }>(
        `SELECT public.relink_documents_to_correction($1::uuid, $2::uuid, $3::uuid) AS moved`,
        [seed.userId, originalId, correctionId],
      )
      expect(result.rows[0]!.moved).toBe(1)

      const after = await client.query<{
        journal_entry_id: string | null
        journal_entry_line_id: string | null
      }>(
        `SELECT journal_entry_id, journal_entry_line_id
         FROM public.document_attachments WHERE id = $1`,
        [docId],
      )
      expect(after.rows[0]!.journal_entry_id).toBe(correctionId)
      expect(after.rows[0]!.journal_entry_line_id).toBeNull()

      // The move is auditable.
      const audit = await client.query(
        `SELECT 1 FROM public.audit_log
         WHERE table_name = 'document_attachments'
           AND record_id = $1
           AND description LIKE 'Relinked%'`,
        [originalId],
      )
      expect(audit.rows).toHaveLength(1)
    })
  })

  it('accepts a service-role caller with an explicit p_user_id (pending-operations executor)', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)
    await insertDocument({
      userId: seed.userId,
      companyId: seed.companyId,
      journalEntryId: originalId,
    })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      // Service-role shape: role claim without a sub — auth.uid() is NULL.
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: 'service_role' }),
      ])
      const result = await client.query<{ moved: number }>(
        `SELECT public.relink_documents_to_correction($1::uuid, $2::uuid, $3::uuid) AS moved`,
        [seed.userId, originalId, correctionId],
      )
      expect(result.rows[0]!.moved).toBe(1)
    } finally {
      // Always roll back, even if the RPC or an assertion threw: releasing a
      // connection mid-transaction poisons it for the next test that reuses it.
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('rejects when the target is not the correction of the source', async () => {
    const seed = await seedCompany()
    const originalId = await insertEntryAtStatus({
      ...seed,
      voucherNumber: 1,
      status: 'reversed',
    })
    // Posted, but with no correction_of_id link back to the original.
    const unrelatedId = await insertEntryAtStatus({ ...seed, voucherNumber: 2 })
    await insertDocument({
      userId: seed.userId,
      companyId: seed.companyId,
      journalEntryId: originalId,
    })

    await withUserContext(seed.userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.relink_documents_to_correction($1::uuid, $2::uuid, $3::uuid)`,
          [seed.userId, originalId, unrelatedId],
        ),
      ).rejects.toThrow(/not the correction of/i)
    })
  })

  it('rejects when the source entry is not reversed', async () => {
    const seed = await seedCompany()
    const originalId = await insertEntryAtStatus({ ...seed, voucherNumber: 1 }) // still posted
    const correctionId = await insertEntryAtStatus({
      ...seed,
      voucherNumber: 2,
      correctionOfId: originalId,
    })

    await withUserContext(seed.userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.relink_documents_to_correction($1::uuid, $2::uuid, $3::uuid)`,
          [seed.userId, originalId, correctionId],
        ),
      ).rejects.toThrow(/not reversed/i)
    })
  })

  it('rejects a caller who is not a member of the entries company', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)

    const bobId = await insertAuthUser()

    await withUserContext(bobId, async (client) => {
      await expect(
        client.query(
          `SELECT public.relink_documents_to_correction($1::uuid, $2::uuid, $3::uuid)`,
          [bobId, originalId, correctionId],
        ),
      ).rejects.toThrow(/not a member/i)
    })
  })

  it('rejects a spoofed p_user_id from an authenticated session', async () => {
    const seed = await seedCompany()
    const { originalId, correctionId } = await seedCorrectionPair(seed)

    const malloryId = await insertAuthUser()
    await insertCompanyMember({
      companyId: seed.companyId,
      userId: malloryId,
      role: 'member',
    })

    await withUserContext(malloryId, async (client) => {
      await expect(
        client.query(
          `SELECT public.relink_documents_to_correction($1::uuid, $2::uuid, $3::uuid)`,
          // Attributing the relink to seed.userId while auth.uid() is mallory.
          [seed.userId, originalId, correctionId],
        ),
      ).rejects.toThrow(/does not match authenticated user/i)
    })
  })

  it('GUC stays narrow: journal_entry_id → NULL is blocked even with the relink GUC set', async () => {
    const seed = await seedCompany()
    const { originalId } = await seedCorrectionPair(seed)
    const docId = await insertDocument({
      userId: seed.userId,
      companyId: seed.companyId,
      journalEntryId: originalId,
    })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_correction_relink', 'true', true)`)
      // Clearing to NULL would be a soft-delete bypass of BFL 7 kap 2§ —
      // must raise even under the GUC.
      await expect(
        client.query(
          `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
          [docId],
        ),
      ).rejects.toThrow(BFL_RETENTION_ERROR)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('GUC stays narrow: sha256_hash mutation is blocked even with the relink GUC set', async () => {
    const seed = await seedCompany()
    const { originalId } = await seedCorrectionPair(seed)
    const docId = await insertDocument({
      userId: seed.userId,
      companyId: seed.companyId,
      journalEntryId: originalId,
    })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_correction_relink', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.document_attachments SET sha256_hash = $2 WHERE id = $1`,
          [docId, 'f'.repeat(64)],
        ),
      ).rejects.toThrow(BFL_RETENTION_ERROR)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
