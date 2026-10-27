-- O08 (run t1027): RLS initplan rewrite for the hottest flagged tables.
--
-- The Supabase performance advisor (auth_rls_initplan) flags policies that
-- call auth.uid() bare: Postgres then evaluates it once per row instead of
-- once per statement. Wrapping it as (SELECT auth.uid()) turns the call into
-- an initplan, evaluated once. The meaning is identical: auth.uid() is
-- STABLE and reads the request's JWT claim, which cannot change inside a
-- statement.
--
-- Scope: the 12 most-scanned tables in the advisor list whose flagged
-- policies filter rows (USING) or guard writes (WITH CHECK), 30 policies.
-- Every expression below is the live pg_policies definition with only
-- auth.uid() wrapped; roles, command and permissiveness are untouched
-- (ALTER POLICY keeps them). ALTER POLICY, never DROP/CREATE, so there is
-- no window without a policy.
--
-- Left out on purpose (follow-up):
--   * webhooks: open MR !904 rewrites "Members can view company webhooks";
--     altering it here could undo that change depending on merge order.
--   * companies, teams, pending_operations, stripe/shopify/woocommerce/
--     zettle_connections, suggestion_log: the flagged policy is INSERT-only
--     (WITH CHECK runs once per inserted row anyway), so there is no gain to
--     buy with an ACCESS EXCLUSIVE lock on a busy table.
--   * the remaining ~40 low-traffic tables in the advisor list.
--
-- Locking: every ALTER POLICY takes ACCESS EXCLUSIVE on its table until
-- commit. A short lock_timeout makes the migration fail fast instead of
-- queueing traffic behind it, and the tables run coldest first so the hot
-- ones are held for the shortest time.

SELECT set_config('lock_timeout', '2s', true);

-- company_inboxes -------------------------------------------------------------

ALTER POLICY company_inboxes_insert ON public.company_inboxes
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text])
    )
  );

ALTER POLICY company_inboxes_update ON public.company_inboxes
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text])
    )
  );

-- notice_dismissals -----------------------------------------------------------

ALTER POLICY "Users see their own notice dismissals" ON public.notice_dismissals
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = (SELECT auth.uid())
  );

ALTER POLICY "Users insert their own notice dismissals" ON public.notice_dismissals
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = (SELECT auth.uid())
  );

ALTER POLICY "Users update their own notice dismissals" ON public.notice_dismissals
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = (SELECT auth.uid())
  )
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = (SELECT auth.uid())
  );

ALTER POLICY "Users delete their own notice dismissals" ON public.notice_dismissals
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = (SELECT auth.uid())
  );

-- company_skills --------------------------------------------------------------

ALTER POLICY company_skills_read ON public.company_skills
  USING (
    company_id IN (SELECT public.user_company_ids())
    OR team_id IN (
      SELECT tm.team_id FROM public.team_members tm
      WHERE tm.user_id = (SELECT auth.uid())
    )
    OR team_id IN (
      SELECT c.team_id FROM public.companies c
      WHERE c.id IN (SELECT public.user_company_ids())
    )
  );

ALTER POLICY company_skills_insert ON public.company_skills
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND (
      (
        company_id IN (SELECT public.user_company_ids())
        AND EXISTS (
          SELECT 1 FROM public.company_members cm
          WHERE cm.company_id = company_skills.company_id
            AND cm.user_id = (SELECT auth.uid())
            AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
        )
      )
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.team_id = company_skills.team_id
          AND tm.user_id = (SELECT auth.uid())
          AND tm.role = ANY (ARRAY['owner'::text, 'admin'::text])
      )
    )
  );

ALTER POLICY company_skills_update ON public.company_skills
  USING (
    EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = company_skills.company_id
        AND cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    OR EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.team_id = company_skills.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role = ANY (ARRAY['owner'::text, 'admin'::text])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = company_skills.company_id
        AND cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    OR EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.team_id = company_skills.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role = ANY (ARRAY['owner'::text, 'admin'::text])
    )
  );

ALTER POLICY company_skills_delete ON public.company_skills
  USING (
    share_status = 'private'::text
    AND (
      EXISTS (
        SELECT 1 FROM public.company_members cm
        WHERE cm.company_id = company_skills.company_id
          AND cm.user_id = (SELECT auth.uid())
          AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
      )
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.team_id = company_skills.team_id
          AND tm.user_id = (SELECT auth.uid())
          AND tm.role = ANY (ARRAY['owner'::text, 'admin'::text])
      )
    )
  );

-- idempotency_keys ------------------------------------------------------------

ALTER POLICY idempotency_keys_select_own ON public.idempotency_keys
  USING ((SELECT auth.uid()) = user_id);

-- account_reconciliation_settlements ------------------------------------------

ALTER POLICY account_reconciliation_settlements_insert ON public.account_reconciliation_settlements
  WITH CHECK (
    settled_by = (SELECT auth.uid())
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    AND EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.id = account_reconciliation_settlements.journal_entry_id
        AND je.company_id = account_reconciliation_settlements.company_id
    )
  );

ALTER POLICY account_reconciliation_settlements_update ON public.account_reconciliation_settlements
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  )
  WITH CHECK (
    (undone_by IS NULL OR undone_by = (SELECT auth.uid()))
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

-- account_reconciliations -----------------------------------------------------

ALTER POLICY account_reconciliations_insert ON public.account_reconciliations
  WITH CHECK (
    signed_by = (SELECT auth.uid())
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

ALTER POLICY account_reconciliations_update ON public.account_reconciliations
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

-- profiles --------------------------------------------------------------------

ALTER POLICY profiles_select ON public.profiles
  USING ((SELECT auth.uid()) = id);

ALTER POLICY profiles_insert ON public.profiles
  WITH CHECK ((SELECT auth.uid()) = id);

ALTER POLICY profiles_update ON public.profiles
  USING ((SELECT auth.uid()) = id);

-- expense_payout_batches ------------------------------------------------------

ALTER POLICY expense_payout_batches_insert ON public.expense_payout_batches
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

ALTER POLICY expense_payout_batches_update ON public.expense_payout_batches
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

ALTER POLICY expense_payout_batches_delete ON public.expense_payout_batches
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

-- expense_claims --------------------------------------------------------------

ALTER POLICY expense_claims_insert ON public.expense_claims
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

ALTER POLICY expense_claims_update ON public.expense_claims
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

ALTER POLICY expense_claims_delete ON public.expense_claims
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
  );

-- invoice_deliveries ----------------------------------------------------------

ALTER POLICY invoice_deliveries_select ON public.invoice_deliveries
  USING (
    company_id = public.current_active_company_id()
    AND user_id = (SELECT auth.uid())
  );

-- api_keys --------------------------------------------------------------------

ALTER POLICY api_keys_insert ON public.api_keys
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.user_is_company_admin(company_id)
  );

ALTER POLICY api_keys_select ON public.api_keys
  USING (
    user_id = (SELECT auth.uid())
    OR public.user_is_company_admin(company_id)
  );

-- user_preferences ------------------------------------------------------------

ALTER POLICY user_preferences_insert ON public.user_preferences
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY user_preferences_select ON public.user_preferences
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY user_preferences_update ON public.user_preferences
  USING ((SELECT auth.uid()) = user_id);
