-- Add personnummer to customers.
--
-- For customer_type = 'individual' we need to capture the personal number
-- (personnummer) for ROT/RUT invoicing and identification on receipts.
-- Stored as the same TEXT column shape as org_number — application code
-- continues to use customer_type to decide which field to surface.
--
-- Accepts the canonical Swedish personnummer formats:
--   YYMMDD-XXXX     (10 digits, century-less)
--   YYMMDD+XXXX     (10 digits, '+' separator for individuals 100+ years old)
--   YYYYMMDD-XXXX   (12 digits, full year)
--   YYYYMMDD+XXXX   (12 digits, '+' separator)
--   With separator omitted: YYMMDDXXXX or YYYYMMDDXXXX
--
-- NULL is allowed (only required when applicable / user-provided).

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS personal_number TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND conname = 'customers_personal_number_check'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_personal_number_check
      CHECK (personal_number IS NULL OR personal_number ~ '^(\d{6}|\d{8})[-+]?\d{4}$');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
