SELECT set_config('lock_timeout', '5s', true);

-- What a supplier's purchases are, as a person said once for every time.
--
-- In the inbox, a person who changes an item's purchase category and ticks
-- "varje gång" makes it an instruction for that supplier: later items from
-- the same supplier (invoice_inbox_items.matched_supplier_id) are proposed
-- that category with the evidence level Ditt val. A person's choice on a
-- single item still outranks it (extracted_data.purchaseCategory), and the
-- learned proposal (the counterparty's booked history, the lines) comes
-- after it. Read and written by src/lib/categories/inbox-purchase-category.ts
-- and src/lib/documents/inbox-purchase-category.ts.
--
-- A column beside default_expense_account rather than a table of its own:
-- the supplier card already holds the supplier's defaults, the inbox read
-- already loads that row for the matched supplier, and audit_suppliers
-- records who set it and when. NULL is no instruction; nothing is
-- backfilled, so nothing changes on screen for anyone.
--
-- The CHECK holds the shape of a purchase-category code ('software.saas'),
-- not the list: the list is versioned in src/lib/categories/
-- purchase-categories.ts and a reader ignores a code it does not know.
-- Added NOT VALID and validated in 20261017000100, in a separate
-- transaction, so this file never scans the table under the ALTER's lock.
--
-- Grants: suppliers keeps table-level privileges, so the column is readable
-- and writable exactly like the rest of the row under its RLS policies.

ALTER TABLE public.suppliers
  ADD COLUMN default_purchase_category text,
  ADD CONSTRAINT suppliers_default_purchase_category_check CHECK (
    default_purchase_category ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'
  ) NOT VALID;

NOTIFY pgrst, 'reload schema';
