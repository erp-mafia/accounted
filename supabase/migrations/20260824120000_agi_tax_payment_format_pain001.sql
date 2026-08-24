-- Allow ISO 20022 pain.001 as a tax payment file format.
--
-- The skattekonto payment file (skatt + arbetsgivaravgifter to Skatteverket
-- BG 5050-1055) was Bankgirot LB only; banks are sunsetting LB file uploads
-- during 2026 and companies on pain.001 for salary need the same format for
-- the tax payment. The route now generates either format, so the CHECK on
-- agi_declarations.tax_payment_file_format must admit 'pain001'.

ALTER TABLE public.agi_declarations
  DROP CONSTRAINT IF EXISTS agi_declarations_tax_payment_format_check;

ALTER TABLE public.agi_declarations
  ADD CONSTRAINT agi_declarations_tax_payment_format_check
  CHECK (tax_payment_file_format IS NULL OR tax_payment_file_format IN ('bg_lb', 'pain001'));

NOTIFY pgrst, 'reload schema';
