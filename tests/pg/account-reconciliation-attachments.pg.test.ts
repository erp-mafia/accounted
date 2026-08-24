import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260824200000_account_reconciliation_attachments:
// RLS (members read, owner/admin/member attach as themselves, viewers
// read-only, no DELETE policy), the append-only freeze trigger (only the
// removal stamp may change, and only once), the no-delete trigger, and the
// account_key / sha256 CHECKs.

const SHA = 'ab'.repeat(32)

async function insertAttachment(
  companyId: string,
  uploadedBy: string,
  overrides: { accountKey?: string; throughDate?: string; storagePath?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.account_reconciliation_attachments
       (id, company_id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, 'kontoutdrag.pdf', 'application/pdf', 1234, 'documents', $5, $6, $7)`,
    [
      id,
      companyId,
      overrides.accountKey ?? 'manual:2350',
      overrides.throughDate ?? '2026-12-31',
      overrides.storagePath ?? `documents/${companyId}/reconciliation/manual_2350/2026-12-31/${id}_kontoutdrag.pdf`,
      SHA,
      uploadedBy,
    ],
  )
  return id
}

describe('account_reconciliation_attachments RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertAttachment(companyId, userId)
    const stranger = await insertAuthUser()

    const ownerView = await withUserContext(userId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.account_reconciliation_attachments WHERE id = $1`, [rowId]),
    )
    expect(ownerView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.account_reconciliation_attachments WHERE id = $1`, [rowId]),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('lets viewers read but not attach', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertAttachment(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const viewerRead = await withUserContext(viewer, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.account_reconciliation_attachments WHERE id = $1`, [rowId]),
    )
    expect(viewerRead.rows).toHaveLength(1)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.account_reconciliation_attachments
             (company_id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, uploaded_by)
           VALUES ($1, 'manual:2350', '2026-12-31', 'x.pdf', 'application/pdf', 1, 'documents', $2, $3, $4)`,
          [companyId, `documents/${companyId}/reconciliation/manual_2350/2026-12-31/${randomUUID()}_x.pdf`, SHA, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets members attach as themselves but not as someone else', async () => {
    const { userId: owner, companyId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const inserted = await withUserContext(member, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO public.account_reconciliation_attachments
           (company_id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, uploaded_by)
         VALUES ($1, 'skattekonto', '2026-12-31', 'x.pdf', 'application/pdf', 1, 'documents', $2, $3, $4) RETURNING id`,
        [companyId, `documents/${companyId}/reconciliation/skattekonto/2026-12-31/${randomUUID()}_x.pdf`, SHA, member],
      ),
    )
    expect(inserted.rows).toHaveLength(1)

    await expect(
      withUserContext(member, (client) =>
        client.query(
          `INSERT INTO public.account_reconciliation_attachments
             (company_id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, uploaded_by)
           VALUES ($1, 'skattekonto', '2026-12-31', 'x.pdf', 'application/pdf', 1, 'documents', $2, $3, $4)`,
          [companyId, `documents/${companyId}/reconciliation/skattekonto/2026-12-31/${randomUUID()}_y.pdf`, SHA, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('has no DELETE policy and a no-delete trigger', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertAttachment(companyId, userId)

    // RLS: the statement runs but touches nothing.
    const asMember = await withUserContext(userId, (client) =>
      client.query(`DELETE FROM public.account_reconciliation_attachments WHERE id = $1`, [rowId]),
    )
    expect(asMember.rowCount).toBe(0)

    // Even the superuser cannot: BFL 7 kap. retention is enforced by trigger.
    await expect(
      getPool().query(`DELETE FROM public.account_reconciliation_attachments WHERE id = $1`, [rowId]),
    ).rejects.toThrow(/never deleted/i)
  })
})

describe('account_reconciliation_attachments append-only', () => {
  it('lets a member stamp removal once, and freezes everything else', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertAttachment(companyId, userId)

    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.account_reconciliation_attachments SET note = 'ändrad' WHERE id = $1`, [rowId]),
      ),
    ).rejects.toThrow(/append-only/i)

    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.account_reconciliation_attachments SET storage_path = 'documents/x' WHERE id = $1`, [rowId]),
      ),
    ).rejects.toThrow(/append-only/i)

    const stamped = await withUserContext(userId, (client) =>
      client.query<{ removed_at: string }>(
        `UPDATE public.account_reconciliation_attachments
           SET removed_at = NOW(), removed_by = $2, removed_reason = 'fel fil'
         WHERE id = $1 RETURNING removed_at`,
        [rowId, userId],
      ),
    )
    expect(stamped.rows).toHaveLength(1)

    // withUserContext rolls back; stamp for real (superuser) to test finality.
    await getPool().query(
      `UPDATE public.account_reconciliation_attachments
         SET removed_at = NOW(), removed_by = $2, removed_reason = 'fel fil'
       WHERE id = $1`,
      [rowId, userId],
    )

    // The stamp itself is final: no restore, no re-stamp.
    await expect(
      getPool().query(
        `UPDATE public.account_reconciliation_attachments SET removed_at = NULL, removed_by = NULL, removed_reason = NULL WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/cannot be restored/i)
  })

  it('rejects a malformed account_key, a bad hash, and a half removal stamp', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertAttachment(companyId, userId, { accountKey: '1930' })).rejects.toThrow(/account_key/i)
    await expect(
      getPool().query(
        `INSERT INTO public.account_reconciliation_attachments
           (company_id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, uploaded_by)
         VALUES ($1, 'skattekonto', '2026-12-31', 'x.pdf', 'application/pdf', 1, 'documents', $2, 'nothex', $3)`,
        [companyId, `documents/${companyId}/reconciliation/skattekonto/2026-12-31/${randomUUID()}_x.pdf`, userId],
      ),
    ).rejects.toThrow(/sha256/i)
    const rowId = await insertAttachment(companyId, userId)
    await expect(
      getPool().query(`UPDATE public.account_reconciliation_attachments SET removed_at = NOW() WHERE id = $1`, [rowId]),
    ).rejects.toThrow(/removal_pair/i)
  })

  it('refuses the same storage object twice', async () => {
    const { userId, companyId } = await seedCompany()
    const path = `documents/${companyId}/reconciliation/skattekonto/2026-12-31/${randomUUID()}_same.pdf`
    await insertAttachment(companyId, userId, { accountKey: 'skattekonto', storagePath: path })
    await expect(insertAttachment(companyId, userId, { accountKey: 'skattekonto', storagePath: path })).rejects.toThrow(/storage_path_unique|duplicate key/i)
  })
})
