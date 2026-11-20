-- Every agent proposal has a number that stays.
--
-- A proposal (a pending_operations row) is named by its uuid, or in the
-- review by its place in the queue ("3 av 12"), which moves as proposals are
-- approved. An accountant asked for a number per proposal, to tell apart the
-- ones that look alike. operation_number is that: per company, counting up
-- in creation order, assigned by the database at insert and frozen from then
-- on, so a person and an agent can name the same proposal. Rows are still
-- found by id.
--
-- Why a column and a counter. Nothing stable can be derived: the rank by
-- (created_at, id) shifts when a transaction that began earlier commits
-- later (created_at is the transaction's start), and when a row is deleted.
-- The counter is voucher_sequences' shape (20240101000016): one row per
-- company, bumped by INSERT ... ON CONFLICT DO UPDATE ... RETURNING. The row
-- lock orders concurrent stagings of one company, a statement that stages
-- many rows bumps it once per row, a rolled-back staging gives its number
-- back, and a number is never handed out twice, also after a row is deleted.
-- It is bumped by a BEFORE INSERT trigger, not by the callers: proposals are
-- inserted through six doors (the MCP staging helper, v1 stage mode, the
-- reminder and collections runs, kvittojakten, a suggestion's RPC, the in-app
-- chat), and whatever a caller sends as operation_number is overwritten.
--
-- Existing rows. Each proposal's number is its place among all of its
-- company's proposals in creation order (ties on created_at by id), and the
-- counter starts at the company's row count, kept as existing_count. This
-- migration writes that number on the proposals that still wait (pending,
-- committing). It does NOT write it on the ones already decided:
-- pending_operations_immutability (20261109170400) refuses every UPDATE of a
-- decided row, citing BFL 7 kap., and this migration does not switch that
-- trigger off for a backfill. Their places stay free (numbers 1 to
-- existing_count belong to the proposals that existed here), so a later
-- migration can write exactly those numbers and nothing is renumbered. Until
-- then a proposal decided before today reads without a number, which the
-- code shows as no label at all.
--
-- Triggers that fire on the UPDATE of the waiting rows:
--   * pending_operations_updated_at would stamp now() on every waiting row,
--     and the stuck-approval sweep reads updated_at of a committing row
--     (lib/pending-operations/recover-stuck-committing.ts). It is switched
--     off around the one statement, inside the DO block, so the switch-off
--     and the switch-on commit or roll back together however the file is run
--     (one transaction under `supabase db push`, one statement at a time
--     under psql).
--   * pending_operations_input_frozen passes (params, operation_type and
--     preview_data are not in the SET list). It learns operation_number after
--     the backfill, further down.
--   * pending_operations_immutability passes: no decided row is touched.
--   * pending_operations_sync_suggestion is AFTER UPDATE OF status: not fired.
-- Companies archived by a migration reset are left as they are
-- (.claude/rules/database.md, rule 9).
--
-- Locks and run time. The ALTER takes ACCESS EXCLUSIVE and `supabase db push`
-- runs the file in one transaction, so the table is locked until the commit,
-- for: one sequential read of the heap to rank every row, the UPDATE of the
-- waiting rows by primary key (a small part of the table: most proposals
-- are already decided), one more read to count each company's rows, and
-- the partial unique index (a third read, indexing the waiting rows only).
-- Expected a few seconds in all. The ranking reads the heap through a
-- MATERIALIZED CTE: left to itself the planner walks
-- idx_pending_ops_actor_type for the company order, which is mostly random
-- reads and many times slower than the sequential read. lock_timeout
-- fails the job instead of queueing every staging and approval behind it;
-- the next pipeline retries.
--
-- Deploy order: safe either way. When this runs before the code that shows
-- the number is live, the code that is live keeps working: it never names the
-- column, its inserts are numbered by the trigger, and every UPDATE it makes
-- names its fields (status, resolved_at, result_data, the rejection fields,
-- agent_metadata), never a whole row. When the code is live first, it reads
-- the number only where the row is read with every column, or falls back on
-- 42703, and shows nothing while there is no number
-- (lib/pending-operations/operation-number.ts).
--
-- pg-test: tests/pg/pending-operation-number.pg.test.ts (the counter under
--   concurrent and multi-row inserts, per company, frozen, RLS), and
--   tests/pg/upgrade/ (the backfill on rows that exist).

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. The column
-- =============================================================================

ALTER TABLE public.pending_operations
  ADD COLUMN IF NOT EXISTS operation_number integer;

COMMENT ON COLUMN public.pending_operations.operation_number IS
  'The proposal''s number in its company ("Förslag 128"): counts up per company in creation order, assigned at insert by assign_pending_operation_number() and frozen from then on. NULL on a proposal decided before 20261117192101. Rows are found by id; the number is for people and agents to name a proposal.';

-- =============================================================================
-- 2. The counter: one row per company
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pending_operation_sequences (
  company_id     uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  last_number    integer NOT NULL CHECK (last_number >= 0),
  existing_count integer NOT NULL DEFAULT 0 CHECK (existing_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pending_operation_sequences IS
  'The last operation_number handed out per company. Written only by assign_pending_operation_number(), the BEFORE INSERT trigger on pending_operations, and by 20261117192101.';
COMMENT ON COLUMN public.pending_operation_sequences.existing_count IS
  'How many proposals the company had when numbering began (20261117192101). Numbers 1 to existing_count are their places in creation order: the ones still waiting then carry theirs, the ones already decided carry none. The trigger hands out the numbers above it. 0 for a company with no proposal then.';

ALTER TABLE public.pending_operation_sequences ENABLE ROW LEVEL SECURITY;

-- No policy: the trigger function is SECURITY DEFINER, so the role that
-- stages needs nothing here. The service role gets what it has on every
-- company table (company removal and support read as it); the app never
-- writes the counter itself.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pending_operation_sequences TO service_role;
-- no-grant: authenticated on public.pending_operation_sequences (internal counter: written by the SECURITY DEFINER trigger on pending_operations, never read through the API)

DROP TRIGGER IF EXISTS set_updated_at_pending_operation_sequences ON public.pending_operation_sequences;
CREATE TRIGGER set_updated_at_pending_operation_sequences
  BEFORE UPDATE ON public.pending_operation_sequences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 3. The number at insert
-- =============================================================================

-- SECURITY DEFINER: the in-app chat stages as the signed-in member
-- (pending_operations_chat_insert), who has no access to the counter. A row
-- without a company is left to the table's own NOT NULL to refuse.
CREATE OR REPLACE FUNCTION public.assign_pending_operation_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.pending_operation_sequences AS s (company_id, last_number)
  VALUES (NEW.company_id, 1)
  ON CONFLICT (company_id) DO UPDATE SET last_number = s.last_number + 1
  RETURNING s.last_number INTO NEW.operation_number;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_pending_operation_number() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 4. Existing rows, the counter's start and the trigger, as one step
-- =============================================================================

-- One statement, so nothing is staged between the ranking, the count and the
-- trigger: a row staged in between would take a number the count had not seen.
DO $$
BEGIN
  LOCK TABLE public.pending_operations IN SHARE ROW EXCLUSIVE MODE;

  ALTER TABLE public.pending_operations DISABLE TRIGGER pending_operations_updated_at;

  WITH every_row AS MATERIALIZED (
    SELECT o.id, o.company_id, o.status, o.created_at FROM public.pending_operations o
  ),
  ranked AS (
    SELECT r.id, r.status,
           (row_number() OVER (PARTITION BY r.company_id ORDER BY r.created_at, r.id))::integer AS place
      FROM every_row r
  )
  UPDATE public.pending_operations p
     SET operation_number = ranked.place
    FROM ranked
   WHERE p.id = ranked.id
     AND ranked.status IN ('pending', 'committing')
     AND p.status IN ('pending', 'committing')
     AND p.operation_number IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.company_migration_resets m WHERE m.source_company_id = p.company_id
     );

  ALTER TABLE public.pending_operations ENABLE TRIGGER pending_operations_updated_at;

  -- The next proposal of a company comes after every one it has, numbered or
  -- not. A second run keeps the counter where the trigger has taken it.
  INSERT INTO public.pending_operation_sequences (company_id, last_number, existing_count)
  SELECT o.company_id, count(*)::integer, count(*)::integer
    FROM public.pending_operations o
   GROUP BY o.company_id
  ON CONFLICT (company_id) DO NOTHING;

  DROP TRIGGER IF EXISTS pending_operations_assign_number ON public.pending_operations;
  CREATE TRIGGER pending_operations_assign_number
    BEFORE INSERT ON public.pending_operations
    FOR EACH ROW EXECUTE FUNCTION public.assign_pending_operation_number();
END;
$$;

-- =============================================================================
-- 5. The number is frozen with the rest of what is fixed at insert
-- =============================================================================

-- enforce_pending_operations_input_frozen as 20260504100000 defined it, with
-- operation_number added. After the backfill, which sets it once.
CREATE OR REPLACE FUNCTION public.enforce_pending_operations_input_frozen()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.params IS DISTINCT FROM OLD.params THEN
    RAISE EXCEPTION
      'pending_operations.params is frozen after insert (BFL 7 kap. underlag-immutability)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.operation_type IS DISTINCT FROM OLD.operation_type THEN
    RAISE EXCEPTION
      'pending_operations.operation_type is frozen after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.preview_data IS DISTINCT FROM OLD.preview_data THEN
    RAISE EXCEPTION
      'pending_operations.preview_data is frozen after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.operation_number IS DISTINCT FROM OLD.operation_number THEN
    RAISE EXCEPTION
      'pending_operations.operation_number is frozen after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 6. One number per company, and the lookup by number
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS pending_operations_company_operation_number_uniq
  ON public.pending_operations (company_id, operation_number)
  WHERE operation_number IS NOT NULL;

NOTIFY pgrst, 'reload schema';
