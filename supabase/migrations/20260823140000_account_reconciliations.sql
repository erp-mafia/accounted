-- Sign-offs for account reconciliation ("Markera som avstämd t.o.m. <datum>").
--
-- lib/reconciliation computes, for every account with an outside truth (bank
-- accounts, the skattekonto, later manual accounts), whether the outside
-- balance and the ledger agree and what explains the difference. A sign-off
-- is the human (or agent-staged, user-approved) assertion on top of that
-- computation: "through this date, this account is reconciled", with the
-- numbers as they stood when it was made. It is what the overview, the Hem
-- row and an auditor read; it never touches the ledger.
--
-- Append-only with a reopen stamp instead of delete: the history of who
-- signed what and when is the point of the table. A sign-off that turns out
-- wrong is reopened (reopened_at/by/reason), never removed, and a new one can
-- then be made for the same date.
--
-- account_key is the same qualified key the reconciliation API uses
-- ("bank:<cash_account_id>", "skattekonto", later "manual:NNNN"), checked
-- by regex here so a typo cannot create an orphan account. A bank account's
-- rows are not cascaded when the cash account goes away: the sign-off stays
-- as history (the key just stops resolving).

CREATE TABLE IF NOT EXISTS public.account_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL
    CHECK (account_key ~ '^(bank:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|skattekonto|manual:[0-9]{4})$'),
  -- Inclusive: the account is asserted reconciled for every day up to this one.
  through_date DATE NOT NULL,
  -- The numbers as computed at sign-off time (null when the outside side was
  -- unknown, e.g. a bank account without a fetched balance).
  external_balance NUMERIC(15, 2),
  ledger_balance NUMERIC(15, 2),
  unexplained_difference NUMERIC(15, 2),
  -- Required when unexplained_difference is not zero (the signer explains why
  -- they sign anyway); optional otherwise.
  note TEXT,
  signed_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reopened_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reopen_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT account_reconciliations_reopen_pair
    CHECK ((reopened_at IS NULL) = (reopened_by IS NULL))
);

COMMENT ON TABLE public.account_reconciliations IS
  'Reconciliation sign-offs per account (bank:<id> / skattekonto / manual:NNNN): "avstämt t.o.m. through_date". Append-only; reopen stamps instead of deleting.';

-- One active sign-off per account and date; a reopened one frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_reconciliations_active
  ON public.account_reconciliations (company_id, account_key, through_date)
  WHERE reopened_at IS NULL;

-- "Latest active sign-off per account" is the hot read (rail, status, worklist).
CREATE INDEX IF NOT EXISTS idx_account_reconciliations_latest
  ON public.account_reconciliations (company_id, account_key, through_date DESC)
  WHERE reopened_at IS NULL;

ALTER TABLE public.account_reconciliations ENABLE ROW LEVEL SECURITY;

-- Every member of the company reads the sign-offs (the overview shows them to
-- viewers too). Writes are for owners, admins and members: a viewer may look
-- but not attest. The application additionally enforces the write role on
-- its routes (requireWrite); this is the defense-in-depth layer.
DROP POLICY IF EXISTS "account_reconciliations_select" ON public.account_reconciliations;
CREATE POLICY "account_reconciliations_select" ON public.account_reconciliations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "account_reconciliations_insert" ON public.account_reconciliations;
CREATE POLICY "account_reconciliations_insert" ON public.account_reconciliations
  FOR INSERT WITH CHECK (
    signed_by = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

-- UPDATE exists only for the reopen stamp. Rows stay otherwise immutable by
-- convention (no route writes anything else); no DELETE policy at all.
DROP POLICY IF EXISTS "account_reconciliations_update" ON public.account_reconciliations;
CREATE POLICY "account_reconciliations_update" ON public.account_reconciliations
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

NOTIFY pgrst, 'reload schema';
