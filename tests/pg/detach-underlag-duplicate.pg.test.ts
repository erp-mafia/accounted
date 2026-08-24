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
 * verifikat. The RPC must only detach a byte-identical duplicate (sha256
 * equality with a remaining anchored sibling), must refuse pinned/last/
 * non-duplicate/unposted/locked-period docs, must write a READABLE audit row
 * (company_id set: the RLS policy filters on it), and must remain the only
 * way past enforce_document_journal_entry_immutability (the direct UPDATE
 * stays blocked).
 */

function makeHash(): string {
  return randomUUID().replace(/-/g, '').padEnd(64, '0')
}

async function attachDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string | null
  fileName?: string
  sha256?: string
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
      params.sha256 ?? makeHash(),
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

/** Entry + an anchored duplicate pair (same sha256). Returns [entryId, keptId, dupId]. */
async function seedDuplicatePair(s: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
}): Promise<[string, string, string]> {
  const entryId = await insertEntry(s)
  const hash = makeHash()
  const keptId = await attachDocument({
    userId: s.userId, companyId: s.companyId, journalEntryId: entryId,
    fileName: 'kept.pdf', sha256: hash,
  })
  const dupId = await attachDocument({
    userId: s.userId, companyId: s.companyId, journalEntryId: entryId,
    fileName: 'dup.pdf', sha256: hash,
  })
  return [entryId, keptId, dupId]
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

  it('detaches a duplicate and writes a reader-visible audit row', async () => {
    const [entryId, keptId, dupId] = await seedDuplicatePair({
      userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber,
    })

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

      // The RPC's explicit provenance row must be visible to a company member
      // under RLS: that requires company_id set (the SELECT policy filters on
      // it), the actor recorded, and the detach description. Matching on the
      // description distinguishes it from the generic write_audit_log trigger
      // row, which must not be the row this assertion passes on.
      const audit = await client.query<{ company_id: string; actor_id: string }>(
        `SELECT company_id, actor_id FROM public.audit_log
          WHERE table_name = 'document_attachments' AND record_id = $1
            AND action = 'UPDATE' AND description LIKE 'Dubblett-underlag%'`,
        [dupId],
      )
      expect(audit.rowCount).toBe(1)
      expect(audit.rows[0].company_id).toBe(companyId)
      expect(audit.rows[0].actor_id).toBe(userId)
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

  it('refuses to detach a non-duplicate (different sha256) even with siblings present', async () => {
    const entryId = await insertEntry({ userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber })
    await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'faktura.pdf' })
    const receiptId = await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'betalkvitto.pdf' })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, receiptId]),
      ).rejects.toThrow(/inte en dubblett/)
    })
  })

  it('refuses to detach from a reversed (storno) verifikat', async () => {
    const [entryId, , dupId] = await seedDuplicatePair({
      userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber,
    })
    // posted -> reversed is the transition the immutability trigger permits.
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [entryId],
    )

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, dupId]),
      ).rejects.toThrow(/bokförda verifikat/)
    })
  })

  it('refuses to detach a document pinned to a bank transaction', async () => {
    const entryId = await insertEntry({ userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber })
    const hash = makeHash()
    await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'other.pdf', sha256: hash })
    const pinnedId = await attachDocument({ userId, companyId, journalEntryId: entryId, fileName: 'pinned.pdf', sha256: hash })
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
    const [, , dupId] = await seedDuplicatePair({
      userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber,
    })
    const outsiderId = await insertAuthUser()

    await withUserContext(outsiderId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, dupId]),
      ).rejects.toThrow(/not a member/)
    })
  })

  it('refuses when the fiscal period is closed', async () => {
    // Seed open (the period-lock triggers block inserting posted entries and
    // anchored docs into an already-closed period), then close the period.
    const s = await seedCompany()
    const [, , dupId] = await seedDuplicatePair({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      voucherNumber: 1,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [s.fiscalPeriodId],
    )

    await withUserContext(s.userId, async (client) => {
      await expect(
        client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [s.companyId, dupId]),
      ).rejects.toThrow(/stängd eller låst/)
    })
  })

  it('keeps the direct UPDATE path blocked by the immutability trigger', async () => {
    const [, , dupId] = await seedDuplicatePair({
      userId, companyId, fiscalPeriodId, voucherNumber: ++voucherNumber,
    })

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
