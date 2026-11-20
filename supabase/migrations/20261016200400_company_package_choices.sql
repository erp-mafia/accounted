-- A company's package choice records who decided it, and every change is a
-- dated line in behandlingshistorik (BFNAR 2013:2 p. 9.16: changes to how
-- the system processes the bookkeeping, with when they were made).
--
-- Profiles and Suggestions, step 3. A company's choice for a package (Lön,
-- Kundfakturor, Kassa och webbshop, ...) is the company_capability_config row
-- `package:<id>` (src/lib/modules/packages.ts; absent: the profile decides).
-- Until now nothing wrote one. The staged operations enable_package and
-- disable_package (20261016200000) write it through
-- set_company_package_choice below, after a person approved them.
--
-- 1. company_capability_config gains who decided, nullable so every existing
--    row (capability keys and package keys alike) is unchanged:
--      source               'suggestion' (a detector proposed it and a person
--                           approved) or 'company' (the company asked for it
--                           itself); NULL on rows written before this.
--      decided_by           the person who approved (an owner or admin).
--      decided_actor_type,  the credential that relayed the approval (user,
--      decided_actor_label  api_key with the key's name, ...), as
--                           journal_entries.committed_actor_* records it.
--      decided_at           when.
--      pending_operation_id the approved staged operation, whose row holds
--                           who or what proposed it.
--    The CHECK on source is NOT VALID here; 20261016200500 validates it.
--
-- 2. package_open_obligations(company, package): what still has to be
--    settled through a package before it may be switched off: an unpaid
--    invoice, a salary run not booked, an active employee or bank
--    connection, an asset still in the register, ... (one code each).
--    "Winding down", where a switched-off package stays visible until its
--    obligations are settled, is not built yet, so switching off refuses
--    while any is open. Conservative on purpose: a code too many keeps a
--    package visible, never hides open work.
--
-- 3. package_usage(company, since): for every switchable package, whether it
--    was used since the given time and its open obligations, in one call: the
--    input of the "hide an unused package" detector (behind
--    SUGGESTIONS_HIDE_UNUSED, src/lib/suggestions).
--
-- 4. set_company_package_choice: the one write of a package choice. Re-checks
--    that the deciding user is an owner or admin of the company (the commit
--    runs it through the service role, so RLS does not), refuses to switch a
--    package off while it has open obligations (in the same transaction as
--    the write), upserts the row with who decided, and writes the audit_log
--    row behandlingshistorik reads (table company_capability_config). A
--    choice equal to the stored one writes nothing. service_role only.
--
-- Nothing here touches the bookkeeping: no journal table, no trigger of
-- migration 017.
--
-- pg-test: tests/pg/company-package-choices.pg.test.ts

-- company_capability_config is read by every dashboard render (the menu and
-- the paywall): never queue those reads behind a long ALTER.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. Who decided
-- =============================================================================

ALTER TABLE public.company_capability_config
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_actor_type text,
  ADD COLUMN IF NOT EXISTS decided_actor_label text,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_operation_id uuid REFERENCES public.pending_operations(id) ON DELETE SET NULL;

ALTER TABLE public.company_capability_config
  ADD CONSTRAINT company_capability_config_source_check
  CHECK (source IS NULL OR source IN ('company', 'suggestion')) NOT VALID;

COMMENT ON COLUMN public.company_capability_config.source IS
  'Who asked for this choice: suggestion (a detector proposed it, a person approved) or company (the company itself). NULL on rows written before 20261016200400.';
COMMENT ON COLUMN public.company_capability_config.decided_by IS
  'The owner or admin who approved the choice (set_company_package_choice). The audit_log row of the change names them too.';
COMMENT ON COLUMN public.company_capability_config.decided_actor_type IS
  'The credential that relayed the approval (user, api_key, mcp_oauth, agent_chat, service_account, ...), as journal_entries.committed_actor_type records it for a commit.';
COMMENT ON COLUMN public.company_capability_config.pending_operation_id IS
  'The approved staged operation (enable_package or disable_package) that wrote this choice; its row names who or what proposed it.';

-- =============================================================================
-- 2. Open obligations per package
-- =============================================================================

CREATE FUNCTION public.package_open_obligations(p_company_id uuid, p_package_id text)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(o.kind ORDER BY o.kind), ARRAY[]::text[])
  FROM (
    -- Bank: a live connection still reads bank lines in.
    SELECT 'active_bank_connection'::text AS kind
     WHERE p_package_id = 'bank'
       AND EXISTS (SELECT 1 FROM public.bank_connections b
                    WHERE b.company_id = p_company_id AND b.status IN ('active', 'pending_selection', 'error'))
    UNION ALL
    -- Kundfakturor: money still owed, invoices still generated, cases still open.
    SELECT 'unpaid_customer_invoices'
     WHERE p_package_id = 'customer-invoices'
       AND EXISTS (SELECT 1 FROM public.invoices i
                    WHERE i.company_id = p_company_id AND i.document_type = 'invoice'
                      AND i.status IN ('sent', 'overdue', 'partially_paid'))
    UNION ALL
    SELECT 'active_recurring_invoices'
     WHERE p_package_id = 'customer-invoices'
       AND EXISTS (SELECT 1 FROM public.recurring_invoice_schedules r
                    WHERE r.company_id = p_company_id AND r.status = 'active')
    UNION ALL
    SELECT 'open_collection_cases'
     WHERE p_package_id = 'customer-invoices'
       AND EXISTS (SELECT 1 FROM public.collection_cases c
                    WHERE c.company_id = p_company_id AND c.is_open)
    UNION ALL
    -- Leverantörsfakturor och betalningar: invoices still to pay, payments on their way.
    SELECT 'unpaid_supplier_invoices'
     WHERE p_package_id = 'supplier-invoices-and-payments'
       AND EXISTS (SELECT 1 FROM public.supplier_invoices s
                    WHERE s.company_id = p_company_id AND NOT s.is_credit_note
                      AND s.status IN ('registered', 'approved', 'partially_paid', 'overdue', 'disputed'))
    UNION ALL
    SELECT 'payments_in_flight'
     WHERE p_package_id = 'supplier-invoices-and-payments'
       AND EXISTS (SELECT 1 FROM public.payment_orders p
                    WHERE p.company_id = p_company_id
                      AND p.status IN ('draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'))
    UNION ALL
    -- Kvitton och underlag: underlag not yet handled (the Att göra inbox row's predicate).
    SELECT 'unhandled_documents'
     WHERE p_package_id = 'receipts-and-documents'
       AND EXISTS (SELECT 1 FROM public.invoice_inbox_items i
                    WHERE i.company_id = p_company_id AND i.document_id IS NOT NULL
                      AND i.created_supplier_invoice_id IS NULL AND i.created_journal_entry_id IS NULL
                      AND i.matched_transaction_id IS NULL AND i.routed_to_arkiv_at IS NULL
                      AND NOT EXISTS (SELECT 1 FROM public.document_attachments d
                                       WHERE d.id = i.document_id AND d.journal_entry_id IS NOT NULL))
    UNION ALL
    -- Utlägg: people still to pay back, trips still to book.
    SELECT 'unpaid_expense_claims'
     WHERE p_package_id = 'expenses'
       AND EXISTS (SELECT 1 FROM public.expense_claims e
                    WHERE e.company_id = p_company_id AND e.status = 'registered')
    UNION ALL
    SELECT 'unbooked_mileage'
     WHERE p_package_id = 'expenses'
       AND EXISTS (SELECT 1 FROM public.mileage_trips m
                    WHERE m.company_id = p_company_id AND m.status = 'draft')
    UNION ALL
    -- Lön: people employed, runs not finished, declarations not filed.
    SELECT 'active_employees'
     WHERE p_package_id = 'payroll'
       AND EXISTS (SELECT 1 FROM public.employees e
                    WHERE e.company_id = p_company_id AND e.is_active
                      AND (e.employment_end IS NULL OR e.employment_end >= current_date))
    UNION ALL
    SELECT 'open_salary_runs'
     WHERE p_package_id = 'payroll'
       AND EXISTS (SELECT 1 FROM public.salary_runs r
                    WHERE r.company_id = p_company_id AND r.status IN ('draft', 'review', 'approved', 'paid'))
    UNION ALL
    SELECT 'unfiled_agi'
     WHERE p_package_id = 'payroll'
       AND EXISTS (SELECT 1 FROM public.agi_declarations a
                    WHERE a.company_id = p_company_id AND a.status IN ('generated', 'pending_signature', 'rejected'))
    UNION ALL
    -- Inventarier: an asset still in the register keeps being depreciated.
    SELECT 'active_assets'
     WHERE p_package_id = 'assets'
       AND EXISTS (SELECT 1 FROM public.assets a
                    WHERE a.company_id = p_company_id AND a.disposed_at IS NULL)
    UNION ALL
    -- Kassa och webbshop: connections still reading sales in, days and orders not booked.
    SELECT 'active_pos_connection'
     WHERE p_package_id = 'pos-and-webshop'
       AND EXISTS (SELECT 1 FROM public.pos_connections p
                    WHERE p.company_id = p_company_id AND p.status <> 'disconnected')
    UNION ALL
    SELECT 'unbooked_pos_days'
     WHERE p_package_id = 'pos-and-webshop'
       AND EXISTS (SELECT 1 FROM public.pos_sales_days d
                    WHERE d.company_id = p_company_id AND d.status IN ('ready', 'needs_review'))
    UNION ALL
    SELECT 'active_webshop_connection'
     WHERE p_package_id = 'pos-and-webshop'
       AND (EXISTS (SELECT 1 FROM public.woocommerce_connections w WHERE w.company_id = p_company_id AND w.status <> 'revoked')
         OR EXISTS (SELECT 1 FROM public.shopify_connections s WHERE s.company_id = p_company_id AND s.status <> 'revoked')
         OR EXISTS (SELECT 1 FROM public.zettle_connections z WHERE z.company_id = p_company_id AND z.status <> 'revoked'))
    UNION ALL
    SELECT 'unbooked_webshop_orders'
     WHERE p_package_id = 'pos-and-webshop'
       AND EXISTS (SELECT 1 FROM public.webshop_orders o
                    WHERE o.company_id = p_company_id AND (o.is_paid OR o.row_type = 'refund')
                      AND o.journal_entry_id IS NULL AND o.invoice_id IS NULL AND o.manually_booked_at IS NULL)
    UNION ALL
    -- Anything else (Bokföring, an unknown id) is never free to switch off.
    SELECT 'not_switchable'
     WHERE p_package_id IS NULL
        OR p_package_id NOT IN ('bank', 'customer-invoices', 'supplier-invoices-and-payments', 'receipts-and-documents',
                                'expenses', 'payroll', 'assets', 'pos-and-webshop')
  ) o;
$$;

REVOKE ALL ON FUNCTION public.package_open_obligations(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.package_open_obligations(uuid, text) TO service_role;

-- =============================================================================
-- 3. Use and obligations of every switchable package
-- =============================================================================

CREATE FUNCTION public.package_usage(p_company_id uuid, p_since timestamptz)
RETURNS TABLE (package_id text, used_since boolean, open_obligations text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.package_id,
         CASE p.package_id
           WHEN 'bank' THEN EXISTS (
             SELECT 1 FROM public.bank_connections b
              WHERE b.company_id = p_company_id AND (b.created_at >= p_since OR b.last_synced_at >= p_since))
           WHEN 'customer-invoices' THEN EXISTS (
             SELECT 1 FROM public.invoices i WHERE i.company_id = p_company_id AND i.created_at >= p_since)
           WHEN 'supplier-invoices-and-payments' THEN EXISTS (
             SELECT 1 FROM public.supplier_invoices s WHERE s.company_id = p_company_id AND s.created_at >= p_since)
             OR EXISTS (SELECT 1 FROM public.payment_orders o WHERE o.company_id = p_company_id AND o.created_at >= p_since)
           WHEN 'receipts-and-documents' THEN EXISTS (
             SELECT 1 FROM public.invoice_inbox_items i WHERE i.company_id = p_company_id AND i.created_at >= p_since)
           WHEN 'expenses' THEN EXISTS (
             SELECT 1 FROM public.expense_claims e WHERE e.company_id = p_company_id AND e.created_at >= p_since)
             OR EXISTS (SELECT 1 FROM public.mileage_trips m WHERE m.company_id = p_company_id AND m.created_at >= p_since)
           WHEN 'payroll' THEN EXISTS (
             SELECT 1 FROM public.salary_runs r WHERE r.company_id = p_company_id AND r.created_at >= p_since)
             OR EXISTS (SELECT 1 FROM public.employees e WHERE e.company_id = p_company_id AND e.created_at >= p_since)
           WHEN 'assets' THEN EXISTS (
             SELECT 1 FROM public.assets a WHERE a.company_id = p_company_id AND a.created_at >= p_since)
           WHEN 'pos-and-webshop' THEN EXISTS (
             SELECT 1 FROM public.pos_connections c WHERE c.company_id = p_company_id AND c.created_at >= p_since)
             OR EXISTS (SELECT 1 FROM public.pos_sales_days d WHERE d.company_id = p_company_id AND d.created_at >= p_since)
             OR EXISTS (SELECT 1 FROM public.webshop_orders w WHERE w.company_id = p_company_id AND w.created_at >= p_since)
         END AS used_since,
         public.package_open_obligations(p_company_id, p.package_id) AS open_obligations
    FROM unnest(ARRAY['bank', 'customer-invoices', 'supplier-invoices-and-payments', 'receipts-and-documents',
                      'expenses', 'payroll', 'assets', 'pos-and-webshop']) AS p(package_id);
$$;

REVOKE ALL ON FUNCTION public.package_usage(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.package_usage(uuid, timestamptz) TO service_role;

-- =============================================================================
-- 4. The write
-- =============================================================================

CREATE FUNCTION public.set_company_package_choice(
  p_company_id uuid,
  p_package_id text,
  p_enabled boolean,
  p_source text,
  p_decided_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL,
  p_pending_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := 'package:' || p_package_id;
  v_old public.company_capability_config;
  v_new public.company_capability_config;
  v_obligations text[];
  v_actor_type text;
BEGIN
  IF p_package_id IS NULL OR p_package_id NOT IN ('bank', 'customer-invoices', 'supplier-invoices-and-payments',
      'receipts-and-documents', 'expenses', 'payroll', 'assets', 'pos-and-webshop') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PACKAGE_NOT_SWITCHABLE');
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'set_company_package_choice: p_enabled is required' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('company', 'suggestion') THEN
    RAISE EXCEPTION 'set_company_package_choice: p_source must be company or suggestion' USING ERRCODE = '22023';
  END IF;
  IF p_decided_by IS NULL OR NOT public.service_account_actor_is_admin(p_company_id, p_decided_by) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PACKAGE_SWITCH_ADMIN_REQUIRED');
  END IF;

  -- One decision per company and package at a time: the obligations read and
  -- the write below see the same state.
  PERFORM pg_advisory_xact_lock(hashtextextended('company-package:' || p_company_id::text || ':' || p_package_id, 0));

  SELECT * INTO v_old
    FROM public.company_capability_config
   WHERE company_id = p_company_id AND capability_key = v_key
   FOR UPDATE;

  IF NOT p_enabled THEN
    v_obligations := public.package_open_obligations(p_company_id, p_package_id);
    IF cardinality(v_obligations) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PACKAGE_HAS_OPEN_OBLIGATIONS', 'obligations', to_jsonb(v_obligations));
    END IF;
  END IF;

  IF v_old.id IS NOT NULL AND v_old.enabled = p_enabled THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'package_id', p_package_id, 'enabled', p_enabled,
                              'capability_config_id', v_old.id);
  END IF;

  -- The credential that relayed the approval, as the commit RPCs record it;
  -- a type outside audit_log's list is recorded as the user, never a reason
  -- to fail the decision.
  v_actor_type := CASE
    WHEN p_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN p_actor_type
    ELSE 'user'
  END;

  INSERT INTO public.company_capability_config (
    company_id, capability_key, enabled, source, decided_by, decided_actor_type, decided_actor_label,
    decided_at, pending_operation_id
  )
  VALUES (
    p_company_id, v_key, p_enabled, p_source, p_decided_by, v_actor_type, nullif(left(p_actor_label, 200), ''),
    now(), p_pending_operation_id
  )
  ON CONFLICT (company_id, capability_key) DO UPDATE
     SET enabled = EXCLUDED.enabled,
         source = EXCLUDED.source,
         decided_by = EXCLUDED.decided_by,
         decided_actor_type = EXCLUDED.decided_actor_type,
         decided_actor_label = EXCLUDED.decided_actor_label,
         decided_at = EXCLUDED.decided_at,
         pending_operation_id = EXCLUDED.pending_operation_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                description, actor_type, actor_label)
  VALUES (
    p_decided_by, p_company_id,
    CASE WHEN v_old.id IS NULL THEN 'INSERT' ELSE 'UPDATE' END,
    'company_capability_config', v_new.id, p_decided_by,
    CASE WHEN v_old.id IS NULL THEN NULL ELSE to_jsonb(v_old) END,
    to_jsonb(v_new),
    CASE WHEN p_enabled THEN 'Switched package on: ' ELSE 'Switched package off: ' END || p_package_id,
    v_actor_type,
    nullif(left(p_actor_label, 200), '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'package_id', p_package_id,
    'enabled', p_enabled,
    'previous_enabled', v_old.enabled,
    'capability_config_id', v_new.id,
    'decided_at', v_new.decided_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_company_package_choice(uuid, text, boolean, text, uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_company_package_choice(uuid, text, boolean, text, uuid, text, text, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
