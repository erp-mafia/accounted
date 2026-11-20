-- Payments the collections provider collected, and its payouts (settlements).
-- pg-test: tests/pg/collection-settlements.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts,
--          tests/pg/full-archive-coverage.pg.test.ts
--
-- Two bookings follow a debtor who pays the provider instead of the company
-- (build spec 4.2, both still subject to the accountant's sign-off, 4.5):
--
--   C  the payment itself, on the day the debtor paid: the invoice is settled
--      through settleInvoicePayment against the clearing account (default
--      1689, "collected, not yet paid out") at the gross capital reduction,
--      with invoice_payments.source = 'collections'. Its voucher keeps the
--      ordinary payment source types (invoice_paid / invoice_cash_payment),
--      so every reader of invoice payments keeps working.
--      collection_collected_payments holds one row per payment the provider
--      lists as its own (never one the ledger reported to it).
--
--   D  the payout: one voucher per settlement, dated the payout day, debit
--      the payout account, credit the clearing account for the capital of
--      the C payments it settles, plus the provider's deductions per line
--      kind. source_type 'collection_settlement'.
--      collection_settlements and collection_settlement_lines hold the
--      settlement as the provider sent it (allowlisted, no debtor data) and
--      the account each line books to.
--
-- Nothing here is start work: an unbooked collected payment or settlement is
-- an obligation that holds the connection (collection_obligation_counts).

-- =============================================================================
-- 1. collection_collected_payments
-- =============================================================================
-- A row's life:
--   pending       read from the provider's case snapshot, not booked yet
--   booked        step C is in the books (invoice_payment_id, journal_entry_id)
--   needs_review  booking was refused (locked period, invoice already paid,
--                 another currency, ...): review_reason says why; a person
--                 books it again once fixed
--   ignored       a person decided it needs no booking (with a reason)

CREATE TABLE public.collection_collected_payments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES public.collection_cases(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  provider_payment_ref text NOT NULL CHECK (length(provider_payment_ref) BETWEEN 1 AND 128),
  paid_at date NOT NULL,
  total numeric(14,2),
  capital_paid numeric(14,2) NOT NULL CHECK (capital_paid >= 0),
  to_creditor_other numeric(14,2) NOT NULL DEFAULT 0,
  to_agency numeric(14,2) NOT NULL DEFAULT 0,

  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'booked', 'needs_review', 'ignored')),
  -- No foreign key: the rebook removes the payment row and writes a new one.
  invoice_payment_id uuid,
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  -- The archived payment record (underlag of the C voucher).
  payment_record_document_id uuid REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  review_reason text CHECK (review_reason IS NULL OR length(review_reason) <= 200),
  booked_by uuid REFERENCES auth.users(id),
  booked_at timestamptz,
  -- A booking in flight: a second caller waits until the lease runs out.
  booking_lease_until timestamptz,
  -- The payout that paid this capital out (step D), once booked.
  settlement_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_collected_payments_once UNIQUE (case_id, provider_payment_ref),
  CONSTRAINT collection_collected_payments_booked_shape CHECK (
    (status = 'booked') = (booked_at IS NOT NULL AND invoice_payment_id IS NOT NULL)
  ),
  CONSTRAINT collection_collected_payments_review_shape CHECK (
    status NOT IN ('needs_review', 'ignored') OR review_reason IS NOT NULL
  )
);

COMMENT ON TABLE public.collection_collected_payments IS
  'Payments a debtor made to the collections provider (its own payment list), and their booking as a payment of the invoice against the clearing account (step C).';
COMMENT ON COLUMN public.collection_collected_payments.capital_paid IS
  'The gross reduction of the open capital: the amount the invoice is settled with.';

CREATE INDEX collection_collected_payments_open
  ON public.collection_collected_payments (company_id, status)
  WHERE status IN ('pending', 'needs_review');
