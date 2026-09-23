import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

// BFL retention is enforced by two independent triggers on document_attachments:
//   * enforce_document_journal_entry_immutability (20260506130000): blocks
//     any change to journal_entry_id once it has been set, regardless of the
//     linked entry's status. Honors gnubok.allow_delete (20260506140000).
//   * enforce_document_metadata_immutability (extended in 20260506120000):
//     blocks metadata changes and journal_entry_line_id changes when the
//     linked entry is posted/reversed. Also honors gnubok.allow_delete.
//
// Both wordings: "BFL 5 kap" (entry trigger) and "BFL 7 kap" (metadata
// trigger): are accepted; which one fires first depends on what column the
// UPDATE touches.
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

// Insert a draft, balance it, and walk through the legal state-machine
// transitions to land on the requested status. enforce_journal_entry_immutability
// only allows draft→posted and posted→reversed, so the path matters.
async function insertEntryAtStatus(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  status?: 'posted' | 'reversed'
}): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
  })
  await insertBalancedLines(entryId)
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

describe('document-immutability.pg: BFL retention bypass guards', () => {
  it('rejects unlinking (journal_entry_id → NULL) on a doc linked to a posted entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
        [docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)
  })

  it('rejects unlinking on a doc linked to a reversed entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, status: 'reversed',
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
        [docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)
  })

  it('rejects unlinking on a doc linked to a draft entry: link is durable from first set', async () => {
    // The entry-level trigger does not consult journal_entries.status; once
    // journal_entry_id is set on a document, it cannot be cleared. This is
    // stricter than the original branch design and matches main's intent
    // that the verifikation→underlag link be durable from first set.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const draftId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 0,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: draftId })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
        [docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)
  })

  it('rejects re-pointing journal_entry_id to a different posted entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryA = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const entryB = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 2,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryA })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_id = $1 WHERE id = $2`,
        [entryB, docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)
  })

  it('allows first-time linking (NULL → UUID): legitimate linkToJournalEntry path', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: null })

    await getPool().query(
      `UPDATE public.document_attachments SET journal_entry_id = $1 WHERE id = $2`,
      [entryId, docId],
    )
    const after = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [docId],
    )
    expect(after.rows[0]!.journal_entry_id).toBe(entryId)
  })

  it('rejects unlinking journal_entry_line_id on a doc linked to a posted entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const lineRow = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 LIMIT 1`,
      [entryId],
    )
    const lineId = lineRow.rows[0]!.id
    const docId = await insertDocument({
      userId, companyId, journalEntryId: entryId, journalEntryLineId: lineId,
    })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_line_id = NULL WHERE id = $1`,
        [docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)
  })

  it('end-to-end: unlink-then-delete attack is blocked at the unlink step', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
        [docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [docId]),
    ).rejects.toThrow(/Bokföringslagen/i)
  })

  it('respects gnubok.allow_delete bypass: delete_last_voucher RPC keeps working', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(
        `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
        [docId],
      )
      const after = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
        [docId],
      )
      expect(after.rows[0]!.journal_entry_id).toBeNull()
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})

