-- skatteverket_api_audit_log: long-lived audit trail for every outbound call
-- to a Skatteverket regulator endpoint. Separate from audit_log (which is
-- DB-trigger-only and lacks company_id/endpoint columns). Type II reviewers
-- need to reconstruct who submitted what AGI/moms payload to SKV and when.
--
-- Append-only. RLS by company_id. No retention TTL — these records are part
-- of räkenskapsinformation under BFL 7 kap (7-year minimum).

CREATE TABLE public.skatteverket_api_audit_log (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  user_id              uuid NOT NULL,  -- no cascade: survives user deletion
  endpoint             text NOT NULL,  -- e.g. 'agi.kontrollera.hu', 'agi.submit', 'moms.declaration.lock'
  ag_registered_id     text,           -- 12-digit IDENTITET (orgnr or pnr) when known
  redovisningsperiod   text,           -- YYYYMM when applicable
  outcome              text NOT NULL CHECK (outcome IN ('ok', 'validation_error', 'skv_error', 'auth_error', 'internal_error')),
  response_status      integer,        -- HTTP status from SKV (or local error code)
  skv_status           text,           -- 'OK' | 'INFO' | 'ARENDE' | 'STOPP' | 'AVVISANDE' for kontrollsvar
  request_size_bytes   integer,
  correlation_id       text,           -- for cross-system tracing
  error_message        text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.skatteverket_api_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY skatteverket_api_audit_log_select ON public.skatteverket_api_audit_log
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- No INSERT/UPDATE/DELETE policies for normal roles — service role writes
-- only. Immutability triggers below block all UPDATE/DELETE regardless of role.

CREATE INDEX idx_skv_audit_company_created ON public.skatteverket_api_audit_log (company_id, created_at DESC);
CREATE INDEX idx_skv_audit_endpoint        ON public.skatteverket_api_audit_log (endpoint);
CREATE INDEX idx_skv_audit_user            ON public.skatteverket_api_audit_log (user_id);

CREATE OR REPLACE FUNCTION public.skatteverket_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Skatteverket audit log entries cannot be modified or deleted';
END;
$$;

CREATE TRIGGER skv_audit_no_update
  BEFORE UPDATE ON public.skatteverket_api_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.skatteverket_audit_immutable();

CREATE TRIGGER skv_audit_no_delete
  BEFORE DELETE ON public.skatteverket_api_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.skatteverket_audit_immutable();

-- salary_absence_franvaro_audit: SOC 2 CC7.2 — record every assignment of
-- franvaro_specifikationsnummer by the DB trigger so a Type II reviewer can
-- reconstruct the sequence history per (employee, year-month). The trigger
-- runs SECURITY DEFINER (implicit in plpgsql functions that own the table);
-- without this, an auditor has no record of when each number was minted.
CREATE TABLE public.salary_absence_franvaro_audit (
  id                            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  absence_day_id                uuid NOT NULL,
  employee_id                   uuid NOT NULL,
  absence_date                  date NOT NULL,
  year_month                    text NOT NULL,  -- YYYY-MM
  old_specifikationsnummer      integer,
  new_specifikationsnummer      integer NOT NULL,
  trigger_op                    text NOT NULL CHECK (trigger_op IN ('insert', 'update')),
  assigned_at                   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.salary_absence_franvaro_audit ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_franvaro_audit_employee_month
  ON public.salary_absence_franvaro_audit (employee_id, year_month, assigned_at);

CREATE OR REPLACE FUNCTION public.franvaro_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Frånvaro audit entries cannot be modified or deleted';
END;
$$;

CREATE TRIGGER franvaro_audit_no_update
  BEFORE UPDATE ON public.salary_absence_franvaro_audit
  FOR EACH ROW EXECUTE FUNCTION public.franvaro_audit_immutable();

CREATE TRIGGER franvaro_audit_no_delete
  BEFORE DELETE ON public.salary_absence_franvaro_audit
  FOR EACH ROW EXECUTE FUNCTION public.franvaro_audit_immutable();

-- Replace the trigger functions to (1) take an advisory lock per
-- (employee_id, year-month) so concurrent inserts serialise rather than
-- racing on MAX(...)+1 and surfacing as a unique-violation, and (2) write an
-- audit row capturing the assignment.
--
-- pg_advisory_xact_lock is released at transaction commit/rollback and is
-- keyed by a 64-bit int built from the employee UUID's low 32 bits XOR'd
-- with the year-month integer. Collisions across employees in different
-- months are harmless (just serialise more than needed); collisions across
-- different employees in the same month are statistically negligible and
-- still correct.
CREATE OR REPLACE FUNCTION public.assign_franvaro_specifikationsnummer()
RETURNS TRIGGER AS $$
DECLARE
  v_lock_key bigint;
  v_year_month text;
  v_new_num integer;
BEGIN
  IF NEW.franvaro_specifikationsnummer IS NULL
     AND NEW.absence_type IN ('vab', 'parental') THEN
    v_year_month := to_char(NEW.absence_date, 'YYYY-MM');
    v_lock_key := ('x' || substr(replace(NEW.employee_id::text, '-', ''), 1, 8))::bit(32)::bigint
                  # (extract(year FROM NEW.absence_date)::int * 100 + extract(month FROM NEW.absence_date)::int);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT COALESCE(MAX(franvaro_specifikationsnummer), 0) + 1
      INTO v_new_num
      FROM salary_absence_days
     WHERE employee_id = NEW.employee_id
       AND (extract(year FROM absence_date)::int * 100 + extract(month FROM absence_date)::int)
         = (extract(year FROM NEW.absence_date)::int * 100 + extract(month FROM NEW.absence_date)::int)
       AND franvaro_specifikationsnummer IS NOT NULL;

    NEW.franvaro_specifikationsnummer := v_new_num;

    INSERT INTO public.salary_absence_franvaro_audit (
      absence_day_id, employee_id, absence_date, year_month,
      old_specifikationsnummer, new_specifikationsnummer, trigger_op
    ) VALUES (
      NEW.id, NEW.employee_id, NEW.absence_date, v_year_month,
      NULL, v_new_num, 'insert'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.assign_franvaro_specifikationsnummer_on_update()
RETURNS TRIGGER AS $$
DECLARE
  v_lock_key bigint;
  v_year_month text;
  v_new_num integer;
BEGIN
  IF NEW.franvaro_specifikationsnummer IS NULL
     AND NEW.absence_type IN ('vab', 'parental') THEN
    v_year_month := to_char(NEW.absence_date, 'YYYY-MM');
    v_lock_key := ('x' || substr(replace(NEW.employee_id::text, '-', ''), 1, 8))::bit(32)::bigint
                  # (extract(year FROM NEW.absence_date)::int * 100 + extract(month FROM NEW.absence_date)::int);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT COALESCE(MAX(franvaro_specifikationsnummer), 0) + 1
      INTO v_new_num
      FROM salary_absence_days
     WHERE employee_id = NEW.employee_id
       AND (extract(year FROM absence_date)::int * 100 + extract(month FROM absence_date)::int)
         = (extract(year FROM NEW.absence_date)::int * 100 + extract(month FROM NEW.absence_date)::int)
       AND franvaro_specifikationsnummer IS NOT NULL;

    NEW.franvaro_specifikationsnummer := v_new_num;

    INSERT INTO public.salary_absence_franvaro_audit (
      absence_day_id, employee_id, absence_date, year_month,
      old_specifikationsnummer, new_specifikationsnummer, trigger_op
    ) VALUES (
      NEW.id, NEW.employee_id, NEW.absence_date, v_year_month,
      OLD.franvaro_specifikationsnummer, v_new_num, 'update'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

NOTIFY pgrst, 'reload schema';
