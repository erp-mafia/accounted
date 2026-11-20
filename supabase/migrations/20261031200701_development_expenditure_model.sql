-- The company's accounting policy for internally generated intangible
-- assets under K3 (BFNAR 2012:1 punkt 18.7): the kostnadsföringsmodell
-- (every expenditure an expense when incurred, 18.8) or the
-- aktiveringsmodell (development-phase expenditure capitalised when 18.12 is
-- met). The model is applied consistently to every such asset; changing it
-- is a change of accounting policy (K3 kap. 10).
--
-- Why this exists: the asset register put every intangible of a K3 company
-- on 1010/1019 (Utvecklingsutgifter), purchased licences included, and
-- nothing recorded which model the company had chosen. The K3 accounting
-- policies note states the model, and capitalised own development requires
-- a fond för utvecklingsutgifter (ÅRL 4 kap. 2 § andra stycket), so both
-- need the choice as data.
--
-- NULL: not chosen yet. The asset register refuses an internally generated
-- intangible until the company has chosen the aktiveringsmodell.
--
-- Every change of the model is behandlingshistorik (BFL 5 kap. 11 §, BFNAR
-- 2013:2 punkt 9.16): an audit_log row with who, when, and the model before
-- and after, written by a trigger so no writer can skip it. The app sets the
-- model through set_development_expenditure_model, which carries the user
-- and the actor for the API-key and MCP doors (a service-role session has
-- no auth.uid()).
--
-- assets.own_development marks the register's own development: the fund
-- för utvecklingsutgifter covers only that (ÅRL 4 kap. 2 §, K3 18.3A), never
-- a purchased licence that sits on 101x (the old default put every K3
-- intangible there). Default false: a row the register put on 101x without
-- the user saying it was own development is not presumed to be. The user
-- marks an existing 101x asset through set_asset_own_development; every
-- change of the mark is written to audit_log (it decides what the fund
-- follows), with who made it.
--
-- pg-test: tests/pg/development-expenditure-model.pg.test.ts

-- companies is read on every request and assets at every year-end: fail the
-- migration job instead of queueing them behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.companies
  ADD COLUMN development_expenditure_model text
    CHECK (development_expenditure_model IS NULL
           OR development_expenditure_model IN ('expense', 'capitalise'));

COMMENT ON COLUMN public.companies.development_expenditure_model IS
  'K3 18.7: expense (kostnadsföringsmodellen) or capitalise (aktiveringsmodellen) for internally generated intangible assets; NULL until chosen. Every change is written to audit_log.';

ALTER TABLE public.assets
  ADD COLUMN own_development boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT assets_own_development_account CHECK (
    NOT own_development OR bas_asset_account ~ '^101[0-9]$'
  );

COMMENT ON COLUMN public.assets.own_development IS
  'The company''s own development capitalised under the K3 aktiveringsmodell (18.7, 18.12), on BAS 101x: what the fond för utvecklingsutgifter follows (ÅRL 4 kap. 2 §). False for anything else on 101x, a purchased licence included.';

-- =============================================================================
-- The audit row
-- =============================================================================

CREATE FUNCTION public.audit_development_expenditure_model()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- The signed-in user; for a service-role caller, the user
  -- set_development_expenditure_model was told acts.
  v_user uuid := coalesce(auth.uid(), nullif(current_setting('gnubok.actor_user_id', true), '')::uuid);
