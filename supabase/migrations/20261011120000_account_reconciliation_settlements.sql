-- pg-test: covered-by tests/pg/account-reconciliation-settlements.pg.test.ts
-- Verifikat on one reconciliation account that take each other back.
--
-- "I bokföringen, saknas på banken" lists what the ledger claims about a bank
-- account that the bank does not show. A wrong verifikat and the verifikat
-- that corrects it claim nothing together, but only a correction made through
-- reverseEntry carries a link the reconciliation can read (source_type
-- 'storno', reversed_by_id). A rättelse booked by hand, or imported from
-- another system, carries none, so both verifikat stayed in the list for good
-- (crm#1074).
--
-- A settlement is the statement "these verifikat explain each other on this
-- account", made by a person or an agent the person approved. It never touches
-- the ledger: one row per verifikat, grouped by settlement_id, with who and
-- when, and an undo stamp instead of a delete so the history stays readable.
--
-- The reader decides whether a settlement still holds, not this table: it is
-- honoured only while every verifikat in it is still posted, still without a
-- bank row and the open amounts still sum to zero
-- (src/lib/reconciliation/ledger-settlement-store.ts). So no row written here
-- can move the reconciliation bridge: at worst a row is ignored.
--
-- Keyed by ledger account number, not by cash account and not by anything a
-- bank feed provider issues: the list it corrects is computed per ledger
-- account (get_unlinked_gl_lines), and a reconnected or replaced bank
-- connection gets new cash_accounts rows while the verifikat keep their
-- account.

CREATE TABLE public.account_reconciliation_settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- One settlement is two or more rows sharing this id.
  settlement_id    uuid NOT NULL,
  account_number   text NOT NULL CHECK (account_number ~ '^[0-9]{4}$'),
  -- CASCADE: a settlement about a verifikat that no longer exists says nothing
  -- (a posted verifikat is never deleted outside a sandbox teardown or a
  -- migration reset, and both remove the whole company's rows).
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  -- What the verifikat left open on the account when it was settled (debit
  -- positive), for the record. The reader recomputes from the ledger.
  amount           numeric(15, 2) NOT NULL,
  settled_by       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  settled_at       timestamptz NOT NULL DEFAULT now(),
  undone_at        timestamptz,
  undone_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One direction only: the stamp survives when the person's row is removed.
  CONSTRAINT account_reconciliation_settlements_undo_stamp
    CHECK (undone_by IS NULL OR undone_at IS NOT NULL)
);

COMMENT ON TABLE public.account_reconciliation_settlements IS
  'Verifikat on one ledger account settled against each other in the reconciliation (a wrong verifikat and its hand-made correction). One row per verifikat, grouped by settlement_id. Never touches the ledger; undo stamps instead of deleting.';

-- A verifikat is in at most one live settlement per account. Also the read
-- path: "live settlements on this account".
CREATE UNIQUE INDEX ux_account_reconciliation_settlements_active
  ON public.account_reconciliation_settlements (company_id, account_number, journal_entry_id)
  WHERE undone_at IS NULL;

CREATE INDEX idx_account_reconciliation_settlements_settlement
  ON public.account_reconciliation_settlements (settlement_id);

CREATE INDEX idx_account_reconciliation_settlements_entry
  ON public.account_reconciliation_settlements (journal_entry_id);

-- Only the undo stamp may change, and only once: the row is the record of who
-- settled what and when.
CREATE FUNCTION public.account_reconciliation_settlements_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
     OR NEW.account_number IS DISTINCT FROM OLD.account_number
     OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.settled_by IS DISTINCT FROM OLD.settled_by
     OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'account_reconciliation_settlements rows are append-only; only the undo stamp may change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- An undone settlement stays undone; the stamp keeps its time. undone_by may
  -- still go to NULL (ON DELETE SET NULL when the person's row is removed).
  IF OLD.undone_at IS NOT NULL AND (
       NEW.undone_at IS DISTINCT FROM OLD.undone_at
       OR (NEW.undone_by IS DISTINCT FROM OLD.undone_by AND NEW.undone_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'an undone settlement cannot be restored or re-stamped; settle the verifikat again instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_account_reconciliation_settlements_freeze
  BEFORE UPDATE ON public.account_reconciliation_settlements
  FOR EACH ROW EXECUTE FUNCTION public.account_reconciliation_settlements_freeze();

ALTER TABLE public.account_reconciliation_settlements ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_reconciliation_settlements TO service_role;
-- No DELETE for people: a settlement is undone with the stamp, never removed.
GRANT SELECT, INSERT, UPDATE ON TABLE public.account_reconciliation_settlements TO authenticated;

-- Same shape as account_reconciliations (the sign-offs): every member reads,
-- owners, admins and members write as themselves, viewers look. requireWrite
-- on the routes is the first layer; this is defense in depth.
CREATE POLICY "account_reconciliation_settlements_select" ON public.account_reconciliation_settlements
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- The verifikat must be the company's own: without the EXISTS a member could
-- name another company's verifikat id in a row of their own company.
CREATE POLICY "account_reconciliation_settlements_insert" ON public.account_reconciliation_settlements
  FOR INSERT WITH CHECK (
    settled_by = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
    AND EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.id = journal_entry_id
        AND je.company_id = account_reconciliation_settlements.company_id
    )
  );

-- UPDATE exists only for the undo stamp (the freeze trigger refuses the rest),
-- and a person stamps it as themselves.
CREATE POLICY "account_reconciliation_settlements_update" ON public.account_reconciliation_settlements
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    (undone_by IS NULL OR undone_by = auth.uid())
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

NOTIFY pgrst, 'reload schema';
