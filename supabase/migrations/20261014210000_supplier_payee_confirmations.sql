-- pg-test: covered-by tests/pg/supplier-payee-confirmations.pg.test.ts
-- A person's decision on a supplier account an invoice states: confirmed
-- (pay it; it covers every later invoice of the supplier with the same
-- account) or rejected (every payment of the supplier to it is held until a
-- person confirms it after all, or puts it on the supplier card).
--
-- Why a table per supplier and account, not columns on supplier_invoices: a
-- confirmation must outlive the invoice that prompted it. The second invoice
-- from the same supplier with the same new bankgiro is not news, and asking
-- again would teach people to click through the question.
--
-- What alerts is derived, never stored (src/lib/payments/payee-change.ts):
-- the invoice's stated account (supplier_invoices.payee_*, 20261010090000)
-- against every account on the supplier card, and the decisions here. The
-- payment file and the bank payment preparation leave an invoice out while
-- its account is unconfirmed (payee_unconfirmed) or rejected
-- (payee_rejected); the worklist shows it as "Nya bankuppgifter hos ...".
--
-- Append-only: a later decision is a new row and the latest per supplier and
-- account wins, so who confirmed or rejected what, and when, stays readable.
-- payee_key is the database's own account key (payment_order_payee_key):
-- 'bankgiro:50501055', 'plusgiro:1234566', 'bank_account:8327:123456789',
-- 'iban:SE45...'.
--
-- Also: pending_operations.operation_type takes confirm_supplier_payee, the
-- staged MCP tool gnubok_confirm_supplier_payee (a person approves it in the
-- web UI only). Expanded from the constraint's current definition (below),
-- NOT VALID; the VALIDATE runs in 20261014210100. Every later migration that
-- rebuilds this list keeps this value, or it drops it again
-- (tests/pg/pending-operations-op-type-audit.pg.test.ts catches that).

CREATE TABLE public.supplier_payee_confirmations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  supplier_id                uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  payee_key                  text NOT NULL CHECK (payee_key ~ '^(bankgiro|plusgiro|bank_account|iban):[0-9A-Z:]+$'),
  decision                   text NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
  decided_by                 uuid NOT NULL REFERENCES auth.users(id),
  decided_at                 timestamptz NOT NULL DEFAULT now(),
  -- The invoice that prompted the decision; kept when that invoice is removed.
  source_supplier_invoice_id uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL,
  -- Confirm only: the account became the supplier card's payment account.
  supplier_card_updated      boolean NOT NULL DEFAULT false,
  note                       text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (decision = 'confirmed' OR NOT supplier_card_updated)
);

COMMENT ON TABLE public.supplier_payee_confirmations IS
  'A person''s decision on a supplier account an invoice states (confirmed or rejected), per supplier and account; append-only, the latest row wins. Holds or releases payment of every invoice of the supplier that states the account.';
COMMENT ON COLUMN public.supplier_payee_confirmations.payee_key IS
  'The account as payment_order_payee_key writes it: bankgiro:<digits>, plusgiro:<digits>, bank_account:<clearing>:<account>, iban:<IBAN>.';
COMMENT ON COLUMN public.supplier_payee_confirmations.decision IS
  'confirmed: pay the account (covers later invoices with the same account). rejected: hold every payment to it until a person confirms it or the supplier card holds it.';
COMMENT ON COLUMN public.supplier_payee_confirmations.decided_by IS
  'The person who decided: a web session, or the person who approved the staged gnubok_confirm_supplier_payee in Accounted. Never an API key alone.';
COMMENT ON COLUMN public.supplier_payee_confirmations.source_supplier_invoice_id IS
  'The supplier invoice whose stated account prompted the decision.';
COMMENT ON COLUMN public.supplier_payee_confirmations.supplier_card_updated IS
  'True when the confirmation also made the account the supplier card''s payment account.';

CREATE INDEX supplier_payee_confirmations_lookup
  ON public.supplier_payee_confirmations (company_id, supplier_id, payee_key, decided_at DESC);

-- Behandlingshistorik: which account a supplier is paid to is a payment
-- control decision, kept with who made it (BFNAR 2013:2 p. 9.16).
CREATE TRIGGER audit_supplier_payee_confirmations
  AFTER INSERT OR DELETE ON public.supplier_payee_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

ALTER TABLE public.supplier_payee_confirmations ENABLE ROW LEVEL SECURITY;

-- Members read their company's decisions; a writing member of the active
-- company records a decision in their own name. No update, no delete: a new
-- decision is a new row.
CREATE POLICY supplier_payee_confirmations_select ON public.supplier_payee_confirmations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY supplier_payee_confirmations_insert ON public.supplier_payee_confirmations
  FOR INSERT WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND decided_by = auth.uid()
  );

GRANT SELECT, INSERT ON TABLE public.supplier_payee_confirmations TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.supplier_payee_confirmations TO service_role;
-- no-grant: anon on public.supplier_payee_confirmations (company payment control data; no public surface reads it)

-- The constraint's own current list plus this value, read from the catalog
-- rather than re-stated from a copy: a branch that adds its own value in
-- parallel (it restates the list from what it saw on main) keeps it, in
-- whichever order the two migrations run.
DO $$
DECLARE
  v_types text[];
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  IF NOT ('confirm_supplier_payee' = ANY (v_types)) THEN
    v_types := v_types || 'confirm_supplier_payee'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
