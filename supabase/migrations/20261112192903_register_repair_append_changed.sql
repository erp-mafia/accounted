-- crm#1436: the register repair keeps its revert trail card by card.
-- pg-test: tests/pg/register-repair-progress.pg.test.ts
--
-- register_repair_progress.changed lists every card the one-off repair
-- changed, with what the card held before: the whole revert
-- (20261027184914). The cron wrote it once per company and run, after the
-- last card, by reading the array and writing it back longer. A run the
-- platform ended before that write (27 of them in 30 days, 2026-11) had
-- changed cards and kept no record of what they held, and two runs working
-- the same company could each write the array back without the other's
-- entries.
--
-- append_register_repair_changed adds entries in one statement, so the cron
-- calls it for each card as it is written and concurrent runs cannot lose
-- each other's. It creates the row when the company has none yet; the cron's
-- own progress write (cursor, outcome, counts) never touches `changed`.
-- Dropped together with the table and the cron.

CREATE FUNCTION public.append_register_repair_changed(p_company_id uuid, p_provider text, p_cards jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF p_cards IS NULL OR jsonb_typeof(p_cards) <> 'array' THEN
    RAISE EXCEPTION 'REGISTER_REPAIR_CARDS_NOT_AN_ARRAY';
  END IF;
  INSERT INTO public.register_repair_progress AS p (company_id, provider, changed)
  VALUES (p_company_id, p_provider, p_cards)
  ON CONFLICT (company_id, provider) DO UPDATE SET changed = p.changed || excluded.changed;
END $$;
REVOKE ALL ON FUNCTION public.append_register_repair_changed(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_register_repair_changed(uuid, text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
