-- Restore two existing main/production prerequisites missing from staging.
-- Existing objects are untouched. The original marker migration also replaced
-- VAT readers; do not replay those older reader definitions over newer code.
-- Sources: 20260914150109 and 20260921084700. Function bodies and permissions
-- match production; no protected enforcement function is modified.
DO $restore$
BEGIN
  IF to_regclass('public.kontantmetod_cutoff_entries') IS NULL THEN
    IF to_regprocedure('public.guard_kontantmetod_cutoff_entry()') IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected partial cutoff prerequisite; review its existing guard before restoration';
    END IF;
    EXECUTE $marker$
CREATE TABLE public.kontantmetod_cutoff_entries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'receivable', 'receivable_reversal', 'payable', 'payable_reversal'
  )),
  journal_entry_id uuid NOT NULL UNIQUE REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_kontantmetod_cutoff_entries_company_period
  ON public.kontantmetod_cutoff_entries (company_id, fiscal_period_id);

ALTER TABLE public.kontantmetod_cutoff_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY kontantmetod_cutoff_entries_select
  ON public.kontantmetod_cutoff_entries FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY kontantmetod_cutoff_entries_insert
  ON public.kontantmetod_cutoff_entries FOR INSERT
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

REVOKE ALL ON public.kontantmetod_cutoff_entries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.kontantmetod_cutoff_entries TO authenticated, service_role;

INSERT INTO public.kontantmetod_cutoff_entries (company_id, fiscal_period_id, kind, journal_entry_id)
SELECT e.company_id,
       e.source_id,
       CASE e.description
         WHEN 'Kundfordringar vid bokslut (kontantmetoden)' THEN 'receivable'
         WHEN 'Vändning kundfordringar bokslut (kontantmetoden)' THEN 'receivable_reversal'
         WHEN 'Leverantörsskulder vid bokslut (kontantmetoden)' THEN 'payable'
         WHEN 'Vändning leverantörsskulder bokslut (kontantmetoden)' THEN 'payable_reversal'
       END,
       e.id
FROM public.journal_entries e
WHERE e.source_type = 'year_end'
  AND e.status IN ('posted', 'reversed')
  AND e.source_id IS NOT NULL
  AND e.description IN (
    'Kundfordringar vid bokslut (kontantmetoden)',
    'Vändning kundfordringar bokslut (kontantmetoden)',
    'Leverantörsskulder vid bokslut (kontantmetoden)',
    'Vändning leverantörsskulder bokslut (kontantmetoden)'
  )
  AND EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
    WHERE fp.id = e.source_id AND fp.company_id = e.company_id
  )
ON CONFLICT (journal_entry_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_kontantmetod_cutoff_entry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_pair_kind text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entries e
    WHERE e.id = NEW.journal_entry_id
      AND e.company_id = NEW.company_id
      AND e.source_type = 'year_end'
      AND e.source_id = NEW.fiscal_period_id
  ) THEN
    RAISE EXCEPTION 'kontantmetod cut-off marker must reference a year_end journal entry in the same company, anchored to the closed period'
      USING ERRCODE = '23514';
  END IF;

  v_pair_kind := CASE NEW.kind
    WHEN 'receivable_reversal' THEN 'receivable'
    WHEN 'payable_reversal' THEN 'payable'
  END;

  IF v_pair_kind IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.kontantmetod_cutoff_entries k
    WHERE k.company_id = NEW.company_id
      AND k.fiscal_period_id = NEW.fiscal_period_id
      AND k.kind = v_pair_kind
      AND NOT EXISTS (
        (SELECT account_number, debit_amount, credit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id)
        EXCEPT ALL
        (SELECT account_number, credit_amount, debit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = k.journal_entry_id)
      )
      AND NOT EXISTS (
        (SELECT account_number, credit_amount, debit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = k.journal_entry_id)
        EXCEPT ALL
        (SELECT account_number, debit_amount, credit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id)
      )
  ) THEN
    RAISE EXCEPTION 'kontantmetod vändning marker requires an already marked cut-off for the same period whose verifikat it mirrors line for line'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_kontantmetod_cutoff_entry() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_kontantmetod_cutoff_entry
  BEFORE INSERT ON public.kontantmetod_cutoff_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_kontantmetod_cutoff_entry();
$marker$;
  END IF;
  IF to_regprocedure('public.attach_supplier_invoice_settlement_voucher(uuid,uuid,uuid,uuid,text,boolean)') IS NULL THEN
    EXECUTE $attach$