BEGIN
  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  ) VALUES (
    v_user,
    NEW.id,
    'UPDATE',
    'companies',
    NEW.id,
    v_user,
    jsonb_build_object('development_expenditure_model', OLD.development_expenditure_model),
    jsonb_build_object('development_expenditure_model', NEW.development_expenditure_model),
    'Model for internally generated intangible assets changed (K3 18.7)',
    coalesce(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.audit_development_expenditure_model() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER audit_development_expenditure_model
  AFTER UPDATE OF development_expenditure_model ON public.companies
  FOR EACH ROW
  WHEN (OLD.development_expenditure_model IS DISTINCT FROM NEW.development_expenditure_model)
  EXECUTE FUNCTION public.audit_development_expenditure_model();

-- =============================================================================
-- set_development_expenditure_model
-- =============================================================================
-- Sets the model as the named user. A signed-in caller must be an owner or
-- admin of the company and is always the user recorded (auth.uid() wins over
-- p_user_id); a service-role caller (the API-key and MCP doors, which check
-- the role themselves) names the user. K3 companies only.

CREATE FUNCTION public.set_development_expenditure_model(
  p_company_id uuid,
  p_model text,
  p_user_id uuid DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_framework text;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') AND NOT public.user_is_company_admin(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized accounting policy change for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_model IS NULL OR p_model NOT IN ('expense', 'capitalise') THEN
    RAISE EXCEPTION 'Invalid development expenditure model %', p_model USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.companies c WHERE c.id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company not found: %', p_company_id USING ERRCODE = 'P0002';
  END IF;
  -- The model is a policy for the company's K3 years: chosen when an open
  -- year (not closed, not locked) is reported under K3, an elected next year
  -- included; with no fiscal year yet, the company setting decides.
  IF EXISTS (SELECT 1 FROM public.fiscal_periods p WHERE p.company_id = p_company_id) THEN
    SELECT CASE WHEN EXISTS (
             SELECT 1 FROM public.fiscal_periods p
              WHERE p.company_id = p_company_id
                AND NOT p.is_closed
                AND p.locked_at IS NULL
                AND public.fiscal_year_framework(p_company_id, p.id) = 'k3'
           ) THEN 'k3' ELSE 'k2' END
      INTO v_framework;
  ELSE
    v_framework := public.fiscal_year_framework(p_company_id, NULL);
  END IF;
  IF v_framework IS DISTINCT FROM 'k3' THEN
    RAISE EXCEPTION 'DEVELOPMENT_MODEL_REFUSED' USING ERRCODE = 'PT409',
      HINT = 'The K3 18.7 model is chosen only under K3.';
  END IF;

  PERFORM set_config('gnubok.actor_user_id', coalesce(p_user_id::text, ''), true);
  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  UPDATE public.companies
     SET development_expenditure_model = p_model
   WHERE id = p_company_id;

  PERFORM set_config('gnubok.actor_user_id', '', true);

  RETURN p_model;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_development_expenditure_model(uuid, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_development_expenditure_model(uuid, text, uuid, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_development_expenditure_model(uuid, text, uuid, text, text) IS
  'K3 18.7: sets companies.development_expenditure_model as the named user; the audit_development_expenditure_model trigger records the change in audit_log.';

-- =============================================================================
-- assets.own_development: who marked what, and the door that sets it
-- =============================================================================

CREATE FUNCTION public.audit_asset_own_development()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- The signed-in user; for a service-role caller, the user
  -- set_asset_own_development was told acts; else the asset's creator, as
  -- write_audit_log records.
  v_user uuid := coalesce(
    auth.uid(),
    nullif(current_setting('gnubok.actor_user_id', true), '')::uuid,
    NEW.user_id
  );
BEGIN
  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  ) VALUES (
    v_user,
    NEW.company_id,
    'UPDATE',
    'assets',
    NEW.id,
    v_user,
    jsonb_build_object('own_development', OLD.own_development, 'bas_asset_account', OLD.bas_asset_account),
    jsonb_build_object('own_development', NEW.own_development, 'bas_asset_account', NEW.bas_asset_account),
    CASE WHEN NEW.own_development
      THEN 'Asset marked as own development (K3 18.7; the fond för utvecklingsutgifter follows it)'
      ELSE 'Asset no longer marked as own development'
    END,
    coalesce(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.audit_asset_own_development() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER audit_asset_own_development
  AFTER UPDATE OF own_development ON public.assets
  FOR EACH ROW
  WHEN (OLD.own_development IS DISTINCT FROM NEW.own_development)
  EXECUTE FUNCTION public.audit_asset_own_development();

-- Marks (or unmarks) one asset as the company's own development, as the
-- named user. A signed-in caller must be able to write for the company and
-- is always the user recorded; a service-role caller (API key, MCP) names
-- the user. Marking needs K3, the aktiveringsmodell and an asset on 101x.

CREATE FUNCTION public.set_asset_own_development(
  p_company_id uuid,
  p_asset_id uuid,
  p_own boolean,
  p_user_id uuid DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_account text;
  v_acquired date;
  v_framework text;
  v_model text;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized asset change for company %', p_company_id USING ERRCODE = '42501';
  END IF;
  IF p_own IS NULL THEN
    RAISE EXCEPTION 'p_own is required' USING ERRCODE = '22023';
  END IF;

  SELECT a.bas_asset_account, a.acquisition_date INTO v_account, v_acquired
    FROM public.assets a
   WHERE a.id = p_asset_id AND a.company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_own THEN
    IF v_account !~ '^101[0-9]$' THEN
      RAISE EXCEPTION 'OWN_DEVELOPMENT_ACCOUNT' USING ERRCODE = '23514',
        HINT = 'Only an asset on 1010-1019 is own development.';
    END IF;
    -- K2 forbids own development as an asset (BFNAR 2016:10 10.4): the year
    -- the asset was acquired in must be a K3 year.
    v_framework := public.fiscal_framework_on(p_company_id, v_acquired);
    SELECT c.development_expenditure_model INTO v_model
      FROM public.companies c WHERE c.id = p_company_id;
    IF v_framework IS DISTINCT FROM 'k3' OR v_model IS DISTINCT FROM 'capitalise' THEN
      RAISE EXCEPTION 'OWN_DEVELOPMENT_NOT_CAPITALISED' USING ERRCODE = '23514',
        HINT = 'Own development is capitalised only under K3 with the aktiveringsmodell (18.7).';
    END IF;
  END IF;

  PERFORM set_config('gnubok.actor_user_id', coalesce(p_user_id::text, ''), true);
  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  UPDATE public.assets
     SET own_development = p_own
   WHERE id = p_asset_id AND company_id = p_company_id;

  PERFORM set_config('gnubok.actor_user_id', '', true);
  RETURN p_own;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_asset_own_development(uuid, uuid, boolean, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_asset_own_development(uuid, uuid, boolean, uuid, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_asset_own_development(uuid, uuid, boolean, uuid, text, text) IS
  'Marks or unmarks an asset on 101x as the company''s own development (K3 18.7), as the named user; the audit_asset_own_development trigger records the change.';

NOTIFY pgrst, 'reload schema';
