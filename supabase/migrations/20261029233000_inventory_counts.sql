-- =============================================================================
-- Year-end stock count (varulagerinventering), LIV 1955:257 1-3 §
-- pg-test: covered-by tests/pg/inventory-counts.pg.test.ts
--
-- Every bokföringsskyldig with a varulager counts each item on balansdagen
-- (or before it, rolled forward to it), lists it valued at the lower of cost
-- and net realisable value (ÅRL 4:9, IL 17 kap) and signs the list "på heder
-- och samvete". The list is räkenskapsinformation; the lagerförändring on
-- balansdagen is booked from it through the engine.
--
--   1. inventory_counts: one count per fiscal year (several may exist; one is
--      booked), with its dates, the roll-forward note, the signature (name,
--      time, the signed copy) and the lagerförändring verifikat.
--   2. inventory_count_rows: the list, one row per item: a free text or an
--      article, quantity, unit cost, write-down and the value computed in
--      code. Articles stay stockless: nothing here moves an article.
--   3. A signed list is frozen: rows and dates never change after signing,
--      a signed count changes only to booked, and only a draft is deleted
--      (enforced below, not only in the app).
--   4. pending_operations.operation_type: save_inventory_count,
--      book_inventory_count (the MCP doors stage).
--
-- No posted entry is touched; the verifikat goes through the engine.
-- =============================================================================

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. inventory_counts
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inventory_counts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  -- Balansdagen: the fiscal year's last day, copied when the count is made.
  balance_date date NOT NULL,
  -- The day the stock was counted. Another day than balansdagen needs the
  -- roll-forward (LIV 1 §): what came in and went out in between.
  count_date date NOT NULL,
  roll_forward_note text CHECK (roll_forward_note IS NULL OR char_length(roll_forward_note) <= 4000),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed', 'booked')),
  -- Who signed "på heder och samvete" and when (LIV 2 §).
  signer_name text CHECK (signer_name IS NULL OR char_length(btrim(signer_name)) BETWEEN 1 AND 200),
  signed_at timestamptz,
  -- The signed copy: the BankID-signed PDF or an uploaded signed scan. Once
  -- the count is booked the copy is also the verifikat's underlag, which the
  -- retention triggers keep; SET NULL only lets a sanctioned destructive path
  -- (the sandbox teardown) remove a copy that never reached a verifikat.
  signed_document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  -- The BankID signing request while it runs; the list is frozen meanwhile.
  signing_request_id uuid REFERENCES public.signing_requests(id) ON DELETE SET NULL,
  -- The lagerförändring verifikat; NULL on a booked count means the ledger
  -- already held the counted value. SET NULL only for the sanctioned
  -- destructive paths (fiscal-year reset, sandbox teardown).
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  booked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (count_date = balance_date OR roll_forward_note IS NOT NULL),
  CHECK (status = 'draft' OR (signer_name IS NOT NULL AND signed_at IS NOT NULL)),
  CHECK ((status = 'booked') = (booked_at IS NOT NULL))
);

COMMENT ON TABLE public.inventory_counts IS
  'Year-end stock counts (LIV 1955:257): the inventeringslista per fiscal year, its signature på heder och samvete and the lagerförändring verifikat. Frozen once signed.';

-- One booked count per fiscal year: a second booking would count the stock twice.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_counts_one_booked_per_period
  ON public.inventory_counts (company_id, fiscal_period_id) WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS idx_inventory_counts_company_period
  ON public.inventory_counts (company_id, fiscal_period_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_journal_entry_id
  ON public.inventory_counts (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_counts_signed_document_id
  ON public.inventory_counts (signed_document_id) WHERE signed_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_counts_signing_request_id
  ON public.inventory_counts (signing_request_id) WHERE signing_request_id IS NOT NULL;

ALTER TABLE public.inventory_counts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_counts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_counts TO authenticated;

CREATE POLICY "view own-company inventory_counts"
  ON public.inventory_counts FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "insert own-company inventory_counts"
  ON public.inventory_counts FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company inventory_counts"
  ON public.inventory_counts FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
CREATE POLICY "delete own-company inventory_counts"
  ON public.inventory_counts FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
    AND status = 'draft'
  );

-- =============================================================================
-- 2. inventory_count_rows
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inventory_count_rows (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  inventory_count_id uuid NOT NULL REFERENCES public.inventory_counts(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 10000),
  -- The article it is, when it is one; the description is what the list says.
  article_id uuid REFERENCES public.articles(id) ON DELETE SET NULL,
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
  -- Which kind of stock, and so which BAS accounts it is booked on.
  category text NOT NULL DEFAULT 'goods_for_resale'
    CHECK (category IN ('raw_materials', 'supplies', 'work_in_progress', 'finished_goods', 'goods_for_resale')),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 20),
  quantity numeric(16, 3) NOT NULL CHECK (quantity >= 0),
  unit_cost numeric(14, 2) NOT NULL CHECK (unit_cost >= 0),
  -- Inkurans / nedskrivning to net realisable value, in percent of cost.
  write_down_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (write_down_percent >= 0 AND write_down_percent <= 100),
  -- quantity x unit cost less the write-down, rounded to öre in code.
  value numeric(16, 2) NOT NULL CHECK (value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_count_id, position)
);

COMMENT ON TABLE public.inventory_count_rows IS
  'The rows of an inventeringslista (inventory_counts): item, quantity, unit cost, write-down and value. Frozen once the count is signed.';

