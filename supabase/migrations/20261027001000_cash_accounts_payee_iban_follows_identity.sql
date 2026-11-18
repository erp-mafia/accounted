-- A printed IBAN that was a copy of its account's bank IBAN follows the
-- account when its bank identity is rewritten (crm#1483).
-- pg-test: tests/pg/cash-accounts-payee-iban-follows-identity.pg.test.ts
--
-- What happened. cash_accounts carries two IBANs since 20260904010000: iban,
-- the bank's identity of the account (written by bank sync and connection
-- pairing), and payee_iban, what customer invoices print and what the
-- mirror copies into company_settings.iban for the SEK default. They were
-- split so that a sync never rewrites an invoice instruction. A user who
-- prints the account's own bank IBAN (the settings form's "Hämta från
-- bankkopplingen" prefill, or the bank-IBAN default option) stores a copy of
-- the identity in payee_iban. No writer of the identity looks at the printed
-- IBAN, so the copy stays behind when the identity changes: one company's
-- 1930 row was later bound to its transaction account (that rewrite left no
-- audit row) while its SEK default kept printing the savings IBAN, by then
-- the identity of its 1931 row.
--
-- What changes.
--   1. A BEFORE UPDATE OF iban trigger. When the old printed IBAN was a copy
--      of the old identity (compared without spaces, upper case), the
--      identity changes to another non-null value and the statement does
--      not write payee_iban itself, payee_iban takes the new identity in the
--      form updateCashAccountPayee stores (no spaces, upper case). An
--      identity cleared to null leaves the printed IBAN as it is, and a
--      printed IBAN that is not a copy (typed, or another account's) is
--      never touched: that is the company's own choice, and the 2026-09-04
--      rule stands for it.
--   2. Who may change where customers pay stays as it was: owner or admin,
--      the service role and migrations (cash_accounts_payee_admin_only). A
--      member may write the identity (the bank picker runs on a member's
--      session), but for a member the copy does not follow: otherwise a
--      direct write of iban would let a member decide what invoices print.
--      An admin then sees the stale copy as the settings flag. The trigger
--      sorts before cash_accounts_payee_admin_only (triggers of one kind fire
--      in name order), so that gate still sees the carried value last.
--   3. The mirror and the audit trail need no change: their AFTER UPDATE
--      triggers (mirror_invoice_payee_defaults_on_cash_account,
--      audit_cash_accounts_invoice_payee) compare OLD with the final NEW, so
--      a carried payee_iban re-mirrors company_settings and is audited like
--      an admin's edit, with the new identity in new_state.
--   4. Repair, only where the stale copy is provable: the printed IBAN
--      differs from the row's identity, equals another row's identity in the
--      same company, and the audit row that set the printed IBAN to its
--      current value (the latest change into it) shows the row's own
--      identity was that IBAN then. Rows that print another account's IBAN
--      for any other reason (the 2026-09-04 backfill, typing, a connection
--      creating a row for an IBAN another row prints) keep it: their intent
--      is unknown, and the settings flag shows them. Companies that are a
--      migration-reset source are skipped (their rows are immutable by
--      trigger). The company lock is taken waiting first, so
--      bank_configuration_writer_guard's NOWAIT lock does not fail the
--      migration while a bank sync holds it.

CREATE OR REPLACE FUNCTION public.cash_accounts_payee_iban_follows_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old_identity text := nullif(upper(regexp_replace(OLD.iban, '\s', '', 'g')), '');
  v_new_identity text := nullif(upper(regexp_replace(NEW.iban, '\s', '', 'g')), '');
BEGIN
  IF v_old_identity IS NULL
    OR v_new_identity IS NULL
    OR v_new_identity = v_old_identity
    OR NEW.payee_iban IS DISTINCT FROM OLD.payee_iban
    OR nullif(upper(regexp_replace(OLD.payee_iban, '\s', '', 'g')), '') IS DISTINCT FROM v_old_identity
  THEN
    RETURN NEW;
  END IF;
  -- The same writers cash_accounts_payee_admin_only lets change a payee
  -- column; a member's identity write leaves the printed IBAN alone.
  IF auth.uid() IS NOT NULL AND NOT public.user_is_company_admin(NEW.company_id) THEN
    RETURN NEW;
  END IF;
  NEW.payee_iban := v_new_identity;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cash_accounts_payee_iban_follows_identity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cash_accounts_identity_carries_payee_iban ON public.cash_accounts;
CREATE TRIGGER cash_accounts_identity_carries_payee_iban
  BEFORE UPDATE OF iban ON public.cash_accounts
  FOR EACH ROW EXECUTE FUNCTION public.cash_accounts_payee_iban_follows_identity();

COMMENT ON COLUMN public.cash_accounts.payee_iban IS
  'IBAN printed on customer invoices. Separate from iban (the bank identity written by sync): a sync never rewrites a printed IBAN the company chose, but a copy of the identity follows it when the identity changes (trigger cash_accounts_identity_carries_payee_iban, owner/admin and system writers only).';

DO $$
DECLARE
  v_row record;
  v_repaired integer := 0;
BEGIN
  PERFORM set_config('gnubok.actor_type', 'system', true);
  PERFORM set_config('gnubok.actor_label', 'migration 20261027001000 cash_accounts_payee_iban_follows_identity', true);

  FOR v_row IN
    WITH mismatched AS MATERIALIZED (
      SELECT c.id, c.company_id,
             nullif(upper(regexp_replace(c.iban, '\s', '', 'g')), '') AS identity,
             nullif(upper(regexp_replace(c.payee_iban, '\s', '', 'g')), '') AS printed
        FROM public.cash_accounts c
       WHERE NOT EXISTS (SELECT 1 FROM public.company_migration_resets m WHERE m.source_company_id = c.company_id)
         AND nullif(upper(regexp_replace(c.iban, '\s', '', 'g')), '') IS NOT NULL
         AND nullif(upper(regexp_replace(c.payee_iban, '\s', '', 'g')), '')
             <> nullif(upper(regexp_replace(c.iban, '\s', '', 'g')), '')
         AND EXISTS (
           SELECT 1 FROM public.cash_accounts o
            WHERE o.company_id = c.company_id AND o.id <> c.id
              AND nullif(upper(regexp_replace(o.iban, '\s', '', 'g')), '')
                = nullif(upper(regexp_replace(c.payee_iban, '\s', '', 'g')), ''))
    )
    SELECT m.id, m.company_id, m.identity
      FROM mismatched m
     WHERE (
       SELECT nullif(upper(regexp_replace(a.new_state->>'iban', '\s', '', 'g')), '')
         FROM public.audit_log a
        WHERE a.table_name = 'cash_accounts' AND a.record_id = m.id
          AND nullif(upper(regexp_replace(a.new_state->>'payee_iban', '\s', '', 'g')), '') = m.printed
          AND nullif(upper(regexp_replace(a.old_state->>'payee_iban', '\s', '', 'g')), '') IS DISTINCT FROM m.printed
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1
     ) = m.printed
     ORDER BY m.company_id, m.id
  LOOP
    PERFORM public.lock_cash_account_company(v_row.company_id);
    UPDATE public.cash_accounts SET payee_iban = v_row.identity
     WHERE id = v_row.id AND company_id = v_row.company_id;
    v_repaired := v_repaired + 1;
  END LOOP;

  PERFORM set_config('gnubok.actor_type', '', true);
  PERFORM set_config('gnubok.actor_label', '', true);
  RAISE NOTICE 'printed IBAN repair: % stale copies now print their own account''s IBAN', v_repaired;
END;
$$;
