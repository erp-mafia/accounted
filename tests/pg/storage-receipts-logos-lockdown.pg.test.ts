import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'

/**
 * Migration 20261102200354 (Google CASA 5.2.1, malicious file uploads):
 *  - the legacy `receipts` bucket goes private, loses its client INSERT and
 *    DELETE policies, and keeps its owner-only SELECT policy and its objects;
 *  - the public `logos` bucket stops accepting image/svg+xml.
 *
 * The receipts bucket and its policies exist only in production (made in the
 * dashboard), so a database built from migrations alone gives the migration
 * nothing to change. Each case therefore rebuilds production's pre-migration
 * state inside one transaction, runs the migration file over it and rolls
 * everything back, so no other suite sees the seeded bucket or policies.
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261102200354_close_receipts_bucket_and_svg_logos.sql'),
  'utf8',
)

// Production's three dashboard policies: authenticated, the caller's own uid folder.
const OWN_FOLDER = `bucket_id = 'receipts' AND (storage.foldername(name))[1] = auth.uid()::text`

interface Production {
  client: PoolClient
  ownerId: string
  receiptKey: string
  svgLogoKey: string
}

async function withProduction(
  { migrate }: { migrate: boolean },
  fn: (p: Production) => Promise<void>,
): Promise<void> {
  const ownerId = randomUUID()
  const receiptKey = `${ownerId}/kvitto-2026-02-26.jpg`
  const svgLogoKey = `${randomUUID()}/logo-1700000000000.svg`
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
       VALUES ('receipts', 'receipts', true, 10485760,
               ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
       ON CONFLICT (id) DO UPDATE SET public = true`,
    )
    await client.query(
      `INSERT INTO storage.buckets (id, name, public, allowed_mime_types)
       VALUES ('logos', 'logos', true, ARRAY['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'])
       ON CONFLICT (id) DO UPDATE
         SET public = true,
             allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']`,
    )
    for (const name of ['receipts_select', 'receipts_insert', 'receipts_delete']) {
      await client.query(`DROP POLICY IF EXISTS ${name} ON storage.objects`)
    }
    await client.query(
      `CREATE POLICY receipts_select ON storage.objects FOR SELECT TO authenticated USING (${OWN_FOLDER})`,
    )
    await client.query(
      `CREATE POLICY receipts_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (${OWN_FOLDER})`,
    )
    await client.query(
      `CREATE POLICY receipts_delete ON storage.objects FOR DELETE TO authenticated USING (${OWN_FOLDER})`,
    )
    // Real Supabase grants these to `authenticated`; the bare CI image may
    // not. Without them a refused write would pass for the wrong reason
    // (permission denied, not RLS).
    await client.query(`GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated`)
    // owner is stamped by storage-api in production and references auth.users.
    await client.query(
      `INSERT INTO auth.users (id, email, instance_id)
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [ownerId, `pg-real-${ownerId}@test.invalid`],
    )
    await client.query(
      `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('receipts', $1, $2)`,
      [receiptKey, ownerId],
    )
    await client.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('logos', $1)`, [svgLogoKey])

    if (migrate) await client.query(MIGRATION_SQL)

    await fn({ client, ownerId, receiptKey, svgLogoKey })
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

/** Runs fn as an authenticated user, then undoes whatever it did and drops back to the superuser. */
async function asUser<T>(client: PoolClient, userId: string, fn: () => Promise<T>): Promise<T> {
  await client.query('SAVEPOINT as_user')
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const uid = await client.query<{ uid: string | null }>(`SELECT auth.uid()::text AS uid`)
    expect(uid.rows[0]?.uid).toBe(userId)
    return await fn()
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT as_user')
    await client.query('RELEASE SAVEPOINT as_user')
  }
}

function upload(client: PoolClient, ownerId: string) {
  return client.query(`INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('receipts', $1, $2)`, [
    `${ownerId}/new-upload.pdf`,
    ownerId,
  ])
}

