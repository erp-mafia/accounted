import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
} from './fixtures'

/**
 * pg-real for migration 20261012100600: the schema a fresh replay builds must
 * be the schema production runs, for the four objects that had drifted.
 *
 * - Two prod-only functions are gone: create_invoice_with_items(jsonb, jsonb)
 *   and update_reconciliation_session_counts().
 * - oauth_used_codes is reachable by service_role only, as 20260602145425
 *   intended.
 * - block_document_deletion() is production's version: it pins search_path
 *   and writes an audit row for every unlinked or draft-linked document it
 *   lets through, while a document on a posted voucher is still refused.
 *   Before this migration a replay ran the 20260330130000 body, which logged
 *   only the refusals.
 */

async function attachDocument(params: {
  userId: string
  companyId: string
  journalEntryId: string | null
  fileName: string
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
      params.fileName,
      `documents/${params.companyId}/${id}.pdf`,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
    ],
  )
  return id
}

interface AuditRow {
  user_id: string | null
  company_id: string | null
  action: string
  description: string | null
  old_state_id: string | null
}

async function guardAuditRows(documentId: string): Promise<AuditRow[]> {
  // write_audit_log() also logs every insert and delete of the row with its
  // generic descriptions; only the guard's own rows are asserted here.
  const { rows } = await getPool().query<AuditRow>(
    `SELECT user_id::text, company_id::text, action, description,
            old_state->>'id' AS old_state_id
       FROM public.audit_log
      WHERE table_name = 'document_attachments'
        AND record_id = $1
        AND description NOT IN ('Created document_attachments record',
                                'Updated document_attachments record',
                                'Deleted document_attachments record')
      ORDER BY created_at`,
    [documentId],
  )
  return rows
}

async function documentExists(documentId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM public.document_attachments WHERE id = $1`,
    [documentId],
  )
  return rows.length === 1
}

describe('prod drift leftovers: dropped functions', () => {
  it.each(['create_invoice_with_items', 'update_reconciliation_session_counts'])(
    'public.%s does not exist under any signature',
    async (name) => {
      const { rows } = await getPool().query(
        `SELECT p.oid::regprocedure::text AS signature
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [name],
      )
      expect(rows).toEqual([])
    },
  )
})

describe('prod drift leftovers: oauth_used_codes privileges', () => {
  const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

  it.each(['anon', 'authenticated'])('%s holds no privilege on the table', async (role) => {
    const { rows } = await getPool().query<{ privilege: string; granted: boolean }>(
      `SELECT p AS privilege, has_table_privilege($1, 'public.oauth_used_codes', p) AS granted
         FROM unnest($2::text[]) AS p`,
      [role, privileges],
    )
    expect(rows.filter((r) => r.granted)).toEqual([])
  })

  it('keeps service_role access (the OAuth token endpoint) and RLS on', async () => {
    const { rows } = await getPool().query<{
      can_select: boolean
      can_insert: boolean
      can_delete: boolean
      rls: boolean
    }>(
      `SELECT has_table_privilege('service_role', 'public.oauth_used_codes', 'SELECT') AS can_select,
              has_table_privilege('service_role', 'public.oauth_used_codes', 'INSERT') AS can_insert,
              has_table_privilege('service_role', 'public.oauth_used_codes', 'DELETE') AS can_delete,
              (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.oauth_used_codes'::regclass) AS rls`,
    )
    expect(rows[0]).toEqual({ can_select: true, can_insert: true, can_delete: true, rls: true })
  })
})

describe('prod drift leftovers: block_document_deletion() is production\'s version', () => {
  it('is SECURITY DEFINER with search_path pinned to public', async () => {
    const { rows } = await getPool().query<{ secdef: boolean; config: string[] | null }>(
      `SELECT prosecdef AS secdef, proconfig AS config
         FROM pg_proc WHERE oid = 'public.block_document_deletion()'::regprocedure`,
    )
    expect(rows[0]).toEqual({ secdef: true, config: ['search_path=public'] })
  })

  it('audits the deletion of an unlinked document and lets it through', async () => {
    const s = await seedCompany()
    const documentId = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
      fileName: 'kvitto-unlinked.pdf',
    })

    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId])

    expect(await documentExists(documentId)).toBe(false)
    expect(await guardAuditRows(documentId)).toEqual([
      {
        user_id: s.userId,
        company_id: s.companyId,
        action: 'DELETE',
        description: 'Deleted unlinked document "kvitto-unlinked.pdf"',
        old_state_id: documentId,
      },
    ])
  })

  it('audits the deletion of a document linked to a draft entry and lets it through', async () => {
    // Inside the 7-year window the retention check refuses a draft-linked
    // document too, so the let-through branch needs a period that ended more
    // than seven years ago.
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2018',
      periodStart: '2018-01-01',
      periodEnd: '2018-12-31',
    })
    const s = { userId, companyId }
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2018-06-01',
    })
    const documentId = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: entryId,
      fileName: 'kvitto-draft.pdf',
    })

    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId])

    expect(await documentExists(documentId)).toBe(false)
    expect(await guardAuditRows(documentId)).toEqual([
      {
        user_id: s.userId,
        company_id: s.companyId,
        action: 'DELETE',
        description: `Deleted document "kvitto-draft.pdf" linked to draft entry ${entryId}`,
        old_state_id: documentId,
      },
    ])
  })

  it('still refuses to delete a document linked to a posted entry', async () => {
    const s = await seedCompany()
    const entryId = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      voucherNumber: 1,
    })
    const documentId = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: entryId,
      fileName: 'kvitto-posted.pdf',
    })

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId]),
    ).rejects.toThrow(/Cannot delete document linked to a posted journal entry/)

    expect(await documentExists(documentId)).toBe(true)
    // The refusal's own audit row rolls back with the failed statement.
    expect(await guardAuditRows(documentId)).toEqual([])
  })
})