// The supersession flow needs to flip the OLD row from is_current_version=true
// to false. The metadata-immutability trigger blocks that change for docs
// linked to posted entries unless the gnubok.allow_supersede GUC is set:
// which create_document_version sets before its UPDATE. Without this, users
// have no way to replace a corrupt underlag (e.g. a bad PDF uploaded via the
// MCP server before magic-byte validation).
describe('document-immutability.pg: version supersession on posted entries', () => {
  it('allows create_document_version on a doc linked to a posted entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    // create_document_version is SECURITY DEFINER but enforces auth.uid()
    // matches p_user_id and that the caller is a company member, so the
    // call must run under withUserContext(userId).
    const newId = await withUserContext(userId, async (client) => {
      const result = await client.query<{ new_id: string }>(
        `SELECT public.create_document_version(
           $1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::text, $7::text
         ) AS new_id`,
        [
          userId,
          docId,
          `documents/${userId}/replacement.pdf`,
          'replacement.pdf',
          2048,
          'application/pdf',
          'b'.repeat(64),
        ],
      )
      const id = result.rows[0]!.new_id
      // The transaction is rolled back by withUserContext, so we have to
      // assert state from within the same client/transaction.
      const oldRow = await client.query<{
        is_current_version: boolean
        superseded_by_id: string | null
        journal_entry_id: string | null
      }>(
        `SELECT is_current_version, superseded_by_id, journal_entry_id
         FROM public.document_attachments WHERE id = $1`,
        [docId],
      )
      expect(oldRow.rows[0]!.is_current_version).toBe(false)
      expect(oldRow.rows[0]!.superseded_by_id).toBe(id)
      expect(oldRow.rows[0]!.journal_entry_id).toBe(entryId)

      const newRow = await client.query<{
        is_current_version: boolean
        version: number
        journal_entry_id: string | null
        prev_version_hash: string | null
      }>(
        `SELECT is_current_version, version, journal_entry_id, prev_version_hash
         FROM public.document_attachments WHERE id = $1`,
        [id],
      )
      expect(newRow.rows[0]!.is_current_version).toBe(true)
      expect(newRow.rows[0]!.version).toBe(2)
      expect(newRow.rows[0]!.journal_entry_id).toBe(entryId)
      expect(newRow.rows[0]!.prev_version_hash).toBe('a'.repeat(64))

      return id
    })

    expect(newId).toBeDefined()
  })

  it('allows create_document_version on a doc linked to a reversed entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, status: 'reversed',
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    await withUserContext(userId, async (client) => {
      const result = await client.query(
        `SELECT public.create_document_version(
           $1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::text, $7::text
         )`,
        [
          userId, docId,
          `documents/${userId}/replacement.pdf`,
          'replacement.pdf', 2048, 'application/pdf', 'c'.repeat(64),
        ],
      )
      expect(result.rows).toHaveLength(1)
    })
  })

  // Cross-tenant attack: a member of company A calls create_document_version
  // with a document id that belongs to company B. Before the auth+membership
  // check landed, the SECURITY DEFINER function would happily mutate the
  // foreign company's row because the GUC bypass disarmed the immutability
  // trigger. The membership guard inside the function is the only line of
  // defence: PostgREST exposes the RPC to all authenticated users.
  it('rejects create_document_version when caller is not a member of the document company', async () => {
    const { userId: aliceId, companyId: aliceCompanyId, fiscalPeriodId: aliceFp } =
      await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId: aliceId,
      companyId: aliceCompanyId,
      fiscalPeriodId: aliceFp,
      voucherNumber: 1,
    })
    const docId = await insertDocument({
      userId: aliceId,
      companyId: aliceCompanyId,
      journalEntryId: entryId,
    })

    // Bob has his own company; he is NOT a member of Alice's company.
    const bobId = await insertAuthUser()
    const bobCompany = await insertCompany({ createdBy: bobId })
    await insertCompanyMember({ companyId: bobCompany, userId: bobId, role: 'owner' })

    await withUserContext(bobId, async (client) => {
      await expect(
        client.query(
          `SELECT public.create_document_version(
             $1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::text, $7::text
           )`,
          [
            bobId, docId,
            `documents/${bobId}/exfil.pdf`,
            'exfil.pdf', 2048, 'application/pdf', 'd'.repeat(64),
          ],
        ),
      ).rejects.toThrow(/not a member/i)
    })
  })

  // Identity-spoofing attack: caller passes p_user_id ≠ auth.uid(). Allowing
  // this would let any authenticated user manufacture supersession events
  // attributed to a different user: useful for audit-log forgery even when
  // the supersession itself is legitimate.
  it('rejects create_document_version when p_user_id does not match auth.uid()', async () => {
    const { userId: aliceId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId: aliceId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({
      userId: aliceId, companyId, journalEntryId: entryId,
    })

    // Mallory is also a member of the company: so the membership check
    // alone would not catch a spoofed p_user_id.
    const malloryId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: malloryId, role: 'member' })

    await withUserContext(malloryId, async (client) => {
      await expect(
        client.query(
          `SELECT public.create_document_version(
             $1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::text, $7::text
           )`,
          [
            // Spoofing aliceId as the actor while auth.uid() is malloryId.
            aliceId, docId,
            `documents/${aliceId}/spoofed.pdf`,
            'spoofed.pdf', 2048, 'application/pdf', 'e'.repeat(64),
          ],
        ),
      ).rejects.toThrow(/does not match authenticated user/i)
    })
  })

  // The narrowed bypass: even with allow_supersede set, a direct UPDATE that
  // tries to change sha256_hash, journal_entry_id, or any other audit field
  // must still be blocked. Before the narrowing the GUC was a blanket
  // bypass that disarmed the entire trigger.
  it('keeps blocking sha256_hash mutation even when allow_supersede is set', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_supersede', 'true', true)`)
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

  it('keeps blocking journal_entry_id mutation even when allow_supersede is set', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryA = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const entryB = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 2,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryA })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_supersede', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.document_attachments SET journal_entry_id = $1 WHERE id = $2`,
          [entryB, docId],
        ),
      ).rejects.toThrow(BFL_RETENTION_ERROR)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('rejects direct UPDATE flipping is_current_version without the GUC', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET is_current_version = false WHERE id = $1`,
        [docId],
      ),
    ).rejects.toThrow(BFL_RETENTION_ERROR)
  })

  it('respects gnubok.allow_supersede bypass on direct UPDATE', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertEntryAtStatus({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertDocument({ userId, companyId, journalEntryId: entryId })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_supersede', 'true', true)`)
      await client.query(
        `UPDATE public.document_attachments SET is_current_version = false WHERE id = $1`,
        [docId],
      )
      const after = await client.query<{ is_current_version: boolean }>(
        `SELECT is_current_version FROM public.document_attachments WHERE id = $1`,
        [docId],
      )
      expect(after.rows[0]!.is_current_version).toBe(false)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
