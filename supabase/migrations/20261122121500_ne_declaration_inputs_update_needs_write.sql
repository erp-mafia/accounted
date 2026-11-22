-- =============================================================================
-- ne_declaration_inputs: an UPDATE needs write access to the row's own company
--
-- The UPDATE policy of 20261119235300 checked only membership in USING, and
-- the writer-role trigger reads NEW.company_id. A viewer of company A who
-- writes in company B could therefore point an A row at B (with one of B's
-- periods) and so remove A's NE-bilaga inputs. USING now also requires write
-- access to the company the row belongs to before the update.
-- pg-test: covered-by tests/pg/ne-declaration-inputs.pg.test.ts
-- =============================================================================

DROP POLICY "update own-company ne_declaration_inputs" ON public.ne_declaration_inputs;

CREATE POLICY "update own-company ne_declaration_inputs"
  ON public.ne_declaration_inputs FOR UPDATE
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  )
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

NOTIFY pgrst, 'reload schema';
