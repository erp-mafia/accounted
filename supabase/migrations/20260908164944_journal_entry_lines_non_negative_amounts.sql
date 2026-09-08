-- Every journal line carries exactly one non-negative side.
--
-- A line with debit_amount = -0.25 balances arithmetically against a credit
-- (the balance trigger never fires), so producers that copied a negative item
-- total straight into debit_amount (supplier-invoice öresavrundning rows on
-- 3740, negative customer-invoice items) shipped 14 such lines to prod. Every
-- reader assumes one positive side per line: the verifikat page hid the row
-- and its sums disagreed with the visible lines.
--
-- NOT VALID: existing rows are repaired by a separate, founder-approved data
-- fix (flip the sign to the opposite column, net unchanged); new inserts and
-- updates are checked from now on. VALIDATE CONSTRAINT follows in a later
-- migration once prod reports zero offending rows.
ALTER TABLE public.journal_entry_lines
  ADD CONSTRAINT journal_entry_lines_amounts_non_negative
  CHECK (debit_amount >= 0 AND credit_amount >= 0)
  NOT VALID;
