-- A Skatteverket connection is written only by the person who made it.
--
-- A skatteverket_tokens row holds one person's BankID session with
-- Skatteverket for one company: one row per (user_id, company_id)
-- (20260814060000_skatteverket_tokens_per_company.sql). The write policies,
-- last defined in 20260702093000_rls_role_gate_and_voucher_rpc_guards.sql,
-- checked the active company and write access but not whose row it is, so a
-- session could write a row under another member's user_id, or change or
-- delete another member's row.
--
-- Now INSERT, UPDATE and DELETE through a session also require the row to be
-- the caller's own: user_id = auth.uid(), on top of the company and
-- write-access checks they had. The UPDATE policy gets a WITH CHECK, so an
-- update cannot hand a row to someone else either (without one, Postgres
-- checked the new row against USING, which did not name the user).
--
-- SELECT is unchanged and company-wide: a company read may run on any
-- member's live connection (findCompanyTokenUser in
-- src/extensions/general/skatteverket/lib/resolve-auth.ts), and the token
-- columns stay withheld from end users by column grants
-- (20260929173432_withhold_credential_columns_from_end_users.sql).
--
-- No existing connection changes. The application writes this table only
-- through the service-role client in
-- src/extensions/general/skatteverket/lib/token-store.ts (connect, refresh,
-- the needs_reconsent flag, disconnect, clearing a revoked token), and RLS
-- does not apply to it. That covers a refresh of another member's token that
-- serves a company read: it goes back to that member's row through the same
-- client. The SECURITY DEFINER account erasure and company migration reset
-- run as the table owner and are not affected either.
--
-- ALTER POLICY keeps each policy's name, command, roles and permissiveness,
-- and there is no moment without a policy. The short lock_timeout makes the
-- migration fail fast instead of queueing reads of the table behind it.
--
-- pg-test: tests/pg/skatteverket-tokens-own-row-writes.pg.test.ts

SELECT set_config('lock_timeout', '2s', true);

ALTER POLICY skatteverket_tokens_insert ON public.skatteverket_tokens
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND user_id = (SELECT auth.uid())
  );

ALTER POLICY skatteverket_tokens_update ON public.skatteverket_tokens
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND user_id = (SELECT auth.uid())
  )
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND user_id = (SELECT auth.uid())
  );

ALTER POLICY skatteverket_tokens_delete ON public.skatteverket_tokens
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND user_id = (SELECT auth.uid())
  );
