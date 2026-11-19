-- Which reverse-charge purchase an assistant read says it is.
--
-- A read stored vat_treatment 'reverse_charge' and nothing about the seller,
-- so every such proposal booked as an EU service (ruta 21 basis, 4535). The
-- selector now tells an EU seller from one outside the EU, and this column
-- carries the answer to the booking: 'eu_services' or 'non_eu_services' (the
-- ReverseChargeKind of lib/bookkeeping/vat-entries.ts; ruta 22 basis, 4531,
-- for the latter). NULL on any other treatment and on reads stored before
-- it was kept, which keep booking as an EU service (crm#1028).

ALTER TABLE public.transaction_assistant_reads
  ADD COLUMN reverse_charge_kind text;

COMMENT ON COLUMN public.transaction_assistant_reads.reverse_charge_kind IS
  'Basis box of a reverse-charge read: eu_services (ruta 21) or non_eu_services (ruta 22). NULL = not reverse charge, or not known (books as an EU service).';

NOTIFY pgrst, 'reload schema';