CREATE OR REPLACE FUNCTION public.attach_supplier_invoice_settlement_voucher(
  p_supplier_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_invoice RECORD;
  v_voucher RECORD;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
  v_accounting_method text;
  v_settled numeric;
  v_explained numeric;
  v_unexplained numeric;
  v_matched numeric;
  v_used numeric;
  v_capacity numeric;
  v_payment_id uuid;
  -- An explicit NULL fails safe: nothing is written and the result says so.
  -- Left raw, `IF NOT NULL` would skip the INSERT and still answer ok, which
  -- reads as a write that never happened.
  v_dry_run boolean := COALESCE(p_dry_run, true);
BEGIN
  -- Attribution, as in link_supplier_invoice_to_voucher: for a user session the
  -- JWT sub is authoritative, so p_user_id cannot point the row at someone else.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTACH_SI_SETTLEMENT_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

  -- Serialise on the verifikat first, then on the invoice row. Two invoices
  -- attaching to one batch-payment verifikat at the same moment would otherwise
  -- both pass the capacity check below. The order is fixed (verifikat, then
  -- invoice) and link_supplier_invoice_to_voucher takes the invoice row lock
  -- only, so no two callers can wait on each other in a cycle.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('si-settlement-voucher:' || p_journal_entry_id::text, 0)
  );

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND');
  END IF;

  SELECT id, status, source_type, entry_date, reversed_by_id INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_FOUND');
  END IF;

  -- Before every state check, so a batch that is run twice reports the pair as
  -- already attached instead of as an invoice with nothing left to explain.
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND supplier_invoice_id = p_supplier_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED');
  END IF;

  -- Before the status check, so a credit note always gets this answer. The
  -- supplier_invoices_credit_note_not_payable constraint keeps a new credit
  -- note out of 'paid', but it is NOT VALID: a row that predates it can still
  -- stand as a paid credit note, and must not slip through as an invoice.
  IF COALESCE(v_invoice.is_credit_note, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CREDIT_NOTE_UNSUPPORTED');
  END IF;

  -- An open invoice is link_supplier_invoice_to_voucher's business: that one
  -- records the payment. This one only explains a settlement that already stands.
  IF v_invoice.status NOT IN ('paid', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOT_SETTLED',
      'details', jsonb_build_object('status', v_invoice.status));
  END IF;

  IF COALESCE(v_invoice.currency, 'SEK') <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CURRENCY_UNSUPPORTED',
      'details', jsonb_build_object('invoice_currency', v_invoice.currency));
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status));
  END IF;

  -- reverseEntry() flips a cancelled verifikat to status 'reversed', which the
  -- check above already refuses; reversed_by_id is read as well so a cancelled
  -- verifikat can never pass on the status alone.
  IF v_voucher.reversed_by_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE',
      'details', jsonb_build_object('reason', 'reversed'));
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE',
      'details', jsonb_build_object('reason', 'source_type', 'source_type', v_voucher.source_type));
  END IF;

  -- A closed or locked period is NOT a reason to refuse: the row is reskontra,
  -- no verifikat is written or changed, and the payments this exists for sit in
  -- imported years that are closed by nature (link_supplier_invoice_to_voucher
  -- allows a locked period on the same ground). What must not happen is that a
  -- figure already ACTED ON shifts silently. A posted kontantmetoden cut-off for
  -- a year ending on E counted this invoice as a skuld when the invoice is
  -- dated on or before E and no payment on or before E was known. Evidence
  -- dated on or before E would make a recomputation disagree with that posted
  -- verifikat, with no rättelse to say why. So it is refused: the wrong cut-off
  -- is corrected first (storno the pair, which then reads as absent here exactly
  -- as it does in inspectKontantmetodCutoffPostings, and post it again).
  -- Evidence dated after E leaves that cut-off right and passes.
  IF EXISTS (
    SELECT 1
    FROM public.kontantmetod_cutoff_entries k
    JOIN public.journal_entries cje ON cje.id = k.journal_entry_id
    JOIN public.fiscal_periods fp ON fp.id = k.fiscal_period_id
    WHERE k.company_id = p_company_id
      AND k.kind = 'payable'
      AND cje.status = 'posted'
      AND fp.period_end >= v_voucher.entry_date
      AND fp.period_end >= v_invoice.invoice_date
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CUTOFF_ALREADY_POSTED',
      'details', jsonb_build_object(
        'voucher_date', v_voucher.entry_date,
        'invoice_date', v_invoice.invoice_date
      ));
  END IF;

  -- What stands as settled. 'paid' means the whole total by definition of the
  -- status, and the total is also what the cut-off measures the rows against;
  -- 'partially_paid' is settled to the extent paid_amount says.
  v_settled := ROUND((CASE WHEN v_invoice.status = 'paid'
                           THEN COALESCE(v_invoice.total, 0)
                           ELSE COALESCE(v_invoice.paid_amount, 0) END) * 100) / 100;

  SELECT COALESCE(SUM(amount), 0) INTO v_explained
  FROM public.supplier_invoice_payments
  WHERE company_id = p_company_id
    AND supplier_invoice_id = p_supplier_invoice_id;
  v_explained := ROUND(v_explained * 100) / 100;

  v_unexplained := ROUND((v_settled - v_explained) * 100) / 100;
  IF v_unexplained <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOTHING_TO_EXPLAIN',
      'details', jsonb_build_object('settled', v_settled, 'explained', v_explained));
  END IF;

  -- The settlement side, by accounting method (defaults to accrual when there
  -- is no settings row, as in link_invoice_to_voucher).
  SELECT cs.accounting_method INTO v_accounting_method
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  v_accounting_method := COALESCE(v_accounting_method, 'accrual');

  IF v_accounting_method = 'cash' THEN
    -- Kontantmetoden: the paying verifikat credits a liquid-funds account (19xx).
    SELECT COALESCE(SUM(credit_amount), 0) INTO v_matched
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '19%'
      AND credit_amount > 0;
  ELSE
    -- Faktureringsmetoden: the paying verifikat debits leverantörsskulder (244x).
    SELECT COALESCE(SUM(debit_amount), 0) INTO v_matched
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '244%'
      AND debit_amount > 0;
  END IF;
  v_matched := ROUND(v_matched * 100) / 100;

  IF v_matched <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE',
      'details', jsonb_build_object(
        'accounting_method', v_accounting_method,
        'expected', CASE WHEN v_accounting_method = 'cash' THEN '19xx credit' ELSE '244x debit' END
      ));
  END IF;

  -- A row in another currency on the same verifikat has used an amount of the
  -- kronor side that cannot be read off the row, so the capacity is unknown.
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND journal_entry_id = p_journal_entry_id
      AND COALESCE(currency, 'SEK') <> 'SEK'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_CURRENCY_UNSUPPORTED');
  END IF;

  -- Every row already pointing at this verifikat, whichever invoice and
  -- whichever path wrote it, has used part of its settlement side.
  SELECT COALESCE(SUM(amount), 0) INTO v_used
  FROM public.supplier_invoice_payments
  WHERE company_id = p_company_id
    AND journal_entry_id = p_journal_entry_id;
  v_used := ROUND(v_used * 100) / 100;

  v_capacity := ROUND((v_matched - v_used) * 100) / 100;
  IF v_unexplained > v_capacity + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER',
      'details', jsonb_build_object(
        'unexplained', v_unexplained,
        'voucher_settlement_side', v_matched,
        'already_attached', v_used,
        'capacity', v_capacity
      ));
  END IF;

  IF NOT v_dry_run THEN
    -- The fixed prefix marks every row this function wrote, so one run can be
    -- found and undone with a single DELETE (same idea as backfill:#2019).
    INSERT INTO public.supplier_invoice_payments (
      user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
      journal_entry_id, transaction_id, notes
    ) VALUES (
      v_acting_user, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
      v_unexplained, 'SEK', p_journal_entry_id, NULL,
      'settlement-evidence' || CASE WHEN p_notes IS NULL THEN '' ELSE ': ' || p_notes END
    )
    RETURNING id INTO v_payment_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', v_dry_run,
    'payment_id', v_payment_id,
    'supplier_invoice_id', p_supplier_invoice_id,
    'journal_entry_id', p_journal_entry_id,
    'payment_date', v_voucher.entry_date,
    'amount', v_unexplained,
    'settled', v_settled,
    'explained_before', v_explained,
    'voucher_settlement_side', v_matched,
    'voucher_capacity_after', ROUND((v_capacity - v_unexplained) * 100) / 100
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attach_supplier_invoice_settlement_voucher(uuid, uuid, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_supplier_invoice_settlement_voucher(uuid, uuid, uuid, uuid, text, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.attach_supplier_invoice_settlement_voucher(uuid, uuid, uuid, uuid, text, boolean) IS
  'Attach the posted verifikat that paid an ALREADY settled supplier invoice (status paid or partially_paid) as the evidence for the part of the settled amount no supplier_invoice_payments row explains yet. Writes one payment row dated at the verifikat and nothing else: the invoice row and the journal are never touched. Accounting-method aware (19xx credit on kontantmetoden, 244x debit on faktureringsmetoden); one verifikat may settle several invoices up to its settlement side. SEK invoices only, no credit notes. A closed period does not refuse; a posted kontantmetoden cut-off that the evidence would contradict does. p_dry_run runs every check without writing. For an OPEN invoice use link_supplier_invoice_to_voucher, which records the payment.';
$attach$;
  END IF;
END;
$restore$;
NOTIFY pgrst, 'reload schema';
