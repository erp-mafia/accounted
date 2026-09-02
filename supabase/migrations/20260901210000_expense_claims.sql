-- Expense claims (utlägg): first-class module for out-of-pocket purchases.
--
-- An expense claim is a receipt someone paid privately: registering it books
-- cost + ingående moms against an owner/employee liability account (2893
-- skulder till närstående for owners, 2820 kortfristiga skulder till
-- anställda for employees, 2018 egen insättning for enskild firma). A payout
-- batch reimburses N registered claims in one bank transfer and books
-- liability against the cash account.
--
-- Claims are registered directly as posted verifikat (status 'registered'):
-- there is no draft state here, unbooked receipts live in the document inbox
-- until they are registered.

CREATE TABLE public.expense_payout_batches (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- Who is reimbursed. employee_id may be null for the owner; claimant_name
  -- is denormalized so history stays readable if the employee row goes away.
  employee_id   uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  claimant_name text NOT NULL,

  payout_date       date NOT NULL,
  cash_account      text NOT NULL CHECK (cash_account ~ '^19[0-9]{2}$'),
  liability_account text NOT NULL CHECK (liability_account IN ('2893', '2820', '2018', '2890')),
  total_sek         numeric(15,2) NOT NULL CHECK (total_sek > 0),
  journal_entry_id  uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  notes             text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Target for the tenant-scoped FK from expense_claims.payout_batch_id.
ALTER TABLE public.expense_payout_batches
  ADD CONSTRAINT expense_payout_batches_id_company_id_key UNIQUE (id, company_id);

COMMENT ON TABLE public.expense_payout_batches IS
  'One reimbursement transfer covering N registered expense claims; books liability -> cash.';

CREATE TABLE public.expense_claims (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

  employee_id   uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  claimant_name text NOT NULL,

  description  text NOT NULL,
  expense_date date NOT NULL,

  -- SEK is the booking truth; the original currency is provenance. The claim
  -- total is gross (incl VAT): vat_sek is the deductible part booked on 2641.
  amount_sek         numeric(15,2) NOT NULL CHECK (amount_sek > 0),
  vat_sek            numeric(15,2) NOT NULL DEFAULT 0
    CHECK (vat_sek >= 0 AND vat_sek < amount_sek),
  currency           text NOT NULL DEFAULT 'SEK',
  amount_in_currency numeric(15,2),
  exchange_rate      numeric(14,6),

  expense_account   text NOT NULL CHECK (expense_account ~ '^[0-9]{4}$'),
  liability_account text NOT NULL DEFAULT '2893'
    CHECK (liability_account IN ('2893', '2820', '2018', '2890')),

  document_id      uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'paid')),
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  -- Same-company by construction: the composite FK below binds the batch to
  -- this row's company, so a member of two companies cannot mark a claim in
  -- one as paid by a batch belonging to the other.
  payout_batch_id  uuid,

  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A paid claim must reference the batch that paid it.
  CHECK (status <> 'paid' OR payout_batch_id IS NOT NULL),

  FOREIGN KEY (payout_batch_id, company_id)
    REFERENCES public.expense_payout_batches(id, company_id) ON DELETE SET NULL
);

COMMENT ON TABLE public.expense_claims IS
  'Out-of-pocket purchase (utlägg): booked as cost + moms against an owner/employee liability on registration.';

ALTER TABLE public.expense_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_payout_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expense_claims_select" ON public.expense_claims
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "expense_claims_insert" ON public.expense_claims
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "expense_claims_update" ON public.expense_claims
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "expense_claims_delete" ON public.expense_claims
  FOR DELETE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

CREATE POLICY "expense_payout_batches_select" ON public.expense_payout_batches
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "expense_payout_batches_insert" ON public.expense_payout_batches
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "expense_payout_batches_update" ON public.expense_payout_batches
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "expense_payout_batches_delete" ON public.expense_payout_batches
  FOR DELETE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

CREATE INDEX idx_expense_claims_company ON public.expense_claims (company_id, expense_date DESC);
CREATE INDEX idx_expense_claims_employee ON public.expense_claims (employee_id);
CREATE INDEX idx_expense_claims_status ON public.expense_claims (company_id, status);
CREATE INDEX idx_expense_claims_batch ON public.expense_claims (payout_batch_id)
  WHERE payout_batch_id IS NOT NULL;
CREATE INDEX idx_expense_payout_batches_company
  ON public.expense_payout_batches (company_id, payout_date DESC);

CREATE TRIGGER set_updated_at_expense_claims
  BEFORE UPDATE ON public.expense_claims
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_updated_at_expense_payout_batches
  BEFORE UPDATE ON public.expense_payout_batches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_expense_claims
  AFTER INSERT OR UPDATE OR DELETE ON public.expense_claims
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER audit_expense_payout_batches
  AFTER INSERT OR UPDATE OR DELETE ON public.expense_payout_batches
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- New journal entry source types so utlägg verifikat are traceable to their
-- module rows. Rule (see 20260811073416): DB allowlist + the TS union +
-- JournalEntrySourceTypeSchema change together.
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
    'expense_payout'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

NOTIFY pgrst, 'reload schema';
