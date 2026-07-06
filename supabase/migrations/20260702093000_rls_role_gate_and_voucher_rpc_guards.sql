-- Role-gated write authorization + tenant guards on voucher SECURITY DEFINER RPCs.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The staging/dev database has carried, for some time, an authorization
-- refactor that was never captured as a migration and therefore never reached
-- production:
--
--   * public.current_active_company_id()  — the single active company for the
--     caller (user_preferences.active_company_id, validated against a live,
--     non-archived membership; falls back to the earliest membership).
--   * public.current_user_can_write()     — true iff the caller is a non-viewer
--     member of that active company.
--   * Every company-scoped WRITE policy AND-s in current_user_can_write() and
--     scopes the company to current_active_company_id(), so a `viewer` (or any
--     non-member) cannot INSERT/UPDATE/DELETE tenant data by calling PostgREST
--     directly — the app-layer requireWritePermission() guard is no longer the
--     only thing standing between a viewer and a write.
--
-- lib/supabase/middleware.ts and lib/auth/require-write.ts already document and
-- rely on these functions; the application is written for this design. On
-- production the write policies still gate on membership only
-- (company_id IN (SELECT user_company_ids())), so a viewer CAN currently write
-- via the API. This migration makes the repository the source of truth and,
-- when deployed, brings production in line with staging.
--
-- It ALSO hardens three voucher SECURITY DEFINER RPCs that were EXECUTE-able by
-- anon/authenticated with NO caller-membership check (a cross-tenant hole: any
-- authenticated caller who knows a draft UUID could POST
-- /rest/v1/rpc/commit_journal_entry with a foreign company_id and post that
-- tenant's draft). The guard is the canonical one from
-- 20260619130100_securitydefiner_write_rpc_tenant_guards.sql: it reads the
-- request.jwt.claims role and only constrains anon/authenticated callers.
-- service_role / backend callers (no JWT role — the engine's service-role
-- commit path, the MCP/API-key path whose company scoping happens in TS, the
-- pg-real harness, migrations) bypass BY DESIGN, so those flows are unaffected.
--
-- Everything below is idempotent (CREATE OR REPLACE / DROP POLICY IF EXISTS),
-- so it is a no-op against staging (which already has the policies) and a
-- corrective apply against production.

-- =============================================================================
-- 1. Authorization helper functions
-- =============================================================================

CREATE OR REPLACE FUNCTION public.current_active_company_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (
      SELECT up.active_company_id
      FROM public.user_preferences up
      JOIN public.company_members cm
        ON cm.user_id = up.user_id AND cm.company_id = up.active_company_id
      JOIN public.companies c
        ON c.id = cm.company_id AND c.archived_at IS NULL
      WHERE up.user_id = auth.uid()
    ),
    (
      SELECT cm.company_id
      FROM public.company_members cm
      JOIN public.companies c
        ON c.id = cm.company_id AND c.archived_at IS NULL
      WHERE cm.user_id = auth.uid()
      ORDER BY cm.created_at ASC
      LIMIT 1
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_user_can_write()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = public.current_active_company_id()
      AND cm.role <> 'viewer'
  );
$function$;

-- =============================================================================
-- 2. Role-gated write policies (39 tables)
--    DDL generated verbatim from the live staging catalog (pg_policies) so the
--    predicates match exactly what the app has been running against.
-- =============================================================================

-- NOTE: the staging catalog also carried an ai_usage_tracking_insert policy,
-- but public.ai_usage_tracking was dropped by
-- 20260504120000_remove_ai_subsystem.sql and no longer exists in the canonical
-- schema — the table on staging is drift. That policy is intentionally NOT
-- recreated here; a from-scratch migration chain would fail on it.

-- automation_webhooks was renamed to public.webhooks by
-- 20260515170000_webhooks_v2 — the staging catalog still carried the
-- pre-rename table name (drift). Gate the canonical table, dropping both the
-- staging-era policy names and the legacy schema-sync names defensively
-- (policies follow a table rename but keep their original names).
DROP POLICY IF EXISTS automation_webhooks_insert ON public.webhooks;
DROP POLICY IF EXISTS "Members can insert company webhooks" ON public.webhooks;
DROP POLICY IF EXISTS webhooks_insert ON public.webhooks;
CREATE POLICY webhooks_insert ON public.webhooks FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS automation_webhooks_update ON public.webhooks;
DROP POLICY IF EXISTS "Members can update company webhooks" ON public.webhooks;
DROP POLICY IF EXISTS webhooks_update ON public.webhooks;
CREATE POLICY webhooks_update ON public.webhooks FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS automation_webhooks_delete ON public.webhooks;
DROP POLICY IF EXISTS "Members can delete company webhooks" ON public.webhooks;
DROP POLICY IF EXISTS webhooks_delete ON public.webhooks;
CREATE POLICY webhooks_delete ON public.webhooks FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS bank_connections_insert ON public.bank_connections;
CREATE POLICY bank_connections_insert ON public.bank_connections FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS bank_connections_update ON public.bank_connections;
CREATE POLICY bank_connections_update ON public.bank_connections FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS bank_connections_delete ON public.bank_connections;
CREATE POLICY bank_connections_delete ON public.bank_connections FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS bank_file_imports_insert ON public.bank_file_imports;
CREATE POLICY bank_file_imports_insert ON public.bank_file_imports FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS bank_file_imports_update ON public.bank_file_imports;
CREATE POLICY bank_file_imports_update ON public.bank_file_imports FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS bank_file_imports_delete ON public.bank_file_imports;
CREATE POLICY bank_file_imports_delete ON public.bank_file_imports FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS btl_insert ON public.booking_template_library;
CREATE POLICY btl_insert ON public.booking_template_library FOR INSERT TO public
  WITH CHECK (((NOT is_system) AND current_user_can_write() AND ((company_id = current_active_company_id()) OR ((company_id IS NULL) AND (team_id IN ( SELECT user_team_ids() AS user_team_ids))))));

DROP POLICY IF EXISTS btl_update ON public.booking_template_library;
CREATE POLICY btl_update ON public.booking_template_library FOR UPDATE TO public
  USING (((NOT is_system) AND current_user_can_write() AND ((company_id IN ( SELECT user_company_ids() AS user_company_ids)) OR ((company_id IS NULL) AND (team_id IN ( SELECT user_team_ids() AS user_team_ids))))));

DROP POLICY IF EXISTS btl_delete ON public.booking_template_library;
CREATE POLICY btl_delete ON public.booking_template_library FOR DELETE TO public
  USING (((NOT is_system) AND current_user_can_write() AND ((company_id IN ( SELECT user_company_ids() AS user_company_ids)) OR ((company_id IS NULL) AND (team_id IN ( SELECT user_team_ids() AS user_team_ids))))));

DROP POLICY IF EXISTS calendar_feeds_insert ON public.calendar_feeds;
CREATE POLICY calendar_feeds_insert ON public.calendar_feeds FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS calendar_feeds_update ON public.calendar_feeds;
CREATE POLICY calendar_feeds_update ON public.calendar_feeds FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS calendar_feeds_delete ON public.calendar_feeds;
CREATE POLICY calendar_feeds_delete ON public.calendar_feeds FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS categorization_templates_insert ON public.categorization_templates;
CREATE POLICY categorization_templates_insert ON public.categorization_templates FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS categorization_templates_update ON public.categorization_templates;
CREATE POLICY categorization_templates_update ON public.categorization_templates FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS categorization_templates_delete ON public.categorization_templates;
CREATE POLICY categorization_templates_delete ON public.categorization_templates FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chart_of_accounts_insert ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_insert ON public.chart_of_accounts FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chart_of_accounts_update ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_update ON public.chart_of_accounts FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chart_of_accounts_delete ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_delete ON public.chart_of_accounts FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chat_messages_insert ON public.chat_messages;
CREATE POLICY chat_messages_insert ON public.chat_messages FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chat_messages_update ON public.chat_messages;
CREATE POLICY chat_messages_update ON public.chat_messages FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chat_messages_delete ON public.chat_messages;
CREATE POLICY chat_messages_delete ON public.chat_messages FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chat_sessions_insert ON public.chat_sessions;
CREATE POLICY chat_sessions_insert ON public.chat_sessions FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chat_sessions_update ON public.chat_sessions;
CREATE POLICY chat_sessions_update ON public.chat_sessions FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS chat_sessions_delete ON public.chat_sessions;
CREATE POLICY chat_sessions_delete ON public.chat_sessions FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS company_settings_delete ON public.company_settings;
CREATE POLICY company_settings_delete ON public.company_settings FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS cost_centers_insert ON public.cost_centers;
CREATE POLICY cost_centers_insert ON public.cost_centers FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS cost_centers_update ON public.cost_centers;
CREATE POLICY cost_centers_update ON public.cost_centers FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS cost_centers_delete ON public.cost_centers;
CREATE POLICY cost_centers_delete ON public.cost_centers FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS customers_insert ON public.customers;
CREATE POLICY customers_insert ON public.customers FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS customers_update ON public.customers;
CREATE POLICY customers_update ON public.customers FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS customers_delete ON public.customers;
CREATE POLICY customers_delete ON public.customers FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS deadlines_insert ON public.deadlines;
CREATE POLICY deadlines_insert ON public.deadlines FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS deadlines_update ON public.deadlines;
CREATE POLICY deadlines_update ON public.deadlines FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS deadlines_delete ON public.deadlines;
CREATE POLICY deadlines_delete ON public.deadlines FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS document_attachments_insert ON public.document_attachments;
CREATE POLICY document_attachments_insert ON public.document_attachments FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS document_attachments_update ON public.document_attachments;
CREATE POLICY document_attachments_update ON public.document_attachments FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS document_attachments_delete ON public.document_attachments;
CREATE POLICY document_attachments_delete ON public.document_attachments FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS extension_data_insert ON public.extension_data;
CREATE POLICY extension_data_insert ON public.extension_data FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS extension_data_update ON public.extension_data;
CREATE POLICY extension_data_update ON public.extension_data FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS extension_data_delete ON public.extension_data;
CREATE POLICY extension_data_delete ON public.extension_data FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS fiscal_periods_insert ON public.fiscal_periods;
CREATE POLICY fiscal_periods_insert ON public.fiscal_periods FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS fiscal_periods_update ON public.fiscal_periods;
CREATE POLICY fiscal_periods_update ON public.fiscal_periods FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS fiscal_periods_delete ON public.fiscal_periods;
CREATE POLICY fiscal_periods_delete ON public.fiscal_periods FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_inbox_items_insert ON public.invoice_inbox_items;
CREATE POLICY invoice_inbox_items_insert ON public.invoice_inbox_items FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_inbox_items_update ON public.invoice_inbox_items;
CREATE POLICY invoice_inbox_items_update ON public.invoice_inbox_items FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_inbox_items_delete ON public.invoice_inbox_items;
CREATE POLICY invoice_inbox_items_delete ON public.invoice_inbox_items FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_items_insert ON public.invoice_items;
CREATE POLICY invoice_items_insert ON public.invoice_items FOR INSERT TO public
  WITH CHECK (((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_items.invoice_id) AND (i.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_items_update ON public.invoice_items;
CREATE POLICY invoice_items_update ON public.invoice_items FOR UPDATE TO public
  USING (((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_items.invoice_id) AND (i.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_items_delete ON public.invoice_items;
CREATE POLICY invoice_items_delete ON public.invoice_items FOR DELETE TO public
  USING (((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_items.invoice_id) AND (i.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_payments_insert ON public.invoice_payments;
CREATE POLICY invoice_payments_insert ON public.invoice_payments FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_payments_update ON public.invoice_payments;
CREATE POLICY invoice_payments_update ON public.invoice_payments FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_payments_delete ON public.invoice_payments;
CREATE POLICY invoice_payments_delete ON public.invoice_payments FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_reminders_insert ON public.invoice_reminders;
CREATE POLICY invoice_reminders_insert ON public.invoice_reminders FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_reminders_update ON public.invoice_reminders;
CREATE POLICY invoice_reminders_update ON public.invoice_reminders FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoice_reminders_delete ON public.invoice_reminders;
CREATE POLICY invoice_reminders_delete ON public.invoice_reminders FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoices_insert ON public.invoices;
CREATE POLICY invoices_insert ON public.invoices FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoices_update ON public.invoices;
CREATE POLICY invoices_update ON public.invoices FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS invoices_delete ON public.invoices;
CREATE POLICY invoices_delete ON public.invoices FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS journal_entries_insert ON public.journal_entries;
CREATE POLICY journal_entries_insert ON public.journal_entries FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS journal_entries_update ON public.journal_entries;
CREATE POLICY journal_entries_update ON public.journal_entries FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS journal_entries_delete ON public.journal_entries;
CREATE POLICY journal_entries_delete ON public.journal_entries FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS journal_entry_lines_insert ON public.journal_entry_lines;
CREATE POLICY journal_entry_lines_insert ON public.journal_entry_lines FOR INSERT TO public
  WITH CHECK (((EXISTS ( SELECT 1
   FROM journal_entries je
  WHERE ((je.id = journal_entry_lines.journal_entry_id) AND (je.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS journal_entry_lines_update ON public.journal_entry_lines;
CREATE POLICY journal_entry_lines_update ON public.journal_entry_lines FOR UPDATE TO public
  USING (((EXISTS ( SELECT 1
   FROM journal_entries je
  WHERE ((je.id = journal_entry_lines.journal_entry_id) AND (je.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS journal_entry_lines_delete ON public.journal_entry_lines;
CREATE POLICY journal_entry_lines_delete ON public.journal_entry_lines FOR DELETE TO public
  USING (((EXISTS ( SELECT 1
   FROM journal_entries je
  WHERE ((je.id = journal_entry_lines.journal_entry_id) AND (je.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS mapping_rules_insert ON public.mapping_rules;
CREATE POLICY mapping_rules_insert ON public.mapping_rules FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS mapping_rules_update ON public.mapping_rules;
CREATE POLICY mapping_rules_update ON public.mapping_rules FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS mapping_rules_delete ON public.mapping_rules;
CREATE POLICY mapping_rules_delete ON public.mapping_rules FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS payment_match_log_insert ON public.payment_match_log;
CREATE POLICY payment_match_log_insert ON public.payment_match_log FOR INSERT TO public
  WITH CHECK ((((company_id = current_active_company_id()) OR (company_id IS NULL)) AND current_user_can_write()));

DROP POLICY IF EXISTS pending_operations_update ON public.pending_operations;
CREATE POLICY pending_operations_update ON public.pending_operations FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS projects_insert ON public.projects;
CREATE POLICY projects_insert ON public.projects FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS projects_update ON public.projects;
CREATE POLICY projects_update ON public.projects FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS projects_delete ON public.projects;
CREATE POLICY projects_delete ON public.projects FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS provider_consents_insert ON public.provider_consents;
CREATE POLICY provider_consents_insert ON public.provider_consents FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS provider_consents_update ON public.provider_consents;
CREATE POLICY provider_consents_update ON public.provider_consents FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS provider_consents_delete ON public.provider_consents;
CREATE POLICY provider_consents_delete ON public.provider_consents FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS receipt_line_items_insert ON public.receipt_line_items;
CREATE POLICY receipt_line_items_insert ON public.receipt_line_items FOR INSERT TO public
  WITH CHECK (((EXISTS ( SELECT 1
   FROM receipts r
  WHERE ((r.id = receipt_line_items.receipt_id) AND (r.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS receipt_line_items_update ON public.receipt_line_items;
CREATE POLICY receipt_line_items_update ON public.receipt_line_items FOR UPDATE TO public
  USING (((EXISTS ( SELECT 1
   FROM receipts r
  WHERE ((r.id = receipt_line_items.receipt_id) AND (r.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS receipt_line_items_delete ON public.receipt_line_items;
CREATE POLICY receipt_line_items_delete ON public.receipt_line_items FOR DELETE TO public
  USING (((EXISTS ( SELECT 1
   FROM receipts r
  WHERE ((r.id = receipt_line_items.receipt_id) AND (r.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS receipts_insert ON public.receipts;
CREATE POLICY receipts_insert ON public.receipts FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS receipts_update ON public.receipts;
CREATE POLICY receipts_update ON public.receipts FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS receipts_delete ON public.receipts;
CREATE POLICY receipts_delete ON public.receipts FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS sie_account_mappings_insert ON public.sie_account_mappings;
CREATE POLICY sie_account_mappings_insert ON public.sie_account_mappings FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS sie_account_mappings_update ON public.sie_account_mappings;
CREATE POLICY sie_account_mappings_update ON public.sie_account_mappings FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS sie_account_mappings_delete ON public.sie_account_mappings;
CREATE POLICY sie_account_mappings_delete ON public.sie_account_mappings FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS sie_imports_insert ON public.sie_imports;
CREATE POLICY sie_imports_insert ON public.sie_imports FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS sie_imports_update ON public.sie_imports;
CREATE POLICY sie_imports_update ON public.sie_imports FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS sie_imports_delete ON public.sie_imports;
CREATE POLICY sie_imports_delete ON public.sie_imports FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS skatteverket_tokens_insert ON public.skatteverket_tokens;
CREATE POLICY skatteverket_tokens_insert ON public.skatteverket_tokens FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS skatteverket_tokens_update ON public.skatteverket_tokens;
CREATE POLICY skatteverket_tokens_update ON public.skatteverket_tokens FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS skatteverket_tokens_delete ON public.skatteverket_tokens;
CREATE POLICY skatteverket_tokens_delete ON public.skatteverket_tokens FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoice_items_insert ON public.supplier_invoice_items;
CREATE POLICY supplier_invoice_items_insert ON public.supplier_invoice_items FOR INSERT TO public
  WITH CHECK (((EXISTS ( SELECT 1
   FROM supplier_invoices si
  WHERE ((si.id = supplier_invoice_items.supplier_invoice_id) AND (si.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoice_items_update ON public.supplier_invoice_items;
CREATE POLICY supplier_invoice_items_update ON public.supplier_invoice_items FOR UPDATE TO public
  USING (((EXISTS ( SELECT 1
   FROM supplier_invoices si
  WHERE ((si.id = supplier_invoice_items.supplier_invoice_id) AND (si.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoice_items_delete ON public.supplier_invoice_items;
CREATE POLICY supplier_invoice_items_delete ON public.supplier_invoice_items FOR DELETE TO public
  USING (((EXISTS ( SELECT 1
   FROM supplier_invoices si
  WHERE ((si.id = supplier_invoice_items.supplier_invoice_id) AND (si.company_id = current_active_company_id())))) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoice_payments_insert ON public.supplier_invoice_payments;
CREATE POLICY supplier_invoice_payments_insert ON public.supplier_invoice_payments FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoice_payments_update ON public.supplier_invoice_payments;
CREATE POLICY supplier_invoice_payments_update ON public.supplier_invoice_payments FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoice_payments_delete ON public.supplier_invoice_payments;
CREATE POLICY supplier_invoice_payments_delete ON public.supplier_invoice_payments FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoices_insert ON public.supplier_invoices;
CREATE POLICY supplier_invoices_insert ON public.supplier_invoices FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoices_update ON public.supplier_invoices;
CREATE POLICY supplier_invoices_update ON public.supplier_invoices FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS supplier_invoices_delete ON public.supplier_invoices;
CREATE POLICY supplier_invoices_delete ON public.supplier_invoices FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS suppliers_insert ON public.suppliers;
CREATE POLICY suppliers_insert ON public.suppliers FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS suppliers_update ON public.suppliers;
CREATE POLICY suppliers_update ON public.suppliers FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS suppliers_delete ON public.suppliers;
CREATE POLICY suppliers_delete ON public.suppliers FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS transactions_insert ON public.transactions;
CREATE POLICY transactions_insert ON public.transactions FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS transactions_update ON public.transactions;
CREATE POLICY transactions_update ON public.transactions FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS transactions_delete ON public.transactions;
CREATE POLICY transactions_delete ON public.transactions FOR DELETE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS voucher_gap_explanations_insert ON public.voucher_gap_explanations;
CREATE POLICY voucher_gap_explanations_insert ON public.voucher_gap_explanations FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write() AND (EXISTS ( SELECT 1
   FROM (team_members tm
     JOIN companies c ON ((c.team_id = tm.team_id)))
  WHERE ((c.id = voucher_gap_explanations.company_id) AND (tm.user_id = auth.uid()) AND (tm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));

DROP POLICY IF EXISTS voucher_gap_explanations_update ON public.voucher_gap_explanations;
CREATE POLICY voucher_gap_explanations_update ON public.voucher_gap_explanations FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write() AND (EXISTS ( SELECT 1
   FROM (team_members tm
     JOIN companies c ON ((c.team_id = tm.team_id)))
  WHERE ((c.id = voucher_gap_explanations.company_id) AND (tm.user_id = auth.uid()) AND (tm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));

DROP POLICY IF EXISTS voucher_sequences_insert ON public.voucher_sequences;
CREATE POLICY voucher_sequences_insert ON public.voucher_sequences FOR INSERT TO public
  WITH CHECK (((company_id = current_active_company_id()) AND current_user_can_write()));

DROP POLICY IF EXISTS voucher_sequences_update ON public.voucher_sequences;
CREATE POLICY voucher_sequences_update ON public.voucher_sequences FOR UPDATE TO public
  USING (((company_id = current_active_company_id()) AND current_user_can_write()));

-- =============================================================================
-- 3. Tenant guards on voucher SECURITY DEFINER RPCs
--    Bodies copied verbatim from their latest definitions; only the v_jwt_role
--    DECLARE + guard block, SET search_path = public, and the REVOKE/GRANT are
--    added. anon/authenticated cross-tenant callers are refused (42501);
--    service_role / backend (no JWT role) bypass BY DESIGN.
-- =============================================================================

-- 3a. commit_journal_entry
CREATE OR REPLACE FUNCTION public.commit_journal_entry(
  p_company_id uuid,
  p_entry_id uuid,
  p_commit_method text DEFAULT NULL::text,
  p_rubric_version text DEFAULT NULL::text,
  p_actor_type text DEFAULT NULL::text,
  p_actor_label text DEFAULT NULL::text
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only commit entries in their own
  -- companies; service_role / backend (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version,
      committed_actor_type = p_actor_type,
      committed_actor_label = p_actor_label
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  RETURN QUERY SELECT v_next;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text) TO authenticated;

-- 3b. next_voucher_number
CREATE OR REPLACE FUNCTION public.next_voucher_number(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_next integer;
  v_user_id uuid;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Preserved from 20260623130000: under a service-role client auth.uid() is
  -- NULL and the INSERT would fail user_id NOT NULL before ON CONFLICT
  -- arbitration — fall back to the company owner.
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    SELECT created_by INTO v_user_id
    FROM public.companies
    WHERE id = p_company_id;
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'next_voucher_number: no attributable user for company %', p_company_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, v_user_id, p_fiscal_period_id, p_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  RETURN v_next;
END;
$function$;

REVOKE ALL ON FUNCTION public.next_voucher_number(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_voucher_number(uuid, uuid, text) TO authenticated;

-- 3c. detect_voucher_gaps
CREATE OR REPLACE FUNCTION public.detect_voucher_gaps(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'::text
)
RETURNS TABLE(gap_start integer, gap_end integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH numbered AS (
    SELECT voucher_number,
           LEAD(voucher_number) OVER (ORDER BY voucher_number) AS next_number
    FROM public.journal_entries
    WHERE company_id = p_company_id
      AND fiscal_period_id = p_fiscal_period_id
      AND voucher_series = p_series
      AND status != 'draft'
    ORDER BY voucher_number
  )
  SELECT
    voucher_number + 1 AS gap_start,
    next_number - 1 AS gap_end
  FROM numbered
  WHERE next_number IS NOT NULL
    AND next_number > voucher_number + 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.detect_voucher_gaps(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.detect_voucher_gaps(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
