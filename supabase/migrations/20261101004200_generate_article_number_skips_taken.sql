-- generate_article_number: skip numbers that are already taken (accounted#58 P1.11).
--
-- The counter in company_settings.next_article_number knows nothing about
-- numbers typed by hand or imported from a file or another system. When the
-- counter reached such a number, the article UPDATE hit the unique index
-- uq_articles_company_number, the whole call rolled back (counter included),
-- and every later automatic number failed the same way: the article was saved
-- without a number until the user typed one by hand.
--
-- Body copied from 20260901100000_revoke_anon_execute_on_definer_writes.sql
-- (the latest definition; identical to prod on 2026-11-01). Only the allocation
-- step changes: lock the counter row, walk forward to the first number not
-- taken in the company, assign it, and move the counter past it. A unique
-- violation from a concurrent manual insert of the same number is caught and
-- the walk continues, so the call never fails on a collision. Lock order is
-- unchanged (article row, then company_settings row), so no new deadlock path.
--
-- Existing stuck counters need no data repair: the next call moves them past
-- the taken numbers. Safe on a live database: CREATE OR REPLACE swaps the body
-- atomically and keeps the signature, owner and grants (restated below anyway).

CREATE OR REPLACE FUNCTION public.generate_article_number(
  p_company_id uuid,
  p_article_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_existing text;
  v_number integer;
  v_trusted boolean;
BEGIN
  -- Same fail-closed rule as generate_invoice_number.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT article_number INTO v_existing
  FROM public.articles
  WHERE id = p_article_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Article % not found in company %', p_article_id, p_company_id;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Lock the counter row until commit: concurrent callers in the same company
  -- serialize here.
  SELECT next_article_number INTO v_number
  FROM public.company_settings
  WHERE company_id = p_company_id
  FOR UPDATE;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  -- Walk to the first number not taken in this company. The unique index
  -- still guards the write: a manual insert of the same number that lands
  -- between the check and the UPDATE raises unique_violation, which only
  -- rolls back this inner block, and the walk moves on.
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.articles
      WHERE company_id = p_company_id AND article_number = v_number::text
    ) THEN
      BEGIN
        UPDATE public.articles
        SET article_number = v_number::text
        WHERE id = p_article_id AND company_id = p_company_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
    END IF;
    v_number := v_number + 1;
  END LOOP;

  UPDATE public.company_settings
  SET next_article_number = v_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id;

  RETURN v_number::text;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_article_number(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_article_number(uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_article_number(uuid, uuid) IS
  'Assigns the next free article number to p_article_id, skipping numbers already taken in the company (typed by hand or imported), and moves the counter past it. Requires the caller to be a member of p_company_id; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';
