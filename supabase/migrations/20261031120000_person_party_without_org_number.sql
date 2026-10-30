-- A private person has no org number, so neither does the party behind a
-- private customer card.
-- pg-test: covered-by tests/pg/person-party-org-number.pg.test.ts
--
-- link_party_on_role_write gives an individual card a person party without a
-- number, but only when it creates the party. A card that was a business when
-- its party was made (an import that typed private persons as companies, a
-- user who changed the type later, the register repair that retypes imported
-- cards) kept a party of kind 'company' holding the personnummer in plain
-- text as org_number: 5,689 parties in 66 companies on 2026-10-28, while the
-- cards themselves hold the number sealed in personal_number. Three changes
-- close it:
--
--   1. link_party_on_role_write: when an individual card is written and its
--      party carries an org number that no business card or supplier uses,
--      the party becomes a person without a number. A party shared with a
--      business role keeps its number: a sole trader's org number is a
--      personnummer by law, and the business card is what it identifies.
--   2. write_audit_log: the audit row of that change records that the party
--      had an org number, never the number. audit_log is append-only, so a
--      full copy of the old row would store the personnummer again, for good,
--      for every party this repairs. Everything else in the function is the
--      newest definition (20261029110000, #126).
--   3. The parties that carry one today are repaired once, below. Ten cards
--      hold no personnummer of their own (the register repair retyped them
--      when their org number was already empty), so their party's copy is
--      the only one. It goes back onto the card's org_number, where the
--      one-off repair cron (/api/customers/personal-number-repair/cron) seals
--      it into personal_number within minutes, as it did for the 720 cards
--      left from before 2026-10-14. That write runs rule 1 for the party.

CREATE OR REPLACE FUNCTION public.link_party_on_role_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_person boolean := false;
  v_org text;
  v_kind text;
  v_party_org text;
  v_merged uuid;
BEGIN
  IF NEW.company_id IS NULL OR nullif(btrim(coalesce(NEW.name, '')), '') IS NULL THEN
    RETURN NEW;
  END IF;

  -- The party was deleted and the foreign key cleared the link (ON DELETE
  -- SET NULL arrives here as an UPDATE): keep it cleared.
  IF TG_OP = 'UPDATE' AND NEW.party_id IS NULL AND OLD.party_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.parties p WHERE p.id = OLD.party_id) THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'customers' THEN
    v_is_person := (NEW.customer_type = 'individual');
  END IF;
  v_org := CASE WHEN v_is_person THEN NULL ELSE public.normalize_org_number(NEW.org_number) END;
  v_kind := CASE WHEN v_is_person THEN 'person' ELSE 'company' END;

  -- Already linked: keep the link unless the org number now points at a
  -- different live party (the user corrected it). A party without an org
  -- number simply learns it.
  IF NEW.party_id IS NOT NULL THEN
    SELECT p.org_number, p.merged_into INTO v_party_org, v_merged
    FROM public.parties p
    WHERE p.id = NEW.party_id AND p.company_id = NEW.company_id;
    IF NOT FOUND THEN
      -- A party of another company: the composite foreign key would refuse
      -- it too; refusing here keeps the error the same on every path.
      RAISE EXCEPTION 'party % is not a party of this company', NEW.party_id USING ERRCODE = '23503';
    END IF;
    IF v_merged IS NOT NULL THEN
      -- Linked to a merged party: follow the chain to the survivor.
      NEW.party_id := public.canonical_party_id(NEW.party_id);
      SELECT p.org_number INTO v_party_org FROM public.parties p WHERE p.id = NEW.party_id;
    END IF;
    IF v_org IS NOT NULL AND v_party_org IS NULL THEN
      UPDATE public.parties p SET org_number = v_org
      WHERE p.id = NEW.party_id
        AND NOT EXISTS (SELECT 1 FROM public.parties q WHERE q.company_id = NEW.company_id AND q.org_number = v_org AND q.merged_into IS NULL AND q.id <> NEW.party_id);
      RETURN NEW;
    ELSIF v_org IS NOT NULL AND v_party_org <> v_org THEN
      NEW.party_id := NULL;
    ELSIF v_is_person AND v_party_org IS NOT NULL THEN
      -- A private person has no org number: the party drops the one it got
      -- while the card was a business, unless a business card or a supplier
      -- still uses it. Before an UPDATE this row still reads as it was, so
      -- it is left out of the check.
      UPDATE public.parties p SET org_number = NULL, kind = 'person'
      WHERE p.id = NEW.party_id
        AND NOT EXISTS (SELECT 1 FROM public.customers c
                        WHERE c.party_id = NEW.party_id AND c.id <> NEW.id
                          AND c.customer_type IS DISTINCT FROM 'individual')
        AND NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.party_id = NEW.party_id);
      RETURN NEW;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  NEW.party_id := public.ensure_party(NEW.company_id, NEW.user_id, NEW.name, v_org, v_kind, 'manual');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  -- Sandbox teardown (cleanup_sandbox_user) deletes the company row itself;
  -- audit rows inserted mid-cascade would reference the vanishing company
  -- and violate audit_log_company_id_fkey. The flag is transaction-local and
  -- only set after the RPC's is_sandbox check.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;

    -- A party that becomes a person drops its org number, which was a
    -- personnummer (link_party_on_role_write): the trail records that it was
    -- set, never the value.
    IF TG_TABLE_NAME = 'parties'
       AND v_new_state->>'kind' = 'person'
       AND v_new_state->>'org_number' IS NULL
       AND v_old_state->>'org_number' IS NOT NULL THEN
      v_old_state := (v_old_state - 'org_number') || jsonb_build_object('org_number_set', true);
    END IF;
  END IF;

  -- The actor is the session's user. Without a session (the service role)
  -- the row's user_id, its owner or creator, stands in as before (#126).
  v_user_id := COALESCE(auth.uid(), v_user_id);

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- Rule 3, once. Audited as the system (the 20260911190100 pattern): one
-- audit_parties row per repaired party, without the number. Explicit
-- transaction so the SET LOCALs hold for the UPDATEs. Re-running is a no-op:
-- a repaired party has no org number left.
BEGIN;

