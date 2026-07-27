import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

/**
 * WORM ratchet for the `documents` storage bucket, after
 * 20260727190000_drop_documents_bucket_delete_policy.sql.
 *
 * The bug this guards: production carried a `users_delete_own_documents`
 * policy (FOR DELETE TO authenticated, USING bucket_id = 'documents' AND
 * (storage.foldername(name))[2] = auth.uid()::text) that existed in no
 * migration file. It let the uploading user delete the storage bytes of any
 * document they had uploaded under the legacy `documents/{userId}/...`
 * layout, including documents linked to a posted verifikat: those are
 * rakenskapsinformation under the BFL 7 kap 2 § seven-year retention duty.
 *
 * The application-layer guard in deleteDocument() and the
 * block_document_deletion() trigger both protect the document_attachments
 * ROW, not the object, so neither one closes this. Deletion of a documents
 * object must stay a server-side, service-role code path.
 *
 * These assertions are name-agnostic on purpose: the hole arrived under a
 * name this repo never used, so pinning a name would not have caught it.
 */
describe('documents bucket: WORM (no client-side DELETE)', () => {
  const objectNames: string[] = []

  let owner: string
  let company: string
  let legacyKey: string
  let companyScopedKey: string

  async function seedObject(name: string): Promise<void> {
    await getPool().query(
      `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)`,
      [name],
    )
    objectNames.push(name)
  }

  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO storage.buckets (id, name, public)
       VALUES ('documents', 'documents', false)
       ON CONFLICT (id) DO NOTHING`,
    )

    // Real Supabase grants these to `authenticated`; the bare CI image may
    // not. Without the DELETE grant the deletion assertion below would pass
    // for the wrong reason (permission denied, not RLS).
    await getPool()
      .query(`GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated`)
      .catch(() => {})

    owner = await insertAuthUser()
    company = await insertCompany({ createdBy: owner, name: 'WORM Test AB' })
    await insertCompanyMember({ companyId: company, userId: owner, role: 'owner' })

    legacyKey = `documents/${owner}/1700000000100_kvitto.pdf`
    companyScopedKey = `documents/${company}/${owner}/1700000000101_kvitto.pdf`
    await seedObject(legacyKey)
    await seedObject(companyScopedKey)
  })

  afterAll(async () => {
    const sweep = (sql: string, params: unknown[]) =>
      getPool()
        .query(sql, params)
        .catch(() => {})

    if (objectNames.length > 0) {
      await sweep(`DELETE FROM storage.objects WHERE name = ANY($1::text[])`, [objectNames])
    }
    await sweep(`DELETE FROM public.company_members WHERE company_id = $1`, [company])
    await sweep(`DELETE FROM public.companies WHERE id = $1`, [company])
    await sweep(`DELETE FROM auth.users WHERE id = $1`, [owner])
  })

  it('no DELETE policy over the documents bucket exists, under any name', async () => {
    const res = await getPool().query<{ polname: string; qual: string | null }>(
      `SELECT polname, pg_get_expr(polqual, polrelid) AS qual
         FROM pg_policy
        WHERE polrelid = 'storage.objects'::regclass
          AND polcmd = 'd'`,
    )
    // receipts_delete is a different bucket and is intentionally deletable:
    // receipts are pre-bookkeeping scratch, not rakenskapsinformation.
    const overDocuments = res.rows.filter((r) => (r.qual ?? '').includes("bucket_id = 'documents'"))
    expect(overDocuments.map((r) => r.polname)).toEqual([])
  })

  it('no UPDATE policy over the documents bucket exists either', async () => {
    // An UPDATE policy would let a user repoint or overwrite an object in
    // place, which defeats the version chain just as thoroughly as a delete.
    const res = await getPool().query<{ polname: string; qual: string | null }>(
      `SELECT polname, pg_get_expr(polqual, polrelid) AS qual
         FROM pg_policy
        WHERE polrelid = 'storage.objects'::regclass
          AND polcmd = 'w'`,
    )
    const overDocuments = res.rows.filter((r) => (r.qual ?? '').includes("bucket_id = 'documents'"))
    expect(overDocuments.map((r) => r.polname)).toEqual([])
  })

  it('the uploader cannot delete their own legacy-layout object', async () => {
    // The exact production shape: [2] of `documents/{userId}/...` is the
    // uploader's auth.uid(), which is what the dropped policy matched on.
    await withUserContext(owner, async (client) => {
      const res = await client.query(
        `DELETE FROM storage.objects WHERE bucket_id = 'documents' AND name = $1`,
        [legacyKey],
      )
      // RLS filters the row out rather than raising: the DELETE reports
      // success having removed nothing. That silence is why the hole was
      // invisible from the application side.
      expect(res.rowCount).toBe(0)
    })

    const after = await getPool().query(
      `SELECT 1 FROM storage.objects WHERE bucket_id = 'documents' AND name = $1`,
      [legacyKey],
    )
    expect(after.rowCount).toBe(1)
  })

  it('a company member cannot delete a company-scoped object either', async () => {
    await withUserContext(owner, async (client) => {
      const res = await client.query(
        `DELETE FROM storage.objects WHERE bucket_id = 'documents' AND name = $1`,
        [companyScopedKey],
      )
      expect(res.rowCount).toBe(0)
    })

    const after = await getPool().query(
      `SELECT 1 FROM storage.objects WHERE bucket_id = 'documents' AND name = $1`,
      [companyScopedKey],
    )
    expect(after.rowCount).toBe(1)
  })
})
