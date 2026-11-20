-- Salary payment file versions (crm#1219).
-- pg-test: tests/pg/salary-payment-file-versions.pg.test.ts
--
-- A salary run's pain.001 carries one message id per company and period, so
-- the bank's duplicate check (Danske Bank: MsgId and EndToEndId unique for at
-- least three months, or the file / payment is rejected) refuses a second
-- upload of the same month. That refusal is the guard against paying a month
-- twice, and it also refuses a CORRECTED file after the first one was
-- uploaded and never approved (crm#1218: the first file named the wrong
-- account). A new version gives the run's file new ids, so the bank takes it.
--
-- A new version is never silent. Only an archived file can raise the run's
-- version, by exactly one, and only when the person generating it confirmed
-- that the earlier file was not approved at the bank. The row that raised the
-- version is the audit: who (user_id), when (generated_at), which version,
-- and that the confirmation was given.
--
--   salary_runs.payment_file_version: the version every pain.001 download of
--     the run carries (1 until a new version is made). Written only by the
--     archive trigger below; a direct UPDATE or an INSERT with another value
--     raises, so no client can skip the confirmation by editing the run.
--   salary_payment_files.version: the version the archived file carries.
--   salary_payment_files.previous_not_approved_confirmed: the person's
--     confirmation, true on the row that raised the version.
--
-- Bankgirot LB files have no message id the bank deduplicates on; they stay
-- version 1 and never carry the confirmation.
--
-- Existing rows and runs take the default 1, which is what every file
-- generated so far carried.

ALTER TABLE public.salary_runs
  ADD COLUMN payment_file_version integer NOT NULL DEFAULT 1
    CONSTRAINT salary_runs_payment_file_version_check CHECK (payment_file_version >= 1);

COMMENT ON COLUMN public.salary_runs.payment_file_version IS
  'Version of the run''s pain.001 payment file (its MsgId and EndToEndIds). Raised by one only by archiving a salary_payment_files row whose confirmation says the earlier file was not approved at the bank (crm#1219).';

ALTER TABLE public.salary_payment_files
  ADD COLUMN version integer NOT NULL DEFAULT 1
    CONSTRAINT salary_payment_files_version_check CHECK (version >= 1),
  ADD COLUMN previous_not_approved_confirmed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.salary_payment_files.version IS
  'Payment file version the archived file carries (salary_runs.payment_file_version when it was generated).';
COMMENT ON COLUMN public.salary_payment_files.previous_not_approved_confirmed IS
  'The person generating a new version confirmed that the earlier file was not approved at the bank. True on the row that raised the version.';

-- BEFORE INSERT on the archive: the version must be the run's current one (a
-- re-download) or the next one with the confirmation (a new version, which
-- raises the run in the same statement). The run row is locked, so two new
-- versions at once serialize: the second one finds the version already raised
-- and archives as a re-download of it, under the same ids.
CREATE OR REPLACE FUNCTION public.enforce_salary_payment_file_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_current integer;
BEGIN
  IF NEW.format <> 'pain001' THEN
    IF NEW.version <> 1 OR NEW.previous_not_approved_confirmed THEN
      RAISE EXCEPTION 'salary_payment_files: only a pain.001 payment file has versions';
    END IF;
    RETURN NEW;
  END IF;

  SELECT r.payment_file_version INTO v_current
  FROM public.salary_runs r
  WHERE r.id = NEW.salary_run_id AND r.company_id = NEW.company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary_payment_files: salary run % does not belong to company %',
      NEW.salary_run_id, NEW.company_id;
  END IF;

  IF NEW.version = v_current THEN
    RETURN NEW;
  END IF;

  IF NEW.version = v_current + 1 THEN
    IF NOT NEW.previous_not_approved_confirmed THEN
      RAISE EXCEPTION 'salary_payment_files: a new payment file version needs the confirmation that the earlier file was not approved at the bank';
    END IF;
    PERFORM set_config('gnubok.salary_payment_file_version_raise', NEW.salary_run_id::text, true);
    UPDATE public.salary_runs SET payment_file_version = NEW.version WHERE id = NEW.salary_run_id;
    PERFORM set_config('gnubok.salary_payment_file_version_raise', '', true);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'salary_payment_files: version % is neither the run''s current payment file version % nor the next one',
    NEW.version, v_current;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_salary_payment_file_version() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_salary_payment_file_version
  BEFORE INSERT ON public.salary_payment_files
  FOR EACH ROW EXECUTE FUNCTION public.enforce_salary_payment_file_version();

-- The run's version moves only through the archive trigger above, by one.
CREATE OR REPLACE FUNCTION public.guard_salary_run_payment_file_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_file_version <> 1 THEN
      RAISE EXCEPTION 'salary_runs: a new run starts at payment file version 1';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.payment_file_version IS DISTINCT FROM OLD.payment_file_version
     AND NOT (
       coalesce(current_setting('gnubok.salary_payment_file_version_raise', true), '') = OLD.id::text
       AND NEW.payment_file_version = OLD.payment_file_version + 1
     ) THEN
    RAISE EXCEPTION 'salary_runs: the payment file version changes only by archiving a confirmed new version of the file';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_salary_run_payment_file_version() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_salary_run_payment_file_version
  BEFORE INSERT OR UPDATE OF payment_file_version ON public.salary_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_salary_run_payment_file_version();

NOTIFY pgrst, 'reload schema';
