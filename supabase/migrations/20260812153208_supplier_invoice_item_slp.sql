-- Särskild löneskatt på pensionskostnader (SLP) on supplier invoice lines.
--
-- Booking a tjänstepension invoice (e.g. Avanza) needs the buyer's own SLP
-- pair beyond the payable: debit 7533 / credit 2514 at 24.26 % of the premium
-- (SLF 1991:687). The pair nets to zero and must never raise 2440. This flag
-- is the per-line opt-in the booking engine reads; it mirrors how reverse
-- charge injects self-balancing fiktiv-moms pairs beyond the payable.

ALTER TABLE public.supplier_invoice_items
  ADD COLUMN apply_slp boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.supplier_invoice_items.apply_slp IS
  'When true, booking the invoice injects a self-balancing särskild löneskatt pair (debit 7533 / credit 2514 at 24.26% of line_total) for this pension-premium line (BAS 7410-7419). The pair nets to zero and never changes the payable (2440).';