CREATE INDEX collection_collected_payments_invoice ON public.collection_collected_payments (invoice_id);
CREATE INDEX collection_collected_payments_entry
  ON public.collection_collected_payments (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;
CREATE INDEX collection_collected_payments_document
  ON public.collection_collected_payments (payment_record_document_id)
  WHERE payment_record_document_id IS NOT NULL;
CREATE INDEX collection_collected_payments_settlement
  ON public.collection_collected_payments (settlement_id)
  WHERE settlement_id IS NOT NULL;

ALTER TABLE public.collection_collected_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_collected_payments_select" ON public.collection_collected_payments
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_collected_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_collected_payments TO service_role;
-- no-grant: anon on public.collection_collected_payments (company data)

CREATE TRIGGER collection_collected_payments_updated_at
  BEFORE UPDATE ON public.collection_collected_payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A collected payment belongs to its case's company and invoice, and keeps
-- what the provider said it was.
CREATE OR REPLACE FUNCTION public.collection_collected_payment_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.case_id <> OLD.case_id OR NEW.invoice_id <> OLD.invoice_id
       OR NEW.provider_payment_ref <> OLD.provider_payment_ref THEN
      RAISE EXCEPTION 'A collected payment keeps its company, case, invoice and provider reference'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_cases c
     WHERE c.id = NEW.case_id AND c.company_id = NEW.company_id AND c.invoice_id = NEW.invoice_id
  ) THEN
    RAISE EXCEPTION 'A collected payment must belong to a case of the same company and invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_collected_payment_shape_guard
  BEFORE INSERT OR UPDATE ON public.collection_collected_payments
  FOR EACH ROW EXECUTE FUNCTION public.collection_collected_payment_shape_guard();

-- One collections payment row per provider payment and invoice: a second
-- booking of the same payment fails at the payment row, and
-- settleInvoicePayment then cancels its voucher.
CREATE UNIQUE INDEX invoice_payments_collections_ref_unique
  ON public.invoice_payments (invoice_id, external_ref)
  WHERE source = 'collections' AND external_ref IS NOT NULL;

-- =============================================================================
-- 2. collection_settlements
-- =============================================================================
-- A row's life:
--   received       stored; not booked yet (automatic booking is off, or the
--                  run that stored it did not get to it)
--   needs_mapping  booking needs a person: needs_mapping_reason says why
--                  (a line the ledger cannot place, VAT not yet confirmed as
--                  deductible, a case it does not hold, a balance or
--                  per-case difference, a possible duplicate, a locked period)
--   booked         step D is in the books (journal_entry_id)
--   failed         the provider marks it not valid; never booked
--   ignored        a person decided it needs no booking

CREATE TABLE public.collection_settlements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.collection_connections(id) ON DELETE RESTRICT,
  provider_settlement_ref text NOT NULL CHECK (length(provider_settlement_ref) BETWEEN 1 AND 128),
  payment_date date NOT NULL,
  settlement_date date,
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_status_ok boolean NOT NULL,
  provider_status_code text CHECK (provider_status_code IS NULL OR length(provider_status_code) <= 64),
  bank_reference text CHECK (bank_reference IS NULL OR length(bank_reference) <= 140),

  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'booked', 'needs_mapping', 'failed', 'ignored')),
  needs_mapping_reason text CHECK (needs_mapping_reason IS NULL OR length(needs_mapping_reason) <= 200),
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  document_attachment_id uuid REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  bank_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  provider_acknowledged_at timestamptz,
  booked_by uuid REFERENCES auth.users(id),
  booked_at timestamptz,
  booking_lease_until timestamptz,
  -- Allowlisted by Connect: no debtor object, no free text, no links.
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_settlements_once UNIQUE (company_id, provider_settlement_ref),
  CONSTRAINT collection_settlements_booked_shape CHECK (
    (status = 'booked') = (journal_entry_id IS NOT NULL AND booked_at IS NOT NULL)
  ),
  CONSTRAINT collection_settlements_mapping_shape CHECK (
    status <> 'needs_mapping' OR needs_mapping_reason IS NOT NULL
  )
);

