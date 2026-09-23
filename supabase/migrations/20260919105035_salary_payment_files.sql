-- Salary payment file archive (#2724).
-- pg-test: tests/pg/salary-payment-files.pg.test.ts
--
-- The salary payment file (ISO 20022 pain.001 or Bankgirot LB) is
-- räkenskapsinformation under BFL 7 kap. 1 §: it is the underlag for the
-- salary payments the bank executed, and it must be kept for seven years.
-- Until now lib/salary/payment/build-payment-file.ts handed the file out
-- inline and only stamped payment_file_format / payment_file_generated_at on
-- salary_runs. The bytes that went to the bank were never stored, so a
-- regeneration after a bank-detail change (new employee account, changed
-- company IBAN) produced a file that differs from what was sent, with no way
-- to tell. supplier_payment_batches keeps an immutable pain.001 snapshot for
-- supplier payments (DECISIONS.md 2026-09-06) and agi_declarations.xml_content
-- keeps the AGI XML; this table closes the same gap for salaries.
--
-- One row per generated file, written by the builder before the file is
-- returned (an archive failure withholds the file). The row stores the exact
-- string the generator produced plus the charset the HTTP layer encodes it
-- with (pain.001 as UTF-8, LB as ISO 8859-1), and sha256 / byte_size over
-- those encoded bytes, so a bank-side copy can be verified against the
-- archive byte for byte.
--
-- WORM: SELECT and INSERT for company members, no UPDATE or DELETE policy,
-- and a trigger that raises on UPDATE and DELETE (audit_log_immutable()
-- shape) so not even the service role can rewrite a snapshot. The only
-- sanctioned DELETE is sandbox teardown, under the same transaction-local
-- flag and per-row is_sandbox re-verification as the other guarded tables
-- (20260807130000); cleanup_sandbox_user purges the rows explicitly while
-- company_settings still exists.
--
-- No updated_at column or trigger: rows never change. No write_audit_log
-- trigger either: the row is itself the immutable who/when record and an
-- audit copy would duplicate the file content into audit_log on every
-- generation. salary_run_id is ON DELETE RESTRICT: a run whose payment file
-- has been generated (and possibly uploaded to the bank) cannot be deleted
-- while the archive holds its file, the same safety net agi_declarations
-- gives a filed run.

CREATE TABLE public.salary_payment_files (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  salary_run_id  uuid NOT NULL REFERENCES public.salary_runs(id) ON DELETE RESTRICT,
  -- RESTRICT, not the usual CASCADE: this is a seven-year archive and its
  -- author's account may never take it along. Accounts are tombstoned, not
  -- deleted (erase_user_personal_data), so the reference never blocks that.
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  format         text NOT NULL CHECK (format IN ('pain001', 'bg_lb')),
  filename       text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  content_type   text NOT NULL CHECK (content_type IN ('application/xml', 'text/plain')),
  -- The encoding the download uses for `content`: utf-8 for pain.001 XML,
  -- iso-8859-1 for Bankgirot LB. sha256 and byte_size are computed over the
  -- bytes in this encoding, never over the UTF-8 form of the stored string.
  charset        text NOT NULL CHECK (charset IN ('utf-8', 'iso-8859-1')),
  -- The file exactly as the generator produced it (LB content is Latin-1
  -- safe by construction, so the text round-trips through both encodings).
  content        text NOT NULL CHECK (char_length(content) > 0),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size      integer NOT NULL CHECK (byte_size > 0),
  payment_date   date NOT NULL,
  -- Employees with a positive net payout (the credit transfers in the file);
  -- a nollkörning can archive a file with zero lines.
  employee_count integer NOT NULL CHECK (employee_count >= 0),
  total_amount   numeric NOT NULL CHECK (total_amount >= 0),
  generated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.salary_payment_files IS
  'Immutable archive of every generated salary payment file (pain.001 / Bankgirot LB): räkenskapsinformation under BFL 7 kap. 1 §, retained seven years. Rows are never updated or deleted.';
COMMENT ON COLUMN public.salary_payment_files.charset IS
  'Encoding of the file as downloaded (utf-8 for pain001, iso-8859-1 for bg_lb); sha256 and byte_size are over those bytes.';
COMMENT ON COLUMN public.salary_payment_files.sha256 IS
  'Lowercase hex SHA-256 over the file bytes in `charset`; compare against the copy uploaded to the bank.';

ALTER TABLE public.salary_payment_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company salary_payment_files"
  ON public.salary_payment_files FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company salary_payment_files"
  ON public.salary_payment_files FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
-- No UPDATE or DELETE policies: rows are immutable snapshots (see the
-- trigger below for the service-role side of the same rule).

CREATE INDEX idx_salary_payment_files_run_generated
  ON public.salary_payment_files (salary_run_id, generated_at DESC);
CREATE INDEX idx_salary_payment_files_company_id
  ON public.salary_payment_files (company_id);

-- INSERT: the run must belong to the row's company, so a user who is a
-- member of two companies can never file company A's archive row against a
-- run in company B (a plain per-column FK would allow it). Under RLS the
-- lookup only sees the caller's own runs, so it fails closed.
-- UPDATE / DELETE: WORM. The only exception is sandbox teardown, and only
-- for rows whose company is provably a sandbox: the per-row re-check means
-- the flag alone can never unlock a real company's archive.
CREATE OR REPLACE FUNCTION public.enforce_salary_payment_files_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.salary_runs r
      WHERE r.id = NEW.salary_run_id AND r.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'salary_payment_files: salary run % does not belong to company %',
        NEW.salary_run_id, NEW.company_id;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'salary_payment_files are räkenskapsinformation (BFL 7 kap. 1 §) and cannot be modified or deleted';
END;
$$;

CREATE TRIGGER enforce_salary_payment_files_worm
  BEFORE INSERT OR UPDATE OR DELETE ON public.salary_payment_files
  FOR EACH ROW EXECUTE FUNCTION public.enforce_salary_payment_files_worm();

REVOKE ALL ON FUNCTION public.enforce_salary_payment_files_worm() FROM PUBLIC, anon, authenticated;

-- Archived migration-reset source companies are static (20260818084050): a
-- reset source must not gain a new payment file either.
CREATE TRIGGER salary_payment_files_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.salary_payment_files
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

-- =============================================================================
-- cleanup_sandbox_user: purge the archive under the teardown bypass
-- =============================================================================
-- Body identical to 20260913200922 plus one DELETE. The rows must go while
-- company_settings still exists (the WORM bypass re-verifies sandbox-ness
-- through it) and before the auth.users cascade reaches salary_runs, whose
-- delete the RESTRICT FK above would otherwise block.

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
  v_companies uuid[];
  v_company uuid;
BEGIN
  -- Verify this is a sandbox user: at least one settings row, and EVERY
  -- settings row flagged sandbox.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  SELECT array_agg(cs.company_id ORDER BY cs.company_id) INTO v_companies
    FROM public.company_settings cs WHERE cs.user_id = p_user_id AND cs.is_sandbox IS TRUE;
  -- Serialize teardown with every worker before changing holds or receipts.
  FOREACH v_company IN ARRAY v_companies LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || v_company::text, 0));
    -- Pin the classification until teardown finishes. company_id is unique,
    -- but fail closed even if future schema changes permit conflicting rows.
    PERFORM 1 FROM public.company_settings cs WHERE cs.company_id = v_company FOR SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.company_settings cs
      WHERE cs.company_id = v_company AND cs.is_sandbox IS NOT TRUE) THEN
      RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
    END IF;
  END LOOP;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- Remove SIE-only blockers while the immutable company classification
  -- remains available to each retention guard. Clearing the hold separately
  -- allows the ordinary sandbox teardown to clear IB and closing pointers.
  DELETE FROM public.sie_duplicate_repair_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_import_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_period_read_leases WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET opening_balance_review_import_id = NULL,
    opening_balance_review_token = NULL, opening_balance_review_entry_id = NULL,
    opening_balance_review_reason = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.sie_imports SET opening_balance_entry_id = NULL WHERE company_id = ANY(v_companies);

  -- API keys must die with the sandbox, and api_keys.sod_acknowledged_by
  -- (NO ACTION to auth.users) otherwise blocks the auth delete.
  DELETE FROM public.api_keys WHERE user_id = p_user_id;

  -- WORM retag log: delete under the bypass while company_settings still
  -- exists, and before the journal deletes whose cascade would otherwise
  -- reach it.
  DELETE FROM public.dimension_retag_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Match log: append-only, user-scoped on purpose, and purged this early for
  -- two reasons. lib/invoices/match-log.ts writes rows with no company_id, and
  -- the guard can only recognise those as sandbox rows while the
  -- company_settings row still exists, which the auth.users cascade cannot
  -- promise (company_settings.user_id cascades from the same delete, and
  -- sibling cascade order is undefined). And payment_match_log.supplier_invoice_id
  -- is ON DELETE SET NULL, so the supplier_invoices delete further down turns
  -- into an UPDATE on any row that references one, which the guard still
  -- refuses even during teardown.
  DELETE FROM public.payment_match_log
  WHERE user_id = p_user_id
     OR company_id IN (
       SELECT cs.company_id FROM public.company_settings cs
       WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
     );

  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  -- Salary payment file archive (20260919105035): WORM with a teardown
  -- bypass that re-verifies sandbox-ness through company_settings, and
  -- ON DELETE RESTRICT on salary_runs, so the rows go here, before the
  -- auth.users cascade reaches the runs and before company_settings can
  -- vanish.
  DELETE FROM public.salary_payment_files WHERE company_id = ANY(v_companies);

  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE user_id = p_user_id;

  -- fiscal_periods points at its IB and bokslut vouchers with plain NO ACTION
  -- FKs, and previous_period_id chains periods to each other the same way.
  -- Clearing all three under the teardown bypass is what lets the journal
  -- delete below run at all.
  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = NULL,
      closing_entry_id = NULL,
      previous_period_id = NULL
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  -- Betalfil batches: their items reference supplier_invoices with
  -- ON DELETE RESTRICT, so the batch headers must go first (the items
  -- cascade off the header, and neither table has a delete guard).
  DELETE FROM public.supplier_payment_batches
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Journal references are gone. Delete import rows explicitly instead of
  -- relying on the auth-user cascade, whose settings-delete order is unknown.
  DELETE FROM public.sie_imports WHERE company_id = ANY(v_companies);

  -- Durable SIE jobs project terminal API operations. Remove those records
  -- before auth.users cascades can remove their sandbox classification.
  DELETE FROM public.operations WHERE company_id = ANY(v_companies);

  DELETE FROM public.processing_history
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.invoice_deliveries
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Terminal webhook deliveries: guarded against DELETE, and reached by the
  -- auth.users -> companies cascade unless purged here under the bypass.
  DELETE FROM public.webhook_deliveries
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.audit_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
