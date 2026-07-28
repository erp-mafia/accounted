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
    // owner is populated deliberately: storage-api stamps the uploader there
    // in production, and an owner-based policy (`USING (auth.uid() = owner)`,
    // Supabase's stock delete template) matches nothing when it is NULL. A
    // fixture without an owner would let that policy shape pass this suite by
    // comparing against NULL rather than by being absent.
    await getPool().query(
      `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', $1, $2)`,
      [name, owner],
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

  /**
   * Every policy on storage.objects that can destroy or rewrite an object and
   * is not demonstrably scoped away from the documents bucket, with both its
   * USING and WITH CHECK expressions and its grantee roles.
   *
   * polcmd '*' (FOR ALL) is included deliberately: it grants DELETE and
   * UPDATE just as effectively as 'd' and 'w', and it is the shape the one
   * legitimate policy here (service_role_all_documents) already uses, so a
   * hostile FOR ALL policy would look unremarkable in the catalogue.
   *
   * WITH CHECK is read as well as USING: an UPDATE policy can carry its
   * bucket restriction in either, and a policy whose USING is permissive
   * would be invisible to a polqual-only check.
   */
  async function destructivePoliciesOverDocuments(): Promise<string[]> {
    const res = await getPool().query<{
      polname: string
      cmd: string
      expr: string
      roles: string[]
    }>(
      `SELECT p.polname,
              p.polcmd::text AS cmd,
              coalesce(pg_get_expr(p.polqual, p.polrelid), '')
                || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr,
              -- ::text is load-bearing: rolname is of type name, and
              -- node-postgres hands back a raw "{authenticated}" string for a
              -- name[] column instead of parsing it into a JS array.
              ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY (p.polroles)) AS roles
         FROM pg_policy p
        WHERE p.polrelid = 'storage.objects'::regclass
          AND p.polcmd IN ('d', 'w', '*')`,
    )

    return res.rows
      .filter((r) => {
        // In scope unless the policy provably cannot reach this bucket. Only
        // a bucket_id predicate naming some OTHER bucket exempts it: an
        // expression that never mentions bucket_id covers every bucket,
        // documents included. That is exactly Supabase's stock "Enable delete
        // for users based on user_id" template, `USING (auth.uid() = owner)`,
        // which carries no bucket clause at all, so gating on the bucket name
        // alone would wave through the widest possible hole.
        //
        // The bucket check is a substring rather than the exact
        // `bucket_id = 'documents'` shape pg_get_expr emits today, since
        // `bucket_id::text = 'documents'` or a reversed comparison would slip
        // past a stricter match. For a WORM ratchet a false alarm is cheap and
        // a silent hole is not.
        if (!r.expr.includes('documents') && r.expr.includes('bucket_id')) return false
        // An empty role array means the policy is granted to PUBLIC (oid 0
        // has no pg_roles row), which is the most permissive case there is,
        // so it must NOT be read as "no client roles".
        if (r.roles.length === 0) return true
        // service_role bypasses RLS anyway and is how the application does
        // its authorized deletes; every other grantee is client-reachable.
        return r.roles.some((role) => role !== 'service_role')
      })
      .map((r) => `${r.polname} (${r.cmd})`)
  }

  it('no client-reachable DELETE, UPDATE or FOR ALL policy covers the documents bucket', async () => {
    // receipts_delete is a different bucket and is intentionally deletable:
    // receipts are pre-bookkeeping scratch, not rakenskapsinformation. An
    // UPDATE policy would be as damaging as a DELETE one: it lets a user
    // rewrite an object in place, defeating the version chain.
    expect(await destructivePoliciesOverDocuments()).toEqual([])
  })

  it('the ratchet sees a FOR ALL policy, which is how the real hole could return', async () => {
    // Proves the assertion above is not vacuous. The dropped policy was
    // FOR DELETE, but nothing stops the next dashboard edit from being
    // FOR ALL, and that is the shape a polcmd IN ('d','w') check misses.
    await getPool().query(
      `CREATE POLICY worm_ratchet_probe ON storage.objects
         FOR ALL TO authenticated
         USING (bucket_id = 'documents')
         WITH CHECK (bucket_id = 'documents')`,
    )
    try {
      expect(await destructivePoliciesOverDocuments()).toEqual(['worm_ratchet_probe (*)'])
    } finally {
      await getPool().query(`DROP POLICY IF EXISTS worm_ratchet_probe ON storage.objects`)
    }
    // ... and the catalogue is clean again once the probe is gone.
    expect(await destructivePoliciesOverDocuments()).toEqual([])
  })

  it('the ratchet sees a bucketless policy, which covers documents by omission', async () => {
    // Supabase's stock "Enable delete for users based on user_id" template is
    // `USING (auth.uid() = owner)` with no bucket clause, so it grants delete
    // over EVERY bucket. Naming no bucket must not read as naming a safe one.
    await getPool().query(
      `CREATE POLICY worm_ratchet_bucketless ON storage.objects
         FOR DELETE TO authenticated
         USING (auth.uid() = owner)`,
    )
    try {
      expect(await destructivePoliciesOverDocuments()).toEqual([
        'worm_ratchet_bucketless (d)',
      ])

      // And it is not merely reported: it really would let the uploader
      // destroy their own rakenskapsinformation, which is why the catalogue
      // assertion has to catch it.
      await withUserContext(owner, async (client) => {
        const res = await client.query(
          `DELETE FROM storage.objects WHERE bucket_id = 'documents' AND name = $1`,
          [legacyKey],
        )
        expect(res.rowCount).toBe(1)
      })
    } finally {
      await getPool().query(`DROP POLICY IF EXISTS worm_ratchet_bucketless ON storage.objects`)
    }
    expect(await destructivePoliciesOverDocuments()).toEqual([])
  })

  it('a policy scoped to another bucket is not flagged', async () => {
    // The counterweight to the rule above: receipts_delete is real, lives in
    // migration 20260710102000, and must not trip this ratchet. A ratchet
    // that cries wolf on unrelated buckets gets switched off.
    await getPool().query(
      `CREATE POLICY worm_ratchet_other_bucket ON storage.objects
         FOR DELETE TO authenticated
         USING (bucket_id = 'sie-files')`,
    )
    try {
      expect(await destructivePoliciesOverDocuments()).toEqual([])
    } finally {
      await getPool().query(`DROP POLICY IF EXISTS worm_ratchet_other_bucket ON storage.objects`)
    }
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
