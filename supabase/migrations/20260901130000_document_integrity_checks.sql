-- Document integrity ledger: move the WORM verification stamp OFF
-- document_attachments.
--
-- The nightly cron (app/api/documents/verify/cron/route.ts, "0 3 * * *" in
-- vercel.json) recorded every check by UPDATEing
-- document_attachments.last_integrity_check_at. That UPDATE runs through
-- enforce_period_lock_documents() (migration 20240101000017), which is
-- BEFORE INSERT OR UPDATE FOR EACH ROW with no WHEN clause and no OLD/NEW
-- comparison: it raises for ANY update of a document whose journal entry sits
-- in a closed or locked fiscal period, even when the entry link is untouched.
-- Because the queue ordered by last_integrity_check_at ASC NULLS FIRST, every
-- rejected row sorted straight back to the head of the queue the next night.
-- Measured on prod 2026-09-01: the whole batch was 200 of 200 rejected, 24 095
-- of 34 569 current-version documents had never been verified, and the newest
-- successful stamp was 2026-08-31 03:00. Both call sites discarded the update
-- error, so nothing logged and the control had been dead for weeks.
--
-- Migration 017's enforcement triggers are legally required and are never
-- touched (CLAUDE.md), so the fix is to stop writing to document_attachments
-- at all: the outcome of each verification becomes a row in its own
-- append-only ledger and the trigger leaves the write path entirely.
--
-- document_attachments.last_integrity_check_at is deliberately LEFT IN PLACE
-- and is now legacy: lib/core/documents/document-service.ts still selects it
-- and historical rows carry real values. Nothing writes it any more. Its index
-- does go (section 6): the column keeps its history, the index served only the
-- query this migration retires.
--
-- The new table is classified in lib/reports/full-archive-export.ts as
-- deliberately outside the säkerhetsbackup. It is verification metadata ABOUT
-- räkenskapsinformation, not räkenskapsinformation itself, and the checks that
-- carry legal weight (the failures) already reach the archive through
-- audit_log as INTEGRITY_FAILURE.

-- =============================================================
-- 1. The ledger
-- =============================================================

CREATE TABLE public.document_integrity_checks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What the check compared. expected_sha256 is the hash recorded on the
  -- document at upload; computed_sha256 is what re-hashing the stored object
  -- produced, and is NULL when the object could not be downloaded at all.
  expected_sha256 TEXT NOT NULL,
  computed_sha256 TEXT,
  -- The storage key that was actually read. Kept on the row because the
  -- cron falls back to the company-scoped layout when the stored pointer is
  -- stale, so "which object did we hash" is not derivable afterwards.
  storage_path    TEXT NOT NULL,
  result          TEXT NOT NULL CHECK (result IN ('passed', 'hash_mismatch', 'object_missing')),
  -- Human-readable detail for the failing results (download error, the two
  -- hashes). NULL on a pass.
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at: append-only table.
);

-- =============================================================
-- 2. Row-level security
-- =============================================================
--
-- Same shape as processing_history (20260418130000) and audit_log: a
-- company-scoped SELECT policy through user_company_ids(), and no
-- INSERT/UPDATE/DELETE policies at all, so only the service-role cron can
-- append. Service-role-only-with-no-policies (the connector_* ledgers) was the
-- other candidate and was rejected: this ledger is the evidence a company
-- shows that its verifikat archive is actually being verified, so the tenant
-- must be able to read its own rows. Nobody, tenant included, may write them.

ALTER TABLE public.document_integrity_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_integrity_checks_select" ON public.document_integrity_checks
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- Defense in depth on top of RLS, the same lockdown exchange_rates got in
-- 20260710100000, but stated explicitly instead of leaning on Supabase's
-- default privileges (which hand anon and authenticated full DML on every new
-- public table): a company member reads, the cron appends, nobody else has the
-- privilege at all. service_role gets no UPDATE or DELETE either, since the
-- ledger is append-only; the ON DELETE CASCADE above still fires, because a
-- referential action runs with the constraint owner's rights, not the
-- caller's.
REVOKE ALL ON public.document_integrity_checks FROM anon, authenticated, service_role;
GRANT SELECT ON public.document_integrity_checks TO authenticated;
GRANT SELECT, INSERT ON public.document_integrity_checks TO service_role;

-- =============================================================
-- 3. Indexes
-- =============================================================

-- The cron's queue. next_documents_for_integrity_check() orders by the most
-- recent check per document, and that timestamp lives in THIS table, so no
-- index on document_attachments can drive the ordering. The plan is instead a
-- scan of the current-version documents, one index probe per document into the
-- index below, and a top-N heapsort of p_limit rows: measured against prod on
-- 2026-09-01, ~34.6k rows scanned in 42 ms end to end. The
-- (document_id, checked_at DESC) column order is exactly the lateral's
-- "WHERE document_id = ? ORDER BY checked_at DESC LIMIT 1", so each probe is
-- an index-only scan of one entry.
CREATE INDEX idx_document_integrity_checks_document
  ON public.document_integrity_checks (document_id, checked_at DESC);

-- Tenant-facing read: "show me this company's integrity checks, newest first".
-- Matches the SELECT policy's company_id filter.
CREATE INDEX idx_document_integrity_checks_company
  ON public.document_integrity_checks (company_id, checked_at DESC);

