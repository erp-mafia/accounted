SELECT set_config('lock_timeout', '5s', true);

-- Purchase-category codes are children of the posting port's business-event
-- categories (one category list). A code is now
-- '<port key>.<item>', e.g. 'expense.software.saas' under expense.software,
-- so it has at least three segments, where 20261017000000 allowed exactly
-- two ('software.saas'). The list itself stays in
-- src/lib/categories/purchase-categories.ts; this CHECK holds the shape only.
--
-- The new shape is the one business_events_category_check enforces (a dotted
-- lower-case key, digits allowed after the first letter, at most 64
-- characters) narrowed to three segments or more: a supplier's instruction
-- is always a child of a port key, never the port key itself, and a value
-- stored here is one a business event can carry as its category.
--
-- Nothing is stored in the old shape: 20261017000000 and this file are
-- applied together, and the column was added without a backfill. Were a
-- two-segment value ever stored,
-- the VALIDATE in 20261017123200 fails the job rather than keep it. Added
-- NOT VALID and validated there, in a separate transaction, so this file
-- never scans the table under the ALTER's lock.

ALTER TABLE public.suppliers
  DROP CONSTRAINT IF EXISTS suppliers_default_purchase_category_check;

ALTER TABLE public.suppliers
  ADD CONSTRAINT suppliers_default_purchase_category_check CHECK (
    default_purchase_category ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$'
    AND length(default_purchase_category) <= 64
  ) NOT VALID;

NOTIFY pgrst, 'reload schema';
