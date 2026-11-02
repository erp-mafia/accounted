-- Close the legacy public `receipts` storage bucket and stop SVG uploads to
-- the public `logos` bucket (Google CASA 5.2.1, malicious file uploads).
-- pg-test: covered-by tests/pg/storage-receipts-logos-lockdown.pg.test.ts
--
-- receipts
--
-- The bucket and its three policies on storage.objects (receipts_select,
-- receipts_insert, receipts_delete: authenticated, the caller's own uid
-- folder) were made in the dashboard, never in a migration; 20260710102000
-- already dropped its anonymous read policy. No code uses the bucket: there is
-- no storage.from('receipts') and no public or signed URL against it
-- (public.receipts, the table, is a different object and is not touched here).
-- Production holds 2 objects from 2026-02. They stay: documents are never
-- deleted (7-year retention).
--
--   * public = false: the objects are no longer served on an unauthenticated
--     /object/public/receipts/... URL.
--   * receipts_insert dropped: no client can add a file. It was the last
--     client upload path into a bucket nothing reads.
--   * receipts_delete dropped: no code needs it, and it was the one way the
--     retained objects could still be removed from a browser session. Removal,
--     if ever needed, stays a service-role decision.
--   * receipts_select kept: the owner can still fetch their own files through
--     an authenticated request (/object/authenticated/..., or a signed URL), so
--     nothing already stored becomes unreachable to the person who stored it.
--
-- logos
--
-- The bucket stays public by design: logos render on invoices and on the
-- public invoice page. Its MIME allowlist still carried image/svg+xml from
-- 20260420120000, while every writer (src/app/api/settings/logo,
-- src/app/api/byra/brand/logo and the vendor-logos cron) already stores PNG,
-- JPEG or WebP only, decided by magic bytes. An SVG is a script-capable
-- document on a public URL, so the bucket now refuses it too and its allowlist
-- matches the routes'. The limit applies to new uploads only: the SVG objects
-- already stored are not touched.
--
-- Every statement is a no-op where its bucket or policy does not exist
-- (databases built from migrations alone have no receipts bucket).

UPDATE storage.buckets
SET public = false
WHERE id = 'receipts';

DROP POLICY IF EXISTS "receipts_insert" ON storage.objects;
DROP POLICY IF EXISTS "receipts_delete" ON storage.objects;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp']
WHERE id = 'logos';