-- =============================================================
-- 4. Immutability
-- =============================================================
-- Own one-line function rather than the shared audit_log_immutable(): reusing
-- it works, but it raises "Audit log entries cannot be modified or deleted"
-- from a table that is not the audit log, and that message is already
-- pattern-matched as an audit-log signal elsewhere in the app
-- (app/api/transactions/[id]/route.ts). A per-ledger function is the house
-- pattern for exactly this reason: skatteverket_api_audit_log (20260517135000)
-- and company_migration_resets (20260818084050) each carry their own. It also
-- decouples this table from a shared function that keeps being amended for
-- sandbox teardown.
--
-- UPDATE only, not DELETE: the FKs above cascade when a company or a document
-- is legally deleted after its retention window, and a BEFORE DELETE trigger
-- would block that cascade.

-- SECURITY INVOKER (the default), like audit_log_immutable(): the body only
-- raises, so it reads and writes nothing that definer rights could reach.
CREATE OR REPLACE FUNCTION public.document_integrity_check_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Document integrity check entries cannot be modified or deleted';
END;
$$;

CREATE TRIGGER document_integrity_checks_no_update
  BEFORE UPDATE ON public.document_integrity_checks
  FOR EACH ROW EXECUTE FUNCTION public.document_integrity_check_immutable();

-- =============================================================
-- 5. Queue for the nightly cron
-- =============================================================
--
-- Least-recently-verified first, never-verified before that. The tie-break on
-- created_at is free: the ordering key is a column of the joined table, so the
-- sort cannot be index-driven either way, and adding the second key costs
-- nothing while turning an arbitrary heap-order queue into a deterministic
-- FIFO drain. Heap order is precisely what let the same 200 rows occupy the
-- head of the old queue every single night.

CREATE OR REPLACE FUNCTION public.next_documents_for_integrity_check(
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  id              uuid,
  user_id         uuid,
  company_id      uuid,
  storage_path    text,
  sha256_hash     text,
  file_name       text,
  last_checked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    d.id,
    d.user_id,
    d.company_id,
    d.storage_path,
    d.sha256_hash,
    d.file_name,
    last_check.checked_at
  FROM public.document_attachments d
  LEFT JOIN LATERAL (
    SELECT c.checked_at
    FROM public.document_integrity_checks c
    WHERE c.document_id = d.id
    ORDER BY c.checked_at DESC
    LIMIT 1
  ) last_check ON true
  WHERE d.is_current_version = true
  ORDER BY last_check.checked_at ASC NULLS FIRST, d.created_at ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
$$;

-- The cron is the only caller and runs as the service role, which bypasses
-- RLS; nothing else has any business enumerating every tenant's documents.
REVOKE ALL ON FUNCTION public.next_documents_for_integrity_check(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_documents_for_integrity_check(integer) TO service_role;

COMMENT ON TABLE public.document_integrity_checks IS
  'Append-only outcome of each WORM archive integrity check (SHA-256 recompute) on document_attachments. Written only by the nightly cron under the service role; readable by the owning company. Replaces document_attachments.last_integrity_check_at, whose UPDATE was rejected by enforce_period_lock_documents() for every document linked to a closed/locked period.';

COMMENT ON COLUMN public.document_attachments.last_integrity_check_at IS
  'LEGACY. Superseded by public.document_integrity_checks (20260901130000). Historical values only: nothing writes this column any more, because any UPDATE of a document linked to an entry in a closed/locked period is rejected by enforce_period_lock_documents().';

-- =============================================================
-- 6. Retire the index that served the old queue
-- =============================================================
--
-- idx_document_attachments_integrity_check (20260330120000) is
-- (last_integrity_check_at ASC NULLS FIRST) WHERE is_current_version = true.
-- It existed for exactly one query, the old cron's ORDER BY, and that query no
-- longer exists: the new queue orders by a column in ANOTHER table, so no index
-- on document_attachments can drive it. Prod on 2026-09-01 shows the shape
-- precisely: 152 scans since the index was created in March (one per nightly
-- run) against 3.8 M on idx_document_attachments_journal_entry_id, and 616 kB
-- kept up to date on every insert and update of the busiest document table for
-- reads that are now zero. It does not survive as a filter for the new queue
-- either: EXPLAIN on prod for the new outer scan (is_current_version = true
-- over 34.6k rows) picks a Seq Scan, not this partial index.
--
-- Dropped rather than kept "just in case": the column it indexes is frozen, so
-- the index can never become useful again without a new migration that also
-- resurrects the writer. Nothing else in the repo names it (checked), so the
-- only cost is a moment's ACCESS EXCLUSIVE lock on a 34.6k-row table. Plain
-- DROP INDEX, not CONCURRENTLY: migrations run inside a transaction, which
-- CONCURRENTLY forbids, and dropping needs the lock rather than a rebuild.
-- Between this migration and the deploy that follows it, the old cron code
-- degrades to a sequential scan of 34.6k rows once a night, which is
-- irrelevant, and it was rejecting 200 of 200 writes anyway.

DROP INDEX IF EXISTS public.idx_document_attachments_integrity_check;

-- =============================================================
-- 7. Schema reload
-- =============================================================

NOTIFY pgrst, 'reload schema';
