import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * pg-real for migration 20260901130000: the WORM integrity ledger that
 * replaces document_attachments.last_integrity_check_at.
 *
 * The bug being closed: enforce_period_lock_documents() (migration 017) is
 * BEFORE INSERT OR UPDATE FOR EACH ROW with no OLD/NEW comparison, so the
 * nightly cron's stamp UPDATE was rejected for every document linked to an
 * entry in a closed or locked period. Because the queue sorted on that same
 * column NULLS FIRST, the rejected rows returned to the head of the queue
 * every night and the batch sat at 200 of 200 rejected. Migration 017 is
 * legally required and stays untouched, so the check moved to its own table:
 * the assertions below pin BOTH halves, that the old UPDATE is still blocked
 * and that the same document can now be integrity-checked.
 */

function makeHash(): string {
  return randomUUID().replace(/-/g, '').padEnd(64, '0')
}

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
      makeHash(),
    ],
  )
  return id
}

async function recordCheck(params: {
  companyId: string
  documentId: string
  checkedAt?: string
  result?: 'passed' | 'hash_mismatch' | 'object_missing'
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.document_integrity_checks
       (company_id, document_id, checked_at, expected_sha256, computed_sha256,
        storage_path, result)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $4, 'documents/x.pdf', $5)
     RETURNING id`,
    [
      params.companyId,
      params.documentId,
      params.checkedAt ?? null,
      makeHash(),
      params.result ?? 'passed',
    ],
  )
  return rows[0].id
}

/** Company + posted entry + anchored document, with the period then sealed. */
async function seedSealedDocument(seal: 'closed' | 'locked'): Promise<{
  userId: string
  companyId: string
  documentId: string
}> {
  // Seed open: the period-lock triggers block inserting a posted entry and an
  // anchored document into an already-sealed period.
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
  })

  await getPool().query(
    seal === 'closed'
      ? `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`
      : `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
    [s.fiscalPeriodId],
  )

  return { userId: s.userId, companyId: s.companyId, documentId }
}