describe('storage lockdown for CASA 5.2.1 (pg)', () => {
  describe('receipts bucket', () => {
    it('lets the owner upload before the migration, so the refusal below is not vacuous', async () => {
      await withProduction({ migrate: false }, async ({ client, ownerId }) => {
        const res = await asUser(client, ownerId, () => upload(client, ownerId))
        expect(res.rowCount).toBe(1)
      })
    })

    it('is private after the migration and keeps the objects it holds', async () => {
      await withProduction({ migrate: true }, async ({ client, receiptKey }) => {
        const bucket = await client.query<{ public: boolean }>(
          `SELECT public FROM storage.buckets WHERE id = 'receipts'`,
        )
        expect(bucket.rows[0]?.public).toBe(false)

        const kept = await client.query(
          `SELECT 1 FROM storage.objects WHERE bucket_id = 'receipts' AND name = $1`,
          [receiptKey],
        )
        expect(kept.rowCount).toBe(1)
      })
    })

    it('refuses an upload from an authenticated user, even into their own folder', async () => {
      await withProduction({ migrate: true }, async ({ client, ownerId }) => {
        await expect(asUser(client, ownerId, () => upload(client, ownerId))).rejects.toThrow(
          /row-level security/i,
        )
      })
    })

    it('still lets the owner read their own file, and nobody else', async () => {
      await withProduction({ migrate: true }, async ({ client, ownerId, receiptKey }) => {
        const readReceipts = () =>
          client.query<{ name: string }>(`SELECT name FROM storage.objects WHERE bucket_id = 'receipts'`)

        const own = await asUser(client, ownerId, readReceipts)
        expect(own.rows.map((r) => r.name)).toEqual([receiptKey])

        const stranger = await asUser(client, randomUUID(), readReceipts)
        expect(stranger.rows).toHaveLength(0)
      })
    })

    it('refuses a delete from the owner, so the retained objects stay', async () => {
      await withProduction({ migrate: true }, async ({ client, ownerId, receiptKey }) => {
        const res = await asUser(client, ownerId, () =>
          client.query(`DELETE FROM storage.objects WHERE bucket_id = 'receipts' AND name = $1`, [receiptKey]),
        )
        expect(res.rowCount).toBe(0)
      })
    })

    it('keeps receipts_select and drops receipts_insert and receipts_delete', async () => {
      await withProduction({ migrate: true }, async ({ client }) => {
        const res = await client.query<{ polname: string }>(
          `SELECT polname FROM pg_policy
            WHERE polrelid = 'storage.objects'::regclass AND polname LIKE 'receipts\\_%'
            ORDER BY polname`,
        )
        expect(res.rows.map((r) => r.polname)).toEqual(['receipts_select'])
      })
    })
  })

  describe('logos bucket', () => {
    it('stops accepting SVG, stays public and leaves stored SVG objects alone', async () => {
      await withProduction({ migrate: true }, async ({ client, svgLogoKey }) => {
        const bucket = await client.query<{ public: boolean; allowed_mime_types: string[] }>(
          `SELECT public, allowed_mime_types FROM storage.buckets WHERE id = 'logos'`,
        )
        expect(bucket.rows[0]?.public).toBe(true)
        expect(bucket.rows[0]?.allowed_mime_types).toEqual(['image/png', 'image/jpeg', 'image/webp'])

        const kept = await client.query(`SELECT 1 FROM storage.objects WHERE bucket_id = 'logos' AND name = $1`, [
          svgLogoKey,
        ])
        expect(kept.rowCount).toBe(1)
      })
    })

    it('has no image/svg+xml in its allowlist in a database built from migrations', async () => {
      const res = await getPool().query<{ allowed_mime_types: string[] }>(
        `SELECT allowed_mime_types FROM storage.buckets WHERE id = 'logos'`,
      )
      expect(res.rows[0]?.allowed_mime_types).toBeDefined()
      expect(res.rows[0]?.allowed_mime_types).not.toContain('image/svg+xml')
    })
  })
})
