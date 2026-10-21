-- A new inbox address with the company's current name, while the old one
-- keeps receiving (crm#1334, crm#1209).
--
-- Why this exists: the inbox address (company_inboxes.local_part) slugs the
-- company name once, when the company is created, and a rename leaves it as
-- it is on purpose (20261015201209_sync_company_name_from_settings): the
-- address already went out to suppliers and forwarding rules. The only way to
-- an address with the current name was rotate_company_inbox, which retires
-- the old address in the same transaction (the webhook answers 410 from then
-- on). That is the right tool for a leaked or spammed address and the wrong
-- one for a rename: a renamed company had to choose between an address with
-- the wrong name and losing every mail its suppliers still send to the old
-- one. Prod 2026-10-21 (read-only): 49 live companies have an active address
-- that no longer slugs their name; 6 of them received 54 mails at it in the
-- last 28 days.
--
-- 1. company_inboxes.status gains 'previous': an earlier address of the
--    company that still receives. The webhook files mail to it exactly as to
--    the active address (src/extensions/general/invoice-inbox/index.ts);
--    every reader of "the company's address" keeps reading status = 'active',
--    and the one-active-per-company index is untouched.
-- 2. rename_company_inbox(p_company_id): the active address becomes
--    'previous' and a new active address slugs the company's current name.
--    Same gates as rotate_company_inbox (member, then owner/admin). Refused
--    with PT409 when the new address would carry the same slug (nothing to
--    rename to), and with P0002 when the company has no active address.
-- 3. rotate_company_inbox retires the previous addresses too: rotation is the
--    "this address leaked, stop it" tool, and an earlier address that still
--    receives would keep the leak open. Restated from
--    20261012100100_restate_patched_functions.sql with that one change.
-- 4. Previous addresses follow the active address to another company: the
--    migration reset (reset_company_migration) moves the source's active row
--    onto the replacement company, and a previous address left behind would
--    file mail into the archived source. A trigger on the row, rather than a
--    restatement of the reset function, so any writer that moves the active
--    address moves its previous ones with it.
--
-- pg-test: tests/pg/inbox-address-rename.pg.test.ts

-- =============================================================================
-- 1. The 'previous' status.
-- =============================================================================

ALTER TABLE public.company_inboxes DROP CONSTRAINT IF EXISTS company_inboxes_status_check;
ALTER TABLE public.company_inboxes ADD CONSTRAINT company_inboxes_status_check
  CHECK (status IN ('active', 'previous', 'deprecated', 'blocked'));

-- =============================================================================
-- 2. rename_company_inbox: a new address, the old one keeps receiving.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rename_company_inbox(p_company_id uuid)
RETURNS public.company_inboxes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_company_name text;
  v_current public.company_inboxes;
  v_local_part text;
  v_slug_seed text;
  v_new_row public.company_inboxes;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Authorization: caller must be owner/admin of the company, as for rotation.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized to rename inbox for this company'
      USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_company_name
  FROM public.companies
  WHERE id = p_company_id;

  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002';
  END IF;

  -- Locked, so two clicks cannot both turn the same row into 'previous'.
  SELECT * INTO v_current
  FROM public.company_inboxes
  WHERE company_id = p_company_id
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active inbox address to rename' USING ERRCODE = 'P0002';
  END IF;

  v_local_part := public.generate_inbox_local_part(v_company_name);
  v_slug_seed := regexp_replace(v_local_part, '-[^-]+$', '');

  IF v_slug_seed = v_current.slug_seed THEN
    RAISE EXCEPTION 'The inbox address already carries the company name'
      USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.company_inboxes
  SET status = 'previous'
  WHERE id = v_current.id;

  INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
  VALUES (p_company_id, v_local_part, v_slug_seed, 'active')
  RETURNING * INTO v_new_row;

  RETURN v_new_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.rename_company_inbox(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_company_inbox(uuid) TO authenticated, service_role;

-- =============================================================================
-- 3. rotate_company_inbox: retires the previous addresses too.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rotate_company_inbox(p_company_id uuid)
 RETURNS company_inboxes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_company_name text;
  v_local_part text;
  v_slug_seed text;
  v_new_row public.company_inboxes;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Authorization: caller must be owner/admin of the company.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized to rotate inbox for this company'
      USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_company_name
  FROM public.companies
  WHERE id = p_company_id;

  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002';
  END IF;

  -- All three steps share one transaction: a failure on any of them
  -- rolls the whole thing back, so the company never ends up without
  -- an active inbox. Every address that still receives stops: the
  -- active one and the previous ones a rename kept (20261021001100).

  UPDATE public.company_inboxes
  SET status = 'deprecated',
      deprecated_at = now()
  WHERE company_id = p_company_id
    AND status IN ('active', 'previous');

  v_local_part := public.generate_inbox_local_part(v_company_name);
  v_slug_seed := regexp_replace(v_local_part, '-[^-]+$', '');

  INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
  VALUES (p_company_id, v_local_part, v_slug_seed, 'active')
  RETURNING * INTO v_new_row;

  RETURN v_new_row;
END;
$function$;

-- =============================================================================
-- 4. Previous addresses follow the active address to another company.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.company_inboxes_previous_follow_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE public.company_inboxes
  SET company_id = NEW.company_id
  WHERE company_id = OLD.company_id
    AND status = 'previous';
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.company_inboxes_previous_follow_active() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS company_inboxes_previous_follow_active ON public.company_inboxes;
CREATE TRIGGER company_inboxes_previous_follow_active
  AFTER UPDATE OF company_id ON public.company_inboxes
  FOR EACH ROW
  WHEN (NEW.status = 'active' AND OLD.company_id IS DISTINCT FROM NEW.company_id)
  EXECUTE FUNCTION public.company_inboxes_previous_follow_active();

NOTIFY pgrst, 'reload schema';