describe('document_integrity_checks: the locked-period write path', () => {
  it('still refuses the legacy stamp on a document in a CLOSED period', async () => {
    const { documentId } = await seedSealedDocument('closed')

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET last_integrity_check_at = now() WHERE id = $1`,
        [documentId],
      ),
    ).rejects.toThrow(/locked\/closed fiscal period/)
  })

  it('still refuses the legacy stamp on a document in a LOCKED period', async () => {
    const { documentId } = await seedSealedDocument('locked')

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET last_integrity_check_at = now() WHERE id = $1`,
        [documentId],
      ),
    ).rejects.toThrow(/locked\/closed fiscal period/)
  })

  it('lets the same closed-period document be integrity-checked', async () => {
    const { companyId, documentId } = await seedSealedDocument('closed')

    await recordCheck({ companyId, documentId })

    const { rows } = await getPool().query<{ result: string; document_id: string }>(
      `SELECT result, document_id FROM public.document_integrity_checks WHERE document_id = $1`,
      [documentId],
    )
    expect(rows).toEqual([{ result: 'passed', document_id: documentId }])
  })

  it('lets the same locked-period document be integrity-checked', async () => {
    const { companyId, documentId } = await seedSealedDocument('locked')

    await recordCheck({ companyId, documentId, result: 'hash_mismatch' })

    const { rows } = await getPool().query<{ result: string }>(
      `SELECT result FROM public.document_integrity_checks WHERE document_id = $1`,
      [documentId],
    )
    expect(rows.map((r) => r.result)).toEqual(['hash_mismatch'])
  })

  it('keeps the sealed document in the queue until a check row exists', async () => {
    const { documentId } = await seedSealedDocument('closed')

    const queued = async () => {
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM public.next_documents_for_integrity_check(1000) WHERE id = $1`,
        [documentId],
      )
      return rows.length
    }

    expect(await queued()).toBe(1)

    const { rows: doc } = await getPool().query<{ company_id: string }>(
      `SELECT company_id FROM public.document_attachments WHERE id = $1`,
      [documentId],
    )
    await recordCheck({ companyId: doc[0].company_id, documentId })

    // Still in the table (the queue is least-recently-checked, not
    // check-once), but it now carries a checked_at instead of NULL.
    const { rows } = await getPool().query<{ last_checked_at: string | null }>(
      `SELECT last_checked_at FROM public.next_documents_for_integrity_check(1000) WHERE id = $1`,
      [documentId],
    )
    expect(rows[0]?.last_checked_at ?? null).not.toBeNull()
  })
})

describe('next_documents_for_integrity_check ordering', () => {
  it('returns never-checked documents before the least recently checked', async () => {
    const s = await seedCompany()
    const never = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
      fileName: 'never.pdf',
    })
    const stale = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
      fileName: 'stale.pdf',
    })
    const fresh = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
      fileName: 'fresh.pdf',
    })
    await recordCheck({ companyId: s.companyId, documentId: stale, checkedAt: '2026-01-01' })
    await recordCheck({ companyId: s.companyId, documentId: fresh, checkedAt: '2026-08-31' })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.next_documents_for_integrity_check(1000)`,
    )
    const mine = rows.map((r) => r.id).filter((id) => [never, stale, fresh].includes(id))
    expect(mine).toEqual([never, stale, fresh])
  })

  it('reads only the newest check per document', async () => {
    const s = await seedCompany()
    const documentId = await attachDocument({
      userId: s.userId,
      companyId: s.companyId,
      journalEntryId: null,
    })
    await recordCheck({ companyId: s.companyId, documentId, checkedAt: '2026-01-01' })
    await recordCheck({ companyId: s.companyId, documentId, checkedAt: '2026-08-31' })

    const { rows } = await getPool().query<{ last_checked_at: Date }>(
      `SELECT last_checked_at FROM public.next_documents_for_integrity_check(1000) WHERE id = $1`,
      [documentId],
    )
    expect(new Date(rows[0].last_checked_at).toISOString().slice(0, 10)).toBe('2026-08-31')
  })

  it('honours p_limit and clamps it to a sane range', async () => {
    const one = await getPool().query(`SELECT * FROM public.next_documents_for_integrity_check(1)`)
    expect(one.rows.length).toBeLessThanOrEqual(1)

    // 0 and negatives clamp up to 1 rather than returning nothing, and the
    // upper clamp keeps a runaway env override from scanning the world.
    const zero = await getPool().query(`SELECT * FROM public.next_documents_for_integrity_check(0)`)
    expect(zero.rows.length).toBeLessThanOrEqual(1)
    const huge = await getPool().query(
      `SELECT * FROM public.next_documents_for_integrity_check(999999)`,
    )
    expect(huge.rows.length).toBeLessThanOrEqual(1000)
  })

  it('is executable by service_role only', async () => {
    const { rows } = await getPool().query<{ role: string; ok: boolean }>(
      `SELECT r.role,
              has_function_privilege(r.role, 'public.next_documents_for_integrity_check(integer)', 'execute') AS ok
         FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.role, r.ok]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    })
  })
})

describe('document_integrity_checks: RLS and grants', () => {
  let userId: string
  let companyId: string
  let documentId: string

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    documentId = await attachDocument({
      userId,
      companyId,
      journalEntryId: null,
      fileName: 'rls.pdf',
    })
    await recordCheck({ companyId, documentId })
  })

  it('lets a company member read its own ledger rows', async () => {
    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ document_id: string }>(
        `SELECT document_id FROM public.document_integrity_checks WHERE company_id = $1`,
        [companyId],
      )
      return res.rows
    })
    expect(rows).toEqual([{ document_id: documentId }])
  })

  it('hides them from a user outside the company', async () => {
    const outsiderId = await insertAuthUser()
    const rows = await withUserContext(outsiderId, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.document_integrity_checks WHERE company_id = $1`,
        [companyId],
      )
      return res.rows
    })
    expect(rows).toHaveLength(0)
  })

  it('has no INSERT/UPDATE/DELETE policy: only the service role appends', async () => {
    const { rows } = await getPool().query<{ polcmd: string }>(
      `SELECT polcmd FROM pg_policy
        WHERE polrelid = 'public.document_integrity_checks'::regclass`,
    )
    // 'r' = SELECT. Anything else would be a write policy.
    expect(rows.map((r) => r.polcmd)).toEqual(['r'])

    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.document_integrity_checks'::regclass`,
    )
    expect(rls.rows[0].relrowsecurity).toBe(true)
  })

  it('grants only what each role needs: member reads, cron appends, nobody updates', async () => {
    const { rows } = await getPool().query<{
      role: string
      can_select: boolean
      can_insert: boolean
      can_update: boolean
      can_delete: boolean
    }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.document_integrity_checks', 'SELECT') AS can_select,
              has_table_privilege(r.role, 'public.document_integrity_checks', 'INSERT') AS can_insert,
              has_table_privilege(r.role, 'public.document_integrity_checks', 'UPDATE') AS can_update,
              has_table_privilege(r.role, 'public.document_integrity_checks', 'DELETE') AS can_delete
         FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)`,
    )
    const byRole = Object.fromEntries(
      rows.map((r) => [
        r.role,
        {
          select: r.can_select,
          insert: r.can_insert,
          update: r.can_update,
          delete: r.can_delete,
        },
      ]),
    )
    expect(byRole).toEqual({
      anon: { select: false, insert: false, update: false, delete: false },
      authenticated: { select: true, insert: false, update: false, delete: false },
      // Append-only: even the cron's role cannot rewrite or erase a check.
      service_role: { select: true, insert: true, update: false, delete: false },
    })
  })

  it('rejects an authenticated INSERT even inside the user own company', async () => {
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.document_integrity_checks
             (company_id, document_id, expected_sha256, storage_path, result)
           VALUES ($1, $2, $3, 'documents/x.pdf', 'passed')`,
          [companyId, documentId, makeHash()],
        ),
      ).rejects.toThrow(/permission denied|row-level security/i)
    })
  })

  it('is append-only: an UPDATE raises in this table own voice', async () => {
    // Not the shared audit_log_immutable() message. "Audit log entries cannot
    // be modified" from a table that is not the audit log misleads whoever
    // reads the log, and app/api/transactions/[id]/route.ts pattern-matches
    // that exact string as an audit-log signal.
    await expect(
      getPool().query(
        `UPDATE public.document_integrity_checks SET result = 'passed' WHERE document_id = $1`,
        [documentId],
      ),
    ).rejects.toThrow(/Document integrity check entries cannot be modified or deleted/i)
  })

  it('rejects an unknown result value', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.document_integrity_checks
           (company_id, document_id, expected_sha256, storage_path, result)
         VALUES ($1, $2, $3, 'documents/x.pdf', 'probably_fine')`,
        [companyId, documentId, makeHash()],
      ),
    ).rejects.toThrow(/document_integrity_checks_result_check|violates check constraint/)
  })

  it('carries the indexes the queue and the tenant read need', async () => {
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'document_integrity_checks'
        ORDER BY indexname`,
    )
    expect(rows.map((r) => r.indexname)).toContain('idx_document_integrity_checks_document')
    expect(rows.map((r) => r.indexname)).toContain('idx_document_integrity_checks_company')
  })

  it('retires the index that served the old queue', async () => {
    // idx_document_attachments_integrity_check (20260330120000) indexed
    // last_integrity_check_at for the cron's old ORDER BY. That query is gone
    // and the column is frozen, so the index was pure write cost on the
    // busiest document table. If it comes back, so has a writer to the legacy
    // column, which is the thing migration 017 rejects.
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'document_attachments'`,
    )
    expect(rows.map((r) => r.indexname)).not.toContain('idx_document_attachments_integrity_check')
  })

  it('keeps the legacy column itself: historical values are evidence', async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'document_attachments'
          AND column_name = 'last_integrity_check_at'`,
    )
    expect(rows).toHaveLength(1)
  })
})