CREATE INDEX IF NOT EXISTS idx_inventory_count_rows_company_id ON public.inventory_count_rows (company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_rows_article_id
  ON public.inventory_count_rows (article_id) WHERE article_id IS NOT NULL;

ALTER TABLE public.inventory_count_rows ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_count_rows TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_count_rows TO authenticated;

CREATE POLICY "view own-company inventory_count_rows"
  ON public.inventory_count_rows FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "insert own-company inventory_count_rows"
  ON public.inventory_count_rows FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company inventory_count_rows"
  ON public.inventory_count_rows FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
CREATE POLICY "delete own-company inventory_count_rows"
  ON public.inventory_count_rows FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

-- =============================================================================
-- 3. A signed list is frozen
-- =============================================================================

-- inventory_counts: a draft changes freely (but never jumps to booked); a
-- signed count changes only by being booked, or by getting its signed copy
-- once the BankID seal is done; a booked count never changes. Only a draft
-- is deleted. The cascade from the company or the fiscal year, the SET NULL
-- from a sanctioned journal-entry delete (all at trigger depth > 1) and the
-- operator override pass.
CREATE OR REPLACE FUNCTION public.inventory_counts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'INVENTORY_COUNT_LOCKED: a signed inventory count is kept' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.fiscal_period_id <> OLD.fiscal_period_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'INVENTORY_COUNT_LOCKED: the company and fiscal year of a count never change' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status = 'booked' THEN
      RAISE EXCEPTION 'INVENTORY_COUNT_NOT_SIGNED: a count is signed before it is booked' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'signed' THEN
    IF NEW.balance_date IS DISTINCT FROM OLD.balance_date
       OR NEW.count_date IS DISTINCT FROM OLD.count_date
       OR NEW.roll_forward_note IS DISTINCT FROM OLD.roll_forward_note
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.signer_name IS DISTINCT FROM OLD.signer_name
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.signing_request_id IS DISTINCT FROM OLD.signing_request_id
       OR (OLD.signed_document_id IS NOT NULL AND NEW.signed_document_id IS DISTINCT FROM OLD.signed_document_id)
       OR NEW.status NOT IN ('signed', 'booked')
       OR (NEW.status = 'signed' AND (NEW.journal_entry_id IS NOT NULL OR NEW.booked_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'INVENTORY_COUNT_LOCKED: a signed inventory count only gets booked' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- booked: the record of what was booked.
  IF ROW(NEW.status, NEW.balance_date, NEW.count_date, NEW.roll_forward_note, NEW.note, NEW.signer_name,
         NEW.signed_at, NEW.signing_request_id, NEW.journal_entry_id, NEW.booked_at)
     IS DISTINCT FROM
     ROW(OLD.status, OLD.balance_date, OLD.count_date, OLD.roll_forward_note, OLD.note, OLD.signer_name,
         OLD.signed_at, OLD.signing_request_id, OLD.journal_entry_id, OLD.booked_at)
     OR (OLD.signed_document_id IS NOT NULL AND NEW.signed_document_id IS DISTINCT FROM OLD.signed_document_id) THEN
    RAISE EXCEPTION 'INVENTORY_COUNT_LOCKED: a booked inventory count never changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_counts_guard() FROM PUBLIC, anon, authenticated;

-- inventory_count_rows: rows change only while their count is a draft that
-- is not out for BankID signing.
CREATE OR REPLACE FUNCTION public.inventory_count_rows_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count_id uuid;
  v_company uuid;
  v_status text;
  v_signing uuid;
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_count_id := OLD.inventory_count_id;
  ELSE
    v_count_id := NEW.inventory_count_id;
  END IF;
  SELECT company_id, status, signing_request_id INTO v_company, v_status, v_signing
    FROM public.inventory_counts WHERE id = v_count_id;
  IF TG_OP <> 'DELETE' THEN
    IF v_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'INVENTORY_COUNT_NOT_FOUND: the row belongs to a count of another company' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_status IS DISTINCT FROM 'draft' OR v_signing IS NOT NULL THEN
    RAISE EXCEPTION 'INVENTORY_COUNT_LOCKED: the rows of a signed inventory count never change' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.inventory_count_id <> OLD.inventory_count_id THEN
    RAISE EXCEPTION 'INVENTORY_COUNT_LOCKED: a row stays on its count' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_count_rows_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_counts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
CREATE TRIGGER inventory_counts_guard
  BEFORE UPDATE OR DELETE ON public.inventory_counts
  FOR EACH ROW EXECUTE FUNCTION public.inventory_counts_guard();
CREATE TRIGGER set_updated_at_inventory_counts
  BEFORE UPDATE ON public.inventory_counts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER audit_inventory_counts
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory_counts
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_count_rows
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
CREATE TRIGGER inventory_count_rows_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_count_rows
  FOR EACH ROW EXECUTE FUNCTION public.inventory_count_rows_guard();
CREATE TRIGGER set_updated_at_inventory_count_rows
  BEFORE UPDATE ON public.inventory_count_rows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER audit_inventory_count_rows
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory_count_rows
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. pending_operations.operation_type: save_inventory_count, book_inventory_count
-- =============================================================================

DO $$
DECLARE
  v_types text[];
  v_new text;
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
  FOREACH v_new IN ARRAY ARRAY['save_inventory_count', 'book_inventory_count'] LOOP
    IF NOT (v_new = ANY (v_types)) THEN
      v_types := v_types || v_new;
    END IF;
  END LOOP;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