COMMENT ON TABLE public.collection_settlements IS
  'Payouts from the collections provider (settlements) and their booking as one voucher each (step D, source_type collection_settlement).';
COMMENT ON COLUMN public.collection_settlements.amount IS
  'The amount paid out to the company.';
COMMENT ON COLUMN public.collection_settlements.document_attachment_id IS
  'The provider''s settlement specification (PDF), archived as the underlag of the payout voucher.';

CREATE INDEX collection_settlements_open
  ON public.collection_settlements (company_id, status)
  WHERE status IN ('received', 'needs_mapping');
CREATE INDEX collection_settlements_connection ON public.collection_settlements (connection_id);
CREATE INDEX collection_settlements_entry
  ON public.collection_settlements (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;
CREATE INDEX collection_settlements_document
  ON public.collection_settlements (document_attachment_id)
  WHERE document_attachment_id IS NOT NULL;
CREATE INDEX collection_settlements_bank_transaction
  ON public.collection_settlements (bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX collection_settlements_unacknowledged
  ON public.collection_settlements (company_id)
  WHERE status = 'booked' AND provider_acknowledged_at IS NULL;

ALTER TABLE public.collection_settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_settlements_select" ON public.collection_settlements
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_settlements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_settlements TO service_role;
-- no-grant: anon on public.collection_settlements (company data)

CREATE TRIGGER collection_settlements_updated_at
  BEFORE UPDATE ON public.collection_settlements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.collection_collected_payments
  ADD CONSTRAINT collection_collected_payments_settlement_fk
  FOREIGN KEY (settlement_id) REFERENCES public.collection_settlements(id) ON DELETE SET NULL;

-- A settlement belongs to its connection's company and keeps what the
-- provider said it was.
CREATE OR REPLACE FUNCTION public.collection_settlement_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.connection_id <> OLD.connection_id
       OR NEW.provider_settlement_ref <> OLD.provider_settlement_ref
       OR NEW.amount <> OLD.amount OR NEW.payment_date <> OLD.payment_date OR NEW.currency <> OLD.currency THEN
      RAISE EXCEPTION 'A settlement keeps its company, connection, reference, amount, date and currency'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_connections c WHERE c.id = NEW.connection_id AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'A settlement must belong to a collections connection of the same company'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_settlement_shape_guard
  BEFORE INSERT OR UPDATE ON public.collection_settlements
  FOR EACH ROW EXECUTE FUNCTION public.collection_settlement_shape_guard();

-- =============================================================================
-- 3. collection_settlement_lines
-- =============================================================================

CREATE TABLE public.collection_settlement_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL REFERENCES public.collection_settlements(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN (
    'principal', 'interest_to_creditor', 'fee_to_creditor', 'cost_refund_to_creditor',
    'agency_commission', 'agency_fee_vat', 'fee_charged_to_creditor', 'court_fee',
    'supplier_invoice_setoff', 'excess_direct_payment', 'informational', 'unknown'
  )),
  in_payout boolean NOT NULL,
  recipient text NOT NULL CHECK (recipient IN ('creditor', 'agency', 'tax_authority', 'enforcement_authority', 'partner')),
  amount numeric(14,2) NOT NULL,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  provider_case_ref text CHECK (provider_case_ref IS NULL OR length(provider_case_ref) <= 128),
  case_id uuid REFERENCES public.collection_cases(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
  original_invoice_ids uuid[] NOT NULL DEFAULT '{}',
  provider_type text NOT NULL CHECK (length(provider_type) <= 128),
  description text CHECK (description IS NULL OR length(description) <= 300),
  -- Resolved account for the line amount, and for its VAT where the VAT
  -- arrives on the line itself (taxAmount) rather than as a line of its own.
  account_number text CHECK (account_number IS NULL OR account_number ~ '^[0-9]{4}$'),
  vat_account_number text CHECK (vat_account_number IS NULL OR vat_account_number ~ '^[0-9]{4}$'),
  -- Chosen by a person for a line the ledger could not place.
  account_chosen_by uuid REFERENCES auth.users(id),
  booked boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_settlement_lines_position UNIQUE (settlement_id, position)
);

COMMENT ON TABLE public.collection_settlement_lines IS
  'The lines of a collections payout as the provider sent them (kind, amount, VAT, case), and the accounts each books to.';

CREATE INDEX collection_settlement_lines_case ON public.collection_settlement_lines (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX collection_settlement_lines_invoice ON public.collection_settlement_lines (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX collection_settlement_lines_company ON public.collection_settlement_lines (company_id);

ALTER TABLE public.collection_settlement_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_settlement_lines_select" ON public.collection_settlement_lines
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_settlement_lines TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_settlement_lines TO service_role;
-- no-grant: anon on public.collection_settlement_lines (company data)

CREATE TRIGGER collection_settlement_lines_updated_at
  BEFORE UPDATE ON public.collection_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.collection_settlement_line_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.settlement_id <> OLD.settlement_id OR NEW.position <> OLD.position
       OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount OR NEW.tax_amount <> OLD.tax_amount THEN
      RAISE EXCEPTION 'A settlement line keeps its settlement, position, kind and amounts'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_settlements s WHERE s.id = NEW.settlement_id AND s.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'A settlement line must belong to a settlement of the same company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.collection_cases c WHERE c.id = NEW.case_id AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'A settlement line can only name a case of the same company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.invoices i WHERE i.id = NEW.invoice_id AND i.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'A settlement line can only name an invoice of the same company'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_settlement_line_shape_guard
  BEFORE INSERT OR UPDATE ON public.collection_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION public.collection_settlement_line_shape_guard();

-- =============================================================================
-- 4. journal_entries.source_type: add 'collection_settlement'
-- =============================================================================
-- Rebuilt from 20261015001000_migrated_invoice_deduction.sql (main's latest
-- definition, the 32 values production validates, rot_rut_reclassification
-- included): full list preserved, new value appended. An older copy applied
-- after that migration would drop rot_rut_reclassification. TS
-- (JournalEntrySourceType) and Zod (JournalEntrySourceTypeSchema) gain the
-- value in the same change.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual',
    'result_appropriation',
    'rot_rut_payout',
    'vat_settlement',
    'stripe_payout',
    'webshop_order',
    'expense_claim',
    'expense_payout',
    'rot_rut_reclaim',
    'pos_daily_sales',
    'rot_rut_reclassification',
    'collection_settlement'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- One live payout voucher per settlement: two concurrent bookings cannot
-- both post one (same guard as journal_entries_rot_rut_reclaim_live_unique).
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_collection_settlement_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'collection_settlement'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

-- =============================================================================
-- 5. Disconnect: unbooked collected payments and settlements hold it
-- =============================================================================
-- Rebuilt from 20261012030500_collection_bank_sweep_and_reconcile.sql (the
-- latest definition). The two counts that were 0 until this table existed
-- now count what still waits for the books.

CREATE OR REPLACE FUNCTION public.collection_obligation_counts(p_company_id uuid)
RETURNS TABLE (open_cases integer, unbooked_collected_payments integer, unbooked_settlements integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT (SELECT count(*)::integer FROM public.collection_cases c
           WHERE c.company_id = p_company_id
             AND c.submission_status IN ('submitted', 'registered')
             AND (
               c.is_open
               OR EXISTS (
                 SELECT 1 FROM public.collection_payment_forwards f
                  WHERE f.case_id = c.id AND f.status IN ('pending', 'revert_pending')
               )
             )),
         (SELECT count(*)::integer FROM public.collection_collected_payments p
           WHERE p.company_id = p_company_id
             AND p.status IN ('pending', 'needs_review')),
         (SELECT count(*)::integer FROM public.collection_settlements s
           WHERE s.company_id = p_company_id
             AND s.status IN ('received', 'needs_mapping'))
$$;

REVOKE ALL ON FUNCTION public.collection_obligation_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_obligation_counts(uuid) TO authenticated, service_role;

-- =============================================================================
-- 6. cleanup_sandbox_user: collected payments and settlements
-- =============================================================================
-- Rebuilt from 20261012030400_collection_payment_forwards.sql (the latest
-- definition). The only change: the collected payments and the settlements
-- (with their lines) are deleted before the documents are unlinked, so no
-- RESTRICT reference to a voucher, document, invoice, case or connection is
-- left when those go.

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
  v_companies uuid[];
  v_company uuid;
BEGIN
  -- Verify this is a sandbox user: at least one settings row, and EVERY
  -- settings row flagged sandbox.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  SELECT array_agg(cs.company_id ORDER BY cs.company_id) INTO v_companies
    FROM public.company_settings cs WHERE cs.user_id = p_user_id AND cs.is_sandbox IS TRUE;

  -- The account delete at the end cascades into every company the user
  -- created and every row they authored through a user_id foreign key, with
  -- the delete bypass set. Refuse while anything of theirs lives outside the
  -- sandbox set: a membership, a created company, or authored vouchers or
  -- documents (the BFL-retained rows a former membership can leave behind).
  IF EXISTS (SELECT 1 FROM public.company_members cm
             WHERE cm.user_id = p_user_id AND cm.company_id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.companies c
                WHERE c.created_by = p_user_id AND c.id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.journal_entries je
                WHERE je.user_id = p_user_id AND je.company_id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.document_attachments d
                WHERE d.user_id = p_user_id AND d.company_id <> ALL (v_companies)) THEN
    RAISE EXCEPTION 'User % has data in a company that is not a sandbox', p_user_id;
  END IF;

  -- Serialize teardown with every worker before changing holds or receipts.
  FOREACH v_company IN ARRAY v_companies LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || v_company::text, 0));
    -- Pin the classification until teardown finishes. company_id is unique,
    -- but fail closed even if future schema changes permit conflicting rows.
    PERFORM 1 FROM public.company_settings cs WHERE cs.company_id = v_company FOR SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.company_settings cs
      WHERE cs.company_id = v_company AND cs.is_sandbox IS NOT TRUE) THEN
      RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
    END IF;
  END LOOP;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- SIE work state: remove the SIE-only blockers while the classification
  -- remains available to each retention guard, then release holds and the
  -- IB review pointers so the ordinary deletes below can run.
  DELETE FROM public.sie_duplicate_repair_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_import_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_period_read_leases WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET opening_balance_review_import_id = NULL,
    opening_balance_review_token = NULL, opening_balance_review_entry_id = NULL,
    opening_balance_review_reason = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.sie_imports SET opening_balance_entry_id = NULL WHERE company_id = ANY(v_companies);

  -- The user's API keys die with the account; api_keys.sod_acknowledged_by
  -- (NO ACTION to auth.users) would otherwise block the account delete.
  DELETE FROM public.api_keys WHERE user_id = p_user_id OR company_id = ANY(v_companies);

  -- WORM logs and registers whose delete guard re-verifies sandbox-ness
  -- through company_settings: purged first, while it still exists.
  DELETE FROM public.dimension_retag_log WHERE company_id = ANY(v_companies);
  -- Match log: some rows carry no company_id (lib/invoices/match-log.ts), so
  -- the user's own rows go too; purged before supplier_invoices because
  -- payment_match_log_supplier_invoice_id_fkey is ON DELETE SET NULL and the
  -- guard refuses that UPDATE even during teardown.
  DELETE FROM public.payment_match_log
  WHERE user_id = p_user_id OR company_id = ANY(v_companies);
  DELETE FROM public.journal_entry_rattelse_log WHERE company_id = ANY(v_companies);
  DELETE FROM public.account_reconciliation_attachments WHERE company_id = ANY(v_companies);
  -- signed_by is RESTRICT into auth.users.
  DELETE FROM public.account_reconciliations WHERE company_id = ANY(v_companies);
  -- Before documents: source_document_id is ON DELETE SET NULL and the guard
  -- refuses that UPDATE.
  DELETE FROM public.company_facts WHERE company_id = ANY(v_companies);
  -- Before journal entries: journal_entry_id is ON DELETE SET NULL and a
  -- booked trip refuses that UPDATE.
  DELETE FROM public.mileage_trips WHERE company_id = ANY(v_companies);
  -- Before fiscal periods (RESTRICT) and while the period rows still exist.
  DELETE FROM public.fiscal_period_tax_adjustments WHERE company_id = ANY(v_companies);

  -- Annual report: signature requests and submissions hold RESTRICT
  -- references to the versions, validation runs to versions and periods,
  -- versions to periods and the company.
  DELETE FROM public.arsredovisning_signature_requests WHERE company_id = ANY(v_companies);
  DELETE FROM public.annual_report_validation_runs WHERE company_id = ANY(v_companies);

  -- Documents: unlink from vouchers (block_document_deletion refuses a
  -- document on a posted voucher), detach the bank rows
  -- (transactions_document_id_fkey is RESTRICT; the detach is allowed once
  -- the document no longer sits on a voucher), then the deliveries that
  -- point at the sent PDF (RESTRICT, and block_sent_invoice_document_deletion),
  -- then the documents. The bank rows themselves stay for the companies
  -- cascade, as before: deleting them this early would rewrite every
  -- invoice and supplier invoice payment that points at one.
  -- Collected payments and settlements (20261021120000) hold RESTRICT
  -- references to their vouchers, archived documents, invoices, cases and
  -- connection: they go before all of those (the lines go with their
  -- settlement).
  DELETE FROM public.collection_collected_payments WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_settlements WHERE company_id = ANY(v_companies);
  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE company_id = ANY(v_companies);
  UPDATE public.transactions SET document_id = NULL
  WHERE company_id = ANY(v_companies) AND document_id IS NOT NULL;
  DELETE FROM public.invoice_deliveries WHERE company_id = ANY(v_companies);
  DELETE FROM public.document_attachments WHERE company_id = ANY(v_companies);

  -- Salary payment file archive (20260919105035): WORM with a teardown
  -- bypass that re-verifies through company_settings, and RESTRICT on
  -- salary_runs.
  DELETE FROM public.salary_payment_files WHERE company_id = ANY(v_companies);

  -- Registers that point at vouchers with RESTRICT or NO ACTION.
  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE company_id = ANY(v_companies);
  -- fiscal_periods points at its IB and bokslut vouchers with NO ACTION FKs,
  -- and previous_period_id chains periods to each other the same way.
  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = NULL,
      closing_entry_id = NULL,
      previous_period_id = NULL
  WHERE company_id = ANY(v_companies);
  -- Posted depreciation (RESTRICT; block_posted_depreciation_schedule_delete
  -- honours gnubok.allow_delete) and disposals (assets.disposal_journal_entry_id,
  -- RESTRICT). The schedules go first, then the register rows.
  DELETE FROM public.depreciation_schedules WHERE company_id = ANY(v_companies);
  DELETE FROM public.assets WHERE company_id = ANY(v_companies);
  DELETE FROM public.accrual_schedule_installments WHERE company_id = ANY(v_companies);
  DELETE FROM public.accrual_schedules WHERE company_id = ANY(v_companies);
  DELETE FROM public.vacation_year_closures WHERE company_id = ANY(v_companies);
  DELETE FROM public.agi_declarations WHERE company_id = ANY(v_companies);
  DELETE FROM public.stripe_payment_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.stripe_payouts WHERE company_id = ANY(v_companies);
  DELETE FROM public.webshop_orders WHERE company_id = ANY(v_companies);

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT je.id FROM public.journal_entries je WHERE je.company_id = ANY(v_companies)
  );
  DELETE FROM public.journal_entries WHERE company_id = ANY(v_companies);

  -- Betalfil batches: their items reference supplier_invoices with
  -- ON DELETE RESTRICT, so the batch headers go first (the items cascade).
  DELETE FROM public.supplier_payment_batches WHERE company_id = ANY(v_companies);
  -- Bokio supplier completion: entries hold NO ACTION references to the
  -- supplier invoices and to the work row, the work row to the company.
  DELETE FROM public.bokio_supplier_completion_entries WHERE company_id = ANY(v_companies);
  DELETE FROM public.bokio_supplier_completion_work WHERE company_id = ANY(v_companies);
  DELETE FROM public.supplier_invoices WHERE company_id = ANY(v_companies);

  -- Collections cases (20261012030200): the case trail is append-only and
  -- its teardown window re-verifies through company_settings, so it goes
  -- while those rows exist. The cases hold RESTRICT references to invoices
  -- and connections (deleted further down) and point at pending operations
  -- with SET NULL, so they go before all three.
  -- Payment forwards (20261012030400): a RESTRICT reference to their case,
  -- so they go first.
  DELETE FROM public.collection_payment_forwards WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_case_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_cases WHERE company_id = ANY(v_companies);

  DELETE FROM public.pending_operations WHERE company_id = ANY(v_companies);
  DELETE FROM public.dimensions WHERE company_id = ANY(v_companies);

  -- Journal references are gone. Delete import rows explicitly instead of
  -- relying on the cascade, whose settings-delete order is unknown.
  DELETE FROM public.sie_imports WHERE company_id = ANY(v_companies);
  -- Durable SIE jobs project terminal API operations: guarded, re-verified
  -- through company_settings.
  DELETE FROM public.operations WHERE company_id = ANY(v_companies);
  -- NO ACTION to companies, no cascade.
  DELETE FROM public.processing_history WHERE company_id = ANY(v_companies);
  -- Terminal webhook deliveries: guarded against DELETE.
  DELETE FROM public.webhook_deliveries WHERE company_id = ANY(v_companies);

  -- Rows that the companies cascade would otherwise reach in an order
  -- decided by trigger names: each holds a RESTRICT or NO ACTION reference
  -- to another row of the same company.
  DELETE FROM public.salary_line_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_payslip_deliveries WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_payslip_links WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_run_employees WHERE company_id = ANY(v_companies);
  DELETE FROM public.rot_rut_payout_request_items
  WHERE request_id IN (
    SELECT r.id FROM public.rot_rut_payout_requests r WHERE r.company_id = ANY(v_companies)
  );
  DELETE FROM public.recurring_invoice_schedules WHERE company_id = ANY(v_companies);
  -- Payment rows (20261012030300): a collected payment's delete guard
  -- re-verifies the sandbox through company_settings, so they go explicitly
  -- before the invoices cascade would take them.
  DELETE FROM public.invoice_payments WHERE company_id = ANY(v_companies);
  DELETE FROM public.invoices WHERE company_id = ANY(v_companies);
  DELETE FROM public.deadlines WHERE company_id = ANY(v_companies);
  DELETE FROM public.tax_assessment_notices WHERE company_id = ANY(v_companies);
  DELETE FROM public.annual_report_versions WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_job_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_jobs WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_source_records WHERE company_id = ANY(v_companies);

  -- Collections connections (20261012030100): the event trail is append-only
  -- and its teardown window re-verifies through company_settings, so it goes
  -- while those rows exist; the connections follow it.
  DELETE FROM public.collection_connection_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_connections WHERE company_id = ANY(v_companies);

  DELETE FROM public.audit_log WHERE company_id = ANY(v_companies);

  -- The companies themselves, before the account: every company-scoped row
  -- that references auth.users is gone before the account delete checks it.
  DELETE FROM public.companies WHERE id = ANY(v_companies);

  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
