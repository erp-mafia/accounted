-- READ ONLY. Link identities and complete-row hashes for both copies.
-- Journal lines/correction content are covered by repair-preview.sql.
WITH duplicate_keys AS MATERIALIZED (
  SELECT company_id,fiscal_period_id,source_voucher_series,source_voucher_number
  FROM public.journal_entries WHERE source_type='import' AND status='posted'
    AND source_voucher_series IS NOT NULL AND source_voucher_number IS NOT NULL
  GROUP BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number HAVING count(*)>1
), candidates AS MATERIALIZED (
  SELECT j.id,j.company_id FROM public.journal_entries j JOIN duplicate_keys k
    USING(company_id,fiscal_period_id,source_voucher_series,source_voucher_number)
  WHERE j.source_type='import' AND j.status='posted'
), links AS (
SELECT c.company_id,c.id entry_id,'accrual_schedule_installments.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."accrual_schedule_installments" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'accrual_schedules.origin_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."accrual_schedules" r ON r."origin_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'agi_declarations.tax_payment_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."agi_declarations" r ON r."tax_payment_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'assets.disposal_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."assets" r ON r."disposal_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'depreciation_schedules.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."depreciation_schedules" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'document_attachments.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."document_attachments" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'document_attachments.journal_entry_line_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public.journal_entry_lines l ON l.journal_entry_id=c.id JOIN public."document_attachments" r ON r."journal_entry_line_id"=l.id
UNION ALL
SELECT c.company_id,c.id entry_id,'expense_claims.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."expense_claims" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'expense_payout_batches.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."expense_payout_batches" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'fiscal_periods.closing_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."fiscal_periods" r ON r."closing_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'fiscal_periods.opening_balance_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."fiscal_periods" r ON r."opening_balance_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'invoice_inbox_items.created_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."invoice_inbox_items" r ON r."created_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'invoice_payments.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."invoice_payments" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'invoice_reminders.fee_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."invoice_reminders" r ON r."fee_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'invoices.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."invoices" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'journal_entries.correction_of_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."journal_entries" r ON r."correction_of_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'journal_entries.reversed_by_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."journal_entries" r ON r."reversed_by_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'journal_entries.reverses_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."journal_entries" r ON r."reverses_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'journal_entry_no_doc_required.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."journal_entry_no_doc_required" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'mileage_trips.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."mileage_trips" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'rot_rut_payout_requests.reclaim_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."rot_rut_payout_requests" r ON r."reclaim_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'rot_rut_payout_requests.settlement_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."rot_rut_payout_requests" r ON r."settlement_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'salary_runs.avgifter_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."salary_runs" r ON r."avgifter_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'salary_runs.pension_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."salary_runs" r ON r."pension_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'salary_runs.salary_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."salary_runs" r ON r."salary_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'salary_runs.vacation_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."salary_runs" r ON r."vacation_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'sie_imports.opening_balance_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."sie_imports" r ON r."opening_balance_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'skattekonto_transactions.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."skattekonto_transactions" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'skattekonto_transactions.suggested_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."skattekonto_transactions" r ON r."suggested_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'stripe_payment_events.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."stripe_payment_events" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'stripe_payouts.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."stripe_payouts" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'supplier_invoice_payments.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."supplier_invoice_payments" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'supplier_invoices.payment_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."supplier_invoices" r ON r."payment_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'supplier_invoices.registration_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."supplier_invoices" r ON r."registration_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'transaction_voucher_links.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."transaction_voucher_links" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'transactions.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."transactions" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'transactions.potential_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."transactions" r ON r."potential_journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'vacation_year_closures.adjustment_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."vacation_year_closures" r ON r."adjustment_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'webshop_orders.journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."webshop_orders" r ON r."journal_entry_id"=c.id
UNION ALL
SELECT c.company_id,c.id entry_id,'webshop_orders.manually_booked_journal_entry_id' relationship,
    coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
    encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM candidates c JOIN public."webshop_orders" r ON r."manually_booked_journal_entry_id"=c.id
)
SELECT * FROM links ORDER BY company_id,entry_id,relationship,record_id;
