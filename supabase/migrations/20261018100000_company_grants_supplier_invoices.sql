-- Grants, slice 2: a known supplier's invoice from the inbox, booked
-- unattended within a rule the company accepted.
--
-- Slice 1 (20261017100000-100500) let a grant cover one operation type,
-- categorize_transaction: a bank line booked by category. This widens
-- company_grants to the second, create_supplier_invoice_from_inbox: the staged
-- operation gnubok_create_supplier_invoice_from_inbox writes, which registers
-- the supplier invoice and, for a company that books invoices when they are
-- registered (faktureringsmetoden without deferred booking), posts its
-- registration verifikat in the same commit.
--
-- 1. company_grants: the operation type CHECK takes the new type, and a
--    supplier-invoice grant has its own shape (company_grants_shape_check):
--      supplier_id      the supplier, by id (never a name or a bank text);
--      counterparty_key 'supplier:' || supplier_id, so the rule key, the one
--                       active version per rule and the version numbering of
--                       slice 1 apply unchanged;
--      direction        'out': a purchase;
--      vat_treatment    the invoice's VAT treatment, required;
--      reverse_charge_kind  under reverse charge, the kind the supplier's type
--                       books (eu_services, non_eu_services, domestic_services);
--      item_lines       every invoice line's booking as '<account>:<VAT %>'
--                       ('6212:25'), sorted and distinct: the lines may repeat
--                       an account and rate, but no other may appear;
--      line_accounts    every account the registration verifikat touches,
--                       2440 included (now up to 16: a reverse-charge
--                       verifikat adds 2645, 26x4 and the basis pair);
--      category, account_number  NULL (they describe a bank-line booking).
--    A bank-line grant keeps exactly its slice 1 shape (at most 8 accounts).
--    No foreign key on supplier_id, like credential_id: a supplier that is
--    gone leaves the grant inert (the claim finds no supplier), and a grant
--    never blocks deleting a supplier.
--
-- 2. company_grant_uses.inbox_item_id: the inbox item a supplier-invoice use
--    booked, the way transaction_id names a bank line's: one live claim per
--    item, and the review and the revocation name it.
--
-- Nothing here touches the bookkeeping: no journal table is written and no
-- trigger of migration 017 is touched. The functions follow in
-- 20261018100100 (pattern, create) and 20261018100200 (claim, completion,
-- review, revoke), the detector input in 20261018100300.
--
-- pg-test: tests/pg/company-grants-supplier-invoices.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. company_grants
-- =============================================================================

ALTER TABLE public.company_grants DROP CONSTRAINT company_grants_operation_type_check;
ALTER TABLE public.company_grants
  ADD CONSTRAINT company_grants_operation_type_check
  CHECK (operation_type IN ('categorize_transaction', 'create_supplier_invoice_from_inbox'));

ALTER TABLE public.company_grants
  ADD COLUMN supplier_id uuid,
  ADD COLUMN item_lines text[];

ALTER TABLE public.company_grants
  ALTER COLUMN category DROP NOT NULL,
  ALTER COLUMN account_number DROP NOT NULL;

ALTER TABLE public.company_grants DROP CONSTRAINT company_grants_line_accounts_check;
ALTER TABLE public.company_grants
  ADD CONSTRAINT company_grants_line_accounts_check
  CHECK (cardinality(line_accounts) BETWEEN 2 AND 16
         AND (account_number IS NULL OR account_number = ANY (line_accounts)));

ALTER TABLE public.company_grants
  ADD CONSTRAINT company_grants_shape_check
  CHECK (
    CASE operation_type
      WHEN 'categorize_transaction' THEN
        category IS NOT NULL AND account_number IS NOT NULL AND cardinality(line_accounts) <= 8
        AND supplier_id IS NULL AND item_lines IS NULL
      WHEN 'create_supplier_invoice_from_inbox' THEN
        category IS NULL AND account_number IS NULL AND direction = 'out'
        AND supplier_id IS NOT NULL AND counterparty_key = 'supplier:' || supplier_id::text
        AND vat_treatment IS NOT NULL
        AND (reverse_charge_kind IS NOT NULL) = (vat_treatment = 'reverse_charge')
        AND item_lines IS NOT NULL AND cardinality(item_lines) BETWEEN 1 AND 12
        AND array_to_string(item_lines, ',') ~ '^[0-9]{4}:(0|6|12|25)(,[0-9]{4}:(0|6|12|25))*$'
        AND '2440' = ANY (line_accounts)
      ELSE false
    END
  );

COMMENT ON COLUMN public.company_grants.supplier_id IS
  'create_supplier_invoice_from_inbox only: the supplier the rule covers, by id. No foreign key: a supplier that is gone leaves the rule inert.';
COMMENT ON COLUMN public.company_grants.item_lines IS
  'create_supplier_invoice_from_inbox only: every invoice line''s booking as <account>:<VAT %>, sorted and distinct. A staged invoice must carry exactly this set.';
COMMENT ON COLUMN public.company_grants.line_accounts IS
  'Every account the posting may touch, sorted and distinct (business or cost accounts, VAT accounts, the bank account or 2440). The posted verifikat must touch exactly these.';

-- =============================================================================
-- 2. company_grant_uses.inbox_item_id
-- =============================================================================

ALTER TABLE public.company_grant_uses
  ADD COLUMN inbox_item_id uuid REFERENCES public.invoice_inbox_items(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.company_grant_uses.inbox_item_id IS
  'The inbox item a supplier-invoice use booked (create_supplier_invoice_from_inbox); transaction_id names a bank line''s.';

CREATE INDEX idx_company_grant_uses_inbox_item
  ON public.company_grant_uses (inbox_item_id) WHERE inbox_item_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
