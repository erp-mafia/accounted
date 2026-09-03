-- Parties, phase 1f: every supplier and customer gets a party on write.
--
-- The backfill in 20260902160000 linked the rows that existed on that day;
-- rows created since (108 on prod within a day) had no party and never
-- reached the Kontakter register. A trigger closes every write path at
-- once: the dialogs, the v1 API, MCP tools, imports and provider
-- migrations. It runs BEFORE INSERT and BEFORE UPDATE OF party_id, name,
-- org_number, customer_type on customers (supplier_type on suppliers), so
-- a row whose party was cleared, or whose org number arrived later, is
-- linked or re-keyed too.
--
-- Rules, all inherited from ensure_party:
--   * find-or-create by org number inside the company; never by name;
--   * a private customer (customer_type = 'individual') carries a person's
--     identity, and a personal number is not an org number: the party is
--     created without org_number, kind = 'person', so nothing of the
--     personnummer lands in parties (customers keeps its own masked field);
--   * an empty name gets no party (ensure_party refuses one);
--   * rows in a company archived by a migration reset are immutable and
--     the trigger never fires on them (the archive is not written to).
-- Origin is 'manual' for interactive writes and 'import' when the row
-- arrives inside a migration or import: the row does not know, so the
-- trigger records 'manual' and the pipeline attaches evidence later.

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
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  NEW.party_id := public.ensure_party(NEW.company_id, NEW.user_id, NEW.name, v_org, v_kind, 'manual');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.link_party_on_role_write() FROM PUBLIC, anon;

-- SECURITY DEFINER because ensure_party checks auth.uid() against p_user_id
-- and a supplier may be created for a company by a colleague: the row's
-- user_id is the owner of record, the caller is whoever is writing. Inside
-- a trigger the write itself is already authorised by RLS on the role table.

DROP TRIGGER IF EXISTS customers_link_party ON public.customers;
CREATE TRIGGER customers_link_party
  BEFORE INSERT OR UPDATE OF party_id, name, org_number, customer_type ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.link_party_on_role_write();

DROP TRIGGER IF EXISTS suppliers_link_party ON public.suppliers;
CREATE TRIGGER suppliers_link_party
  BEFORE INSERT OR UPDATE OF party_id, name, org_number, supplier_type ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.link_party_on_role_write();

-- ensure_party runs under the definer here, where auth.uid() is still the
-- caller's; relax its identity check for trigger context by letting the
-- definer pass. The RPC path (auth.uid() = caller) is unchanged.
CREATE OR REPLACE FUNCTION public.ensure_party(
  p_company_id uuid,
  p_user_id uuid,
  p_name text,
  p_org_number text DEFAULT NULL,
  p_kind text DEFAULT 'company',
  p_origin text DEFAULT 'manual'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_org text := public.normalize_org_number(p_org_number);
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
BEGIN
  -- Authenticated callers write under their own identity; the service role
  -- (auth.uid() NULL) and the role-link trigger (pg_trigger_depth() > 0,
  -- the row's owner is the recorded user) may act for another user.
  IF pg_trigger_depth() = 0 AND auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'ensure_party: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'ensure_party: name is required';
  END IF;
  IF v_org IS NOT NULL THEN
    SELECT id INTO v_id FROM public.parties
     WHERE company_id = p_company_id AND org_number = v_org AND merged_into IS NULL
     LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO public.parties (company_id, user_id, display_name, org_number, kind, origin)
  VALUES (p_company_id, p_user_id, v_name, v_org, p_kind, p_origin)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- Lost a race on the live org-number index: return the winner.
    SELECT id INTO v_id FROM public.parties
     WHERE company_id = p_company_id AND org_number = v_org AND merged_into IS NULL
     LIMIT 1;
  END IF;
  RETURN v_id;
END;
$$;

-- Catch-up for the rows created between the backfill and this trigger.
-- Same skip rules as the backfill: nameless rows and archived companies.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.suppliers
     WHERE party_id IS NULL AND company_id IS NOT NULL
       AND nullif(btrim(name), '') IS NOT NULL
       AND company_id NOT IN (SELECT source_company_id FROM public.company_migration_resets)
     ORDER BY created_at, id
  LOOP
    UPDATE public.suppliers SET party_id = NULL WHERE id = r.id;
  END LOOP;
  FOR r IN
    SELECT id FROM public.customers
     WHERE party_id IS NULL AND company_id IS NOT NULL
       AND nullif(btrim(name), '') IS NOT NULL
       AND company_id NOT IN (SELECT source_company_id FROM public.company_migration_resets)
     ORDER BY created_at, id
  LOOP
    UPDATE public.customers SET party_id = NULL WHERE id = r.id;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