SET LOCAL gnubok.actor_type = 'system';
SET LOCAL gnubok.actor_label = 'migration 20261031120000 person_party_without_org_number';

-- The cards whose only personnummer is their party's copy get it back, for
-- the cron to seal. Setting org_number runs link_party_on_role_write, which
-- drops the party's copy in the same write. customers has no audit trigger,
-- so the trace is written here: ids and the action, never the number.
WITH restored AS (
  UPDATE public.customers c
  SET org_number = p.org_number
  FROM public.parties p
  WHERE p.id = c.party_id
    AND c.customer_type = 'individual'
    AND c.personal_number IS NULL
    AND (c.org_number IS NULL OR btrim(c.org_number) = '')
    AND p.org_number IS NOT NULL
    AND p.merged_into IS NULL
    -- A personnummer's month and day (samordningsnummer: day + 60), as
    -- looksLikeSwedishPersonalNumber reads them; an organisation's month is 20 or more.
    AND substr(p.org_number, 3, 2)::int BETWEEN 1 AND 12
    AND (substr(p.org_number, 5, 2)::int BETWEEN 1 AND 31 OR substr(p.org_number, 5, 2)::int BETWEEN 61 AND 91)
    AND NOT EXISTS (SELECT 1 FROM public.customers b WHERE b.party_id = p.id AND b.customer_type IS DISTINCT FROM 'individual')
    AND NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.party_id = p.id)
  RETURNING c.id, c.company_id, c.user_id
)
INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, actor_type, actor_label, old_state, new_state, description)
SELECT r.user_id, r.company_id, 'UPDATE', 'customers', r.id, NULL, 'system',
       'migration 20261031120000 person_party_without_org_number',
       jsonb_build_object('org_number_set', false),
       jsonb_build_object('org_number_set', true, 'repair_action', 'restore_from_party'),
       'Individual customer: the personnummer its party held is put back for the personnummer repair to seal into personal_number'
FROM restored r;

UPDATE public.parties p
SET org_number = NULL, kind = 'person'
WHERE p.org_number IS NOT NULL
  AND p.merged_into IS NULL
  AND EXISTS (SELECT 1 FROM public.customers c WHERE c.party_id = p.id AND c.customer_type = 'individual')
  AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.party_id = p.id AND c.customer_type IS DISTINCT FROM 'individual')
  AND NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.party_id = p.id)
  -- Every card holds the personnummer itself, so the party's copy is not
  -- the last one.
  AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.party_id = p.id AND c.personal_number IS NULL);

COMMIT;
