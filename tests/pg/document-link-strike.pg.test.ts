import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
} from './fixtures'

/**
 * A wrongly linked underlag is struck, never moved or deleted (migration
 * *_document_link_strike.sql). The strike is a logged state on the document's
 * own row: who (the session's user), when (the database clock) and why, set
 * once. The link itself stays (enforce_document_journal_entry_immutability is
 * untouched and still refuses every move), the document stays behind the WORM
 * guards, and a struck link stops counting as the verifikat's underlag in
 * every reader of "verifikat without underlag".
 */

function makeHash(): string {
  return randomUUID().replace(/-/g, '').padEnd(64, '0')
}

async function attach(params: {
  userId: string
  companyId: string
  journalEntryId: string | null
  sha256?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, journal_entry_id, file_name, mime_type,
        file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, $4, 'faktura.pdf', 'application/pdf', 1024, $5, $6, 'file_upload')`,
    [id, params.userId, params.companyId, params.journalEntryId, `documents/${params.companyId}/${id}.pdf`, params.sha256 ?? makeHash()],
  )
  return id
}

/** A strike made by a server-side caller (no user in the claims) for `by`, committed. */
async function strikeAsServer(documentId: string, by: string, copyId: string | null, reason = 'Hör till en annan verifikation'): Promise<void> {
  await getPool().query(
    `UPDATE public.document_attachments
        SET link_struck_at = now(), link_struck_by = $2, link_struck_reason = $3, link_struck_copy_id = $4
      WHERE id = $1`,
    [documentId, by, reason, copyId],
  )
}

describe('document link strike (pg)', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string
  let voucherNumber = 0

  const entry = (sourceType = 'manual') =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: ++voucherNumber,
      entryDate: '2026-06-10',
      description: `strike test ${voucherNumber}`,
      sourceType,
      lines: [
        { accountNumber: '6570', debitAmount: 13.17, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 13.17 },
      ],
    })

  /** A posted verifikat A holding a document, and a copy of the same bytes on posted verifikat B. */
  async function wrongAndRight(): Promise<{ a: string; b: string; doc: string; copy: string; hash: string }> {
    const a = await entry()
    const b = await entry()
    const hash = makeHash()
    const doc = await attach({ userId, companyId, journalEntryId: a, sha256: hash })
    const copy = await attach({ userId, companyId, journalEntryId: b, sha256: hash })
    return { a, b, doc, copy, hash }
  }

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    fiscalPeriodId = s.fiscalPeriodId
  })

  it('strikes the link in place: who is the session user, when is the database clock, nothing moves', async () => {
    const { a, doc, copy } = await wrongAndRight()

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ journal_entry_id: string; link_struck_by: string; fresh: boolean; reason: string; copy: string }>(
        `UPDATE public.document_attachments
            SET link_struck_at = '2001-01-01', link_struck_by = $2,
                link_struck_reason = 'Återbetalningskvittot hör till en annan verifikation', link_struck_copy_id = $3
          WHERE id = $1
          RETURNING journal_entry_id, link_struck_by, link_struck_at > now() - interval '1 minute' AS fresh,
                    link_struck_reason AS reason, link_struck_copy_id AS copy`,
        [doc, randomUUID(), copy],
      )
      expect(rows).toEqual([{ journal_entry_id: a, link_struck_by: userId, fresh: true, reason: 'Återbetalningskvittot hör till en annan verifikation', copy }])

      // The append-only trail has the strike too, with the person who made it.
      const audit = await client.query<{ actor_id: string; reason: string; entry: string }>(
        `SELECT actor_id, new_state->>'link_struck_reason' AS reason, new_state->>'journal_entry_id' AS entry
           FROM public.audit_log
          WHERE table_name = 'document_attachments' AND record_id = $1 AND action = 'UPDATE'
          ORDER BY created_at DESC LIMIT 1`,
        [doc],
      )
      expect(audit.rows).toEqual([{ actor_id: userId, reason: 'Återbetalningskvittot hör till en annan verifikation', entry: a }])
    })
  })

  it('keeps a strike for good, and the link and the document with it', async () => {
    const { b, doc, copy } = await wrongAndRight()
    await strikeAsServer(doc, userId, copy)

    const refused = async (sql: string, params: unknown[], pattern: RegExp, asUser = true) => {
      if (asUser) {
        await expect(withUserContext(userId, (client) => client.query(sql, params))).rejects.toThrow(pattern)
      } else {
        await expect(getPool().query(sql, params)).rejects.toThrow(pattern)
      }
    }

    // The strike cannot be changed or taken back, by the user or by anyone.
    await refused(`UPDATE public.document_attachments SET link_struck_reason = 'annat skäl' WHERE id = $1`, [doc], /DOC_STRIKE_PERMANENT/)
    await refused(
      `UPDATE public.document_attachments
          SET link_struck_at = NULL, link_struck_by = NULL, link_struck_reason = NULL, link_struck_copy_id = NULL
        WHERE id = $1`,
      [doc],
      /DOC_STRIKE_PERMANENT/,
    )
    await refused(`UPDATE public.document_attachments SET link_struck_at = now() WHERE id = $1`, [doc], /DOC_STRIKE_PERMANENT/, false)

    // The link never moves and is never cleared: the immutability trigger holds.
    await refused(`UPDATE public.document_attachments SET journal_entry_id = $2 WHERE id = $1`, [doc, b], /BFL_DOCUMENT_IMMUTABILITY/)
    await refused(`UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`, [doc], /BFL_DOCUMENT_IMMUTABILITY/)

    // The document stays in the archive: no delete, and no new version over it.
    await refused(`DELETE FROM public.document_attachments WHERE id = $1`, [doc], /Cannot delete document linked to a posted journal entry/)
    await expect(
      withUserContext(userId, async (client) => {
        await client.query(`SELECT set_config('gnubok.allow_supersede', 'true', true)`)
        await client.query(`UPDATE public.document_attachments SET is_current_version = false WHERE id = $1`, [doc])
      }),
    ).rejects.toThrow(/DOC_STRIKE_PERMANENT/)

    const { rows } = await getPool().query<{ struck: boolean; current: boolean }>(
      `SELECT link_struck_at IS NOT NULL AS struck, is_current_version AS current FROM public.document_attachments WHERE id = $1`,
      [doc],
    )
    expect(rows).toEqual([{ struck: true, current: true }])
  })

  it('refuses a strike outside its window, without a reason, or of a document a register holds', async () => {
    const strikeAsUser = (documentId: string, reason: string, copyId: string | null) =>
      withUserContext(userId, (client) =>
        client.query(
          `UPDATE public.document_attachments
              SET link_struck_at = now(), link_struck_by = $2, link_struck_reason = $3, link_struck_copy_id = $4
            WHERE id = $1`,
          [documentId, userId, reason, copyId],
        ),
      )

    const { doc, copy } = await wrongAndRight()
    await expect(strikeAsUser(doc, '   ', copy)).rejects.toThrow(/DOC_STRIKE_REASON_REQUIRED/)

    const unlinked = await attach({ userId, companyId, journalEntryId: null })
    await expect(strikeAsUser(unlinked, 'fel', null)).rejects.toThrow(/DOC_STRIKE_NOT_LINKED/)

    const draft = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, entryDate: '2026-06-10' })
    const onDraft = await attach({ userId, companyId, journalEntryId: draft })
    await expect(strikeAsUser(onDraft, 'fel', null)).rejects.toThrow(/DOC_STRIKE_NOT_POSTED/)

    // A bank transaction holds the document as its own underlag.
    const pinned = await wrongAndRight()
    const tx = await insertTransaction({ companyId, userId, amount: -13.17, description: 'pinned tx' })
    await getPool().query(`UPDATE public.transactions SET document_id = $2 WHERE id = $1`, [tx, pinned.doc])
    await expect(strikeAsUser(pinned.doc, 'fel', pinned.copy)).rejects.toThrow(/DOC_STRIKE_PINNED/)

    // The copy must be the same bytes, on another verifikat.
    const other = await wrongAndRight()
    const otherBytes = await attach({ userId, companyId, journalEntryId: other.b })
    await expect(strikeAsUser(other.doc, 'fel', otherBytes)).rejects.toThrow(/DOC_STRIKE_COPY_INVALID/)
    const sameEntry = await attach({ userId, companyId, journalEntryId: other.a, sha256: other.hash })
    await expect(strikeAsUser(other.doc, 'fel', sameEntry)).rejects.toThrow(/DOC_STRIKE_COPY_INVALID/)

    // A server-side caller names a member of the company.
    const stranger = await insertAuthUser()
    await expect(strikeAsServer(other.doc, stranger, other.copy)).rejects.toThrow(/DOC_STRIKE_ACTOR_REQUIRED/)

    // Behind the company's lock date the verifikation stays as it is.
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, bookkeeping_locked_through) VALUES ($1, '2026-06-30')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [companyId],
    )
    try {
      await expect(strikeAsUser(other.doc, 'fel', other.copy)).rejects.toThrow(/DOC_STRIKE_PERIOD_LOCKED/)
    } finally {
      await getPool().query(`UPDATE public.company_settings SET bookkeeping_locked_through = NULL WHERE company_id = $1`, [companyId])
    }
  })

  it('refuses a strike in a locked period', async () => {
    const ownerId = await insertAuthUser()
    const lockedCompany = await insertCompany({ createdBy: ownerId })
    await insertCompanyMember({ companyId: lockedCompany, userId: ownerId, role: 'owner' })
    const period = await insertFiscalPeriod({ userId: ownerId, companyId: lockedCompany })
    const a = await insertPostedJournalEntry({ userId: ownerId, companyId: lockedCompany, fiscalPeriodId: period, voucherNumber: 1, entryDate: '2026-03-01' })
    const doc = await attach({ userId: ownerId, companyId: lockedCompany, journalEntryId: a })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [period])

    await expect(strikeAsServer(doc, ownerId, null)).rejects.toThrow(/DOC_STRIKE_PERIOD_LOCKED/)
  })

  it('does not count a struck link as the verifikat\'s underlag', async () => {
    const { a, b, doc, copy } = await wrongAndRight()
    const kept = await entry()
    await attach({ userId, companyId, journalEntryId: kept })
    const tx = await insertTransaction({ companyId, userId, journalEntryId: a })

    const missing = async () => {
      const pool = getPool()
      const v = await pool.query<{ r: { verifikat: { journal_entry_id: string }[] } }>(
        `SELECT public.verifikat_without_documents($1, NULL, 0, 100, 0) AS r`,
        [companyId],
      )
      const l = await pool.query<{ r: { ids: string[] } }>(
        `SELECT public.list_verifikat_missing_underlag($1, p_limit => 1000) AS r`,
        [companyId],
      )
      const t = await pool.query<{ r: { transactions: { id: string }[] } }>(
        `SELECT public.transactions_without_documents($1, NULL, 100, 0) AS r`,
        [companyId],
      )
      return {
        verifikat: v.rows[0].r.verifikat.map((row) => row.journal_entry_id),
        list: l.rows[0].r.ids,
        transactions: t.rows[0].r.transactions.map((row) => row.id),
      }
    }

    const before = await missing()
    expect(before.verifikat).not.toContain(a)
    expect(before.list).not.toContain(a)
    expect(before.transactions).not.toContain(tx)

    await strikeAsServer(doc, userId, copy)

    const after = await missing()
    expect(after.verifikat).toContain(a)
    expect(after.list).toContain(a)
    expect(after.transactions).toContain(tx)
    // The right verifikat holds its copy, and an untouched one its document.
    for (const id of [b, kept]) {
      expect(after.verifikat).not.toContain(id)
      expect(after.list).not.toContain(id)
    }
  })

  it('leaves a struck document to detach_underlag_duplicate neither as the one detached nor as the one that remains', async () => {
    const a = await entry()
    const hash = makeHash()
    const struck = await attach({ userId, companyId, journalEntryId: a, sha256: hash })
    const duplicate = await attach({ userId, companyId, journalEntryId: a, sha256: hash })
    await strikeAsServer(struck, userId, null)

    await withUserContext(userId, async (client) => {
      await expect(client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, struck])).rejects.toThrow(/struket/)
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`SELECT public.detach_underlag_duplicate($1, $2)`, [companyId, duplicate])).rejects.toThrow(
        /skulle stå utan underlag/,
      )
    })
  })

  it('keeps the name of a person who struck a link after their account is deleted', async () => {
    const anna = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.profiles (id, email, full_name) VALUES ($1, 'anna@example.se', 'Anna Andersson')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
      [anna],
    )
    await insertCompanyMember({ companyId, userId: anna, role: 'member' })
    const { doc, copy } = await wrongAndRight()
    await strikeAsServer(doc, anna, copy)

    await getPool().query('SELECT public.erase_user_personal_data($1)', [anna])

    const { rows } = await getPool().query<{ full_name: string | null; email: string | null; expires: string }>(
      `SELECT full_name, email, retention_expires_at::text AS expires
         FROM public.rattelse_actor_names WHERE company_id = $1 AND user_id = $2`,
      [companyId, anna],
    )
    // The fiscal year ends 2026-12-31: kept through 2033.
    expect(rows).toEqual([{ full_name: 'Anna Andersson', email: 'anna@example.se', expires: '2034-01-01' }])
    const struck = await getPool().query<{ by: string }>(`SELECT link_struck_by AS by FROM public.document_attachments WHERE id = $1`, [doc])
    expect(struck.rows).toEqual([{ by: anna }])
  })
})
