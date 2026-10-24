-- Background tenants for the report benchmark. THROWAWAY DATABASE ONLY.
-- Included by seed.sql with :bg_tenants set. Each tenant is a copy of the
-- measured company's ledger, registers and documents under ids derived from
-- the tenant number, so the shared tables carry other companies' rows: six
-- make the measured company about 14 % of the verifikat (the largest company
-- in production holds about 7 %; more tenants cost about 25 s each). Triggers
-- are off (session_replication_role) because this is bulk filler that no
-- benchmark reads, and for the same reason they are not built onto the
-- ledger summaries.

SET session_replication_role = replica;
SELECT set_config('bench.source_company', 'c0000000-0000-4000-8000-000000000001', false) AS source_company \gset

CREATE OR REPLACE FUNCTION pg_temp.cl(k int, id uuid) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN id IS NULL THEN NULL ELSE md5('bg:' || k || ':' || id)::uuid END $$;

-- The company, user, bank account and fiscal period ids are mapped once per
-- tenant; md5 runs only for the ids that differ per row.
CREATE OR REPLACE FUNCTION pg_temp.clone_tenant(k int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  co uuid := current_setting('bench.source_company')::uuid;
  owner uuid;
  t_co uuid := pg_temp.cl(k, co);
  t_owner uuid;
  t_cash uuid;
  fp uuid[];
  t_fp uuid[];
BEGIN
  SELECT created_by INTO owner FROM public.companies WHERE id = co;
  t_owner := pg_temp.cl(k, owner);
  SELECT pg_temp.cl(k, id) INTO t_cash FROM public.cash_accounts WHERE company_id = co AND ledger_account = '1930';
  SELECT array_agg(id ORDER BY period_start), array_agg(pg_temp.cl(k, id) ORDER BY period_start)
    INTO fp, t_fp FROM public.fiscal_periods WHERE company_id = co;

  INSERT INTO auth.users (id, email, instance_id, aud, role)
  VALUES (t_owner, 'bg' || k || '@bench.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated');
  INSERT INTO public.companies (id, name, org_number, entity_type, created_by, created_at)
  SELECT t_co, 'Bakgrund ' || k || ' AB', '55910' || lpad(k::text, 5, '0'), entity_type, t_owner, created_at
  FROM public.companies WHERE id = co;
  INSERT INTO public.company_members (company_id, user_id, role) VALUES (t_co, t_owner, 'owner');
  INSERT INTO public.user_preferences (user_id, active_company_id) VALUES (t_owner, t_co);
  INSERT INTO public.company_settings (company_id, user_id, entity_type, company_name, vat_registered, moms_period,
    onboarding_complete, accounting_method, dimensions_enabled)
  SELECT t_co, t_owner, entity_type, 'Bakgrund ' || k || ' AB', vat_registered, moms_period, onboarding_complete,
         accounting_method, dimensions_enabled
  FROM public.company_settings WHERE company_id = co;
  INSERT INTO public.chart_of_accounts (id, user_id, company_id, account_number, account_name, account_class,
    account_group, account_type, normal_balance, plan_type, sru_code)
  SELECT pg_temp.cl(k, id), t_owner, t_co, account_number, account_name, account_class, account_group, account_type,
         normal_balance, plan_type, sru_code
  FROM public.chart_of_accounts WHERE company_id = co;
  INSERT INTO public.fiscal_periods (id, user_id, company_id, name, period_start, period_end, is_closed, closed_at,
    locked_at, previous_period_id, opening_balances_set)
  SELECT pg_temp.cl(k, id), t_owner, t_co, name, period_start, period_end, is_closed, closed_at, locked_at,
         pg_temp.cl(k, previous_period_id), opening_balances_set
  FROM public.fiscal_periods WHERE company_id = co;
  INSERT INTO public.customers (id, user_id, company_id, name, org_number, customer_type, customer_number)
  SELECT pg_temp.cl(k, id), t_owner, t_co, name, org_number, customer_type, customer_number
  FROM public.customers WHERE company_id = co;
  INSERT INTO public.suppliers (id, user_id, company_id, name, org_number, bankgiro, default_expense_account)
  SELECT pg_temp.cl(k, id), t_owner, t_co, name, org_number, bankgiro, default_expense_account
  FROM public.suppliers WHERE company_id = co;
  INSERT INTO public.cash_accounts (id, company_id, name, currency, ledger_account, is_primary, source)
  SELECT t_cash, t_co, name, currency, ledger_account, is_primary, source
  FROM public.cash_accounts WHERE company_id = co AND ledger_account = '1930';

  INSERT INTO public.journal_entries (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
    entry_date, description, source_type, source_id, status, created_at, updated_at, committed_at, reverses_id,
    correction_of_id, reversed_by_id, commit_method, created_via, bank_booking_context, committed_actor_type,
    committed_by, committed_auth_role, committed_auth_uid)
  SELECT pg_temp.cl(k, id), t_owner, t_co, t_fp[array_position(fp, fiscal_period_id)], voucher_number,
         voucher_series, entry_date, description, source_type, pg_temp.cl(k, source_id), status, created_at,
         updated_at, committed_at, pg_temp.cl(k, reverses_id), pg_temp.cl(k, correction_of_id),
         pg_temp.cl(k, reversed_by_id), commit_method, created_via, bank_booking_context, committed_actor_type,
         t_owner, committed_auth_role, t_owner
  FROM public.journal_entries WHERE company_id = co;
  INSERT INTO public.journal_entry_lines (id, journal_entry_id, account_number, debit_amount, credit_amount,
    currency, sort_order, dimensions, line_description, created_at)
  SELECT pg_temp.cl(k, l.id), pg_temp.cl(k, l.journal_entry_id), l.account_number, l.debit_amount, l.credit_amount,
         l.currency, l.sort_order, l.dimensions, l.line_description, l.created_at
  FROM public.journal_entry_lines l JOIN public.journal_entries e ON e.id = l.journal_entry_id
  WHERE e.company_id = co;
  INSERT INTO public.voucher_sequences (user_id, company_id, fiscal_period_id, voucher_series, last_number)
  SELECT t_owner, t_co, t_fp[array_position(fp, fiscal_period_id)], voucher_series, last_number
  FROM public.voucher_sequences WHERE company_id = co;

  INSERT INTO public.transactions (id, user_id, company_id, date, description, amount, currency, category,
    is_business, journal_entry_id, invoice_id, supplier_invoice_id, cash_account_id, merchant_name, import_source,
    transaction_method, reconciliation_method, link_basis, external_id, created_at, updated_at)
  SELECT pg_temp.cl(k, id), t_owner, t_co, date, description, amount, currency, category, is_business,
         pg_temp.cl(k, journal_entry_id), pg_temp.cl(k, invoice_id), pg_temp.cl(k, supplier_invoice_id), t_cash,
         merchant_name, import_source, transaction_method, reconciliation_method, link_basis,
         'bg' || k || '-' || external_id, created_at, updated_at
  FROM public.transactions WHERE company_id = co;
  INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status,
    currency, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, paid_at,
    paid_amount, remaining_amount, journal_entry_id, created_at, updated_at, delivery_date)
  SELECT pg_temp.cl(k, id), t_owner, t_co, pg_temp.cl(k, customer_id), invoice_number, invoice_date, due_date,
         status, currency, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment,
         vat_rate, paid_at, paid_amount, remaining_amount, pg_temp.cl(k, journal_entry_id), created_at, updated_at,
         delivery_date
  FROM public.invoices WHERE company_id = co;
  INSERT INTO public.invoice_payments (id, user_id, company_id, invoice_id, payment_date, amount, currency,
    journal_entry_id, transaction_id, source, created_at, updated_at)
  SELECT pg_temp.cl(k, id), t_owner, t_co, pg_temp.cl(k, invoice_id), payment_date, amount, currency,
         pg_temp.cl(k, journal_entry_id), pg_temp.cl(k, transaction_id), source, created_at, updated_at
  FROM public.invoice_payments WHERE company_id = co;
  INSERT INTO public.supplier_invoices (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
    invoice_date, due_date, received_date, status, currency, subtotal, subtotal_sek, vat_amount, vat_amount_sek,
    total, total_sek, vat_treatment, paid_at, paid_amount, remaining_amount, registration_journal_entry_id,
    payment_journal_entry_id, transaction_id, document_id, created_at, updated_at, approved_at)
  SELECT pg_temp.cl(k, id), t_owner, t_co, pg_temp.cl(k, supplier_id), arrival_number, supplier_invoice_number,
         invoice_date, due_date, received_date, status, currency, subtotal, subtotal_sek, vat_amount, vat_amount_sek,
         total, total_sek, vat_treatment, paid_at, paid_amount, remaining_amount,
         pg_temp.cl(k, registration_journal_entry_id), pg_temp.cl(k, payment_journal_entry_id),
         pg_temp.cl(k, transaction_id), pg_temp.cl(k, document_id), created_at, updated_at, approved_at
  FROM public.supplier_invoices WHERE company_id = co;
  INSERT INTO public.supplier_invoice_payments (id, user_id, company_id, supplier_invoice_id, payment_date, amount,
    currency, journal_entry_id, transaction_id, created_at)
  SELECT pg_temp.cl(k, id), t_owner, t_co, pg_temp.cl(k, supplier_invoice_id), payment_date, amount, currency,
         pg_temp.cl(k, journal_entry_id), pg_temp.cl(k, transaction_id), created_at
  FROM public.supplier_invoice_payments WHERE company_id = co;
  INSERT INTO public.document_attachments (id, user_id, company_id, storage_path, file_name, file_size_bytes,
    mime_type, sha256_hash, upload_source, journal_entry_id, created_at, updated_at, doc_type, page_count)
  SELECT pg_temp.cl(k, id), t_owner, t_co, t_co || substr(storage_path, 37), file_name, file_size_bytes, mime_type,
         sha256_hash, upload_source, pg_temp.cl(k, journal_entry_id), created_at, updated_at, doc_type, page_count
  FROM public.document_attachments WHERE company_id = co;
END;
$$;

SELECT format('SELECT pg_temp.clone_tenant(%s) AS tenant_%s', k, k)
FROM generate_series(1, :bg_tenants) k
\gexec

SET session_replication_role = origin;
