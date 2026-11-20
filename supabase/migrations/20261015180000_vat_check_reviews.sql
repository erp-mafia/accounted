-- pg-test: covered-by tests/pg/vat-check-reviews.pg.test.ts
-- A person's review of one momsdeklaration WARNING for one VAT period
-- (crm#1171): "I have looked at this, it is right as booked", with who,
-- when, an optional note, and a fingerprint of the figures the finding was
-- computed from.
--
-- Why it exists: some findings of the momsdeklaration completeness checks
-- (src/lib/reports/vat-declaration-checks.ts, vat-filing-gate.ts) are
-- advisory by design. The clearest one is the per-verifikat RC_BASIS_MISSING
-- when the period's basis matches its fiktiv moms per momssats: the
-- declaration's rutor are consistent, but only a person can tell whether the
-- basis booked in another verifikat (a collective rättelseverifikat, say)
-- belongs to the flagged purchases. Such a warning kept nagging on every
-- read, in the web view and in gnubok_vat_close_check, with no way to record
-- that someone had checked it.
--
-- Rules the code holds (src/lib/vat/check-reviews.ts): only a WARNING is
-- reviewable, never an ERROR (an ERROR gates filing and is never hidden), and
-- a review applies only while the finding's fingerprint is unchanged, so new
-- or changed figures bring the warning back.
--
-- Keyed by the period's dates, not by year/period numbers, so a helårsmoms
-- period reached through its räkenskapsår id (web) and through the year it
-- ends in (MCP) is the same row.
--
-- Append-only: a review is a row with action 'reviewed', taking it back is a
-- row with action 'withdrawn', and the latest row per company, period and
-- check code is the state. Who reviewed what, and when, stays readable.
--
-- Also: pending_operations.operation_type takes mark_vat_check_reviewed, the
-- staged MCP tool gnubok_mark_vat_check_reviewed (a person approves it).
-- Expanded from the constraint's current definition (below), NOT VALID; the
-- VALIDATE runs in 20261015180100. Every later migration that rebuilds this
-- list keeps this value, or it drops it again
-- (tests/pg/pending-operations-op-type-audit.pg.test.ts catches that).

CREATE TABLE public.vat_check_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_type  text NOT NULL CHECK (period_type IN ('monthly', 'quarterly', 'yearly')),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  -- VatDeclarationCheck['code'], e.g. RC_BASIS_MISSING.
  check_code   text NOT NULL CHECK (check_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  action       text NOT NULL CHECK (action IN ('reviewed', 'withdrawn')),
  -- vatCheckFingerprint(): a versioned hash of the finding's inputs. Set on a review, empty on a withdrawal.
  fingerprint  text CHECK (fingerprint ~ '^v[0-9]+:[0-9a-f]{16}$'),
  note         text CHECK (note IS NULL OR char_length(note) <= 1000),
  -- web: the person marked it in the momsdeklaration view. agent: an agent
  -- staged gnubok_mark_vat_check_reviewed and this person approved it.
  source       text NOT NULL CHECK (source IN ('web', 'agent')),
  actor        uuid NOT NULL REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK ((action = 'reviewed') = (fingerprint IS NOT NULL))
);

COMMENT ON TABLE public.vat_check_reviews IS
  'A person''s review of one momsdeklaration WARNING for one VAT period, with a fingerprint of the figures it was computed from; append-only, the latest row per company, period and check code wins. Never applies to an ERROR.';
COMMENT ON COLUMN public.vat_check_reviews.fingerprint IS
  'vatCheckFingerprint() (src/lib/vat/check-reviews.ts) of the finding when it was reviewed: the review applies only while the current fingerprint is the same.';
COMMENT ON COLUMN public.vat_check_reviews.actor IS
  'The person who marked or withdrew the review: a web session, or the person who approved the staged gnubok_mark_vat_check_reviewed. Never an API key alone.';

CREATE INDEX vat_check_reviews_lookup
  ON public.vat_check_reviews (company_id, period_start, period_end, check_code, created_at DESC);

-- Behandlingshistorik: who accepted a VAT warning for a period, and when.
CREATE TRIGGER audit_vat_check_reviews
  AFTER INSERT OR DELETE ON public.vat_check_reviews
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

ALTER TABLE public.vat_check_reviews ENABLE ROW LEVEL SECURITY;

-- Members read their company's reviews; a writing member of the active
-- company records one in their own name. No update, no delete: a withdrawal
-- is a new row.
CREATE POLICY vat_check_reviews_select ON public.vat_check_reviews
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY vat_check_reviews_insert ON public.vat_check_reviews
  FOR INSERT WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND actor = auth.uid()
  );

GRANT SELECT, INSERT ON TABLE public.vat_check_reviews TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.vat_check_reviews TO service_role;
-- no-grant: anon on public.vat_check_reviews (company VAT review records; no public surface reads them)

-- The constraint's own current list plus this value, read from the catalog
-- rather than re-stated from a copy: a branch that adds its own value in
-- parallel keeps it, in whichever order the two migrations run.
DO $$
DECLARE
  v_types text[];
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  IF NOT ('mark_vat_check_reviewed' = ANY (v_types)) THEN
    v_types := v_types || 'mark_vat_check_reviewed'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
