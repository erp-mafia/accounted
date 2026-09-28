-- "I banken" for upcoming Skattekonto debits selected in a tax payment file.
--
-- This is a display-only intermediate mark. It does not book a payment or
-- change the Skatteverket status. It deliberately survives the upcoming row
-- becoming booked: that transition means the tax debit was posted at
-- Skatteverket, not that the separate bank payment reached the tax account.

ALTER TABLE public.skattekonto_transactions
  ADD COLUMN IF NOT EXISTS bank_entered_at timestamptz;

COMMENT ON COLUMN public.skattekonto_transactions.bank_entered_at IS
  'Set when the user confirms that an upcoming tax payment file was entered at the bank. Display-only: books nothing and does not assert that the bank transfer was executed.';

NOTIFY pgrst, 'reload schema';
