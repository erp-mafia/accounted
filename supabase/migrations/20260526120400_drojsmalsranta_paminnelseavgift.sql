-- Dröjsmålsränta + lagstadgad påminnelseavgift on invoice reminders.
--
-- When a payment reminder is sent we now compute:
--   1) Statutory late-payment interest per Räntelagen §6
--      (Riksbankens referensränta + 8 procentenheter, or company override)
--   2) The lagstadgad påminnelseavgift (default 60 kr per Lag 1981:739)
--
-- The fee is booked as a journal entry (debit 1510 Kundfordringar,
-- credit 3990 Övriga ersättningar, bidrag och intäkter) so it shows up
-- on the customer's open balance and recognises the income on the income
-- statement. The interest is computed and persisted for display in the
-- email + on the public action page; we do NOT book interest as a
-- journal entry on reminder send — interest is recognised on payment
-- (when the customer actually pays the surcharge) to avoid recognising
-- revenue we may never collect.
--
-- Columns:
--   invoice_reminders.interest_amount      — computed dröjsmålsränta (SEK)
--   invoice_reminders.interest_rate        — annual rate applied (e.g. 0.115 = 11.5%)
--   invoice_reminders.interest_from_date   — start date for interest calc (= invoice due_date)
--   invoice_reminders.interest_days        — number of overdue days used in the calc
--   invoice_reminders.reminder_fee         — lagstadgad påminnelseavgift booked
--   invoice_reminders.fee_journal_entry_id — link to the verifikation that booked the fee
--
--   company_settings.reminder_fee_enabled            — kill switch for the fee
--   company_settings.reminder_fee_amount             — default 60 kr (statutory cap, Lag 1981:739)
--   company_settings.reminder_interest_rate_override — null = use Räntelagen §6 lookup
--
-- We also extend journal_entries.source_type to allow 'reminder_fee'
-- so the fee posting passes the CHECK constraint.

-- ---------------------------------------------------------------------------
-- invoice_reminders: new columns for interest + fee
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoice_reminders
  ADD COLUMN IF NOT EXISTS interest_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_rate NUMERIC(6,4) NULL,
  ADD COLUMN IF NOT EXISTS interest_from_date DATE NULL,
  ADD COLUMN IF NOT EXISTS interest_days INT NULL,
  ADD COLUMN IF NOT EXISTS reminder_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_journal_entry_id UUID NULL
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- company_settings: per-company toggles + override
-- ---------------------------------------------------------------------------
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS reminder_fee_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reminder_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS reminder_interest_rate_override NUMERIC(6,4) NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_reminder_fee_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_reminder_fee_check
  CHECK (reminder_fee_amount >= 0);

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_reminder_interest_override_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_reminder_interest_override_check
  CHECK (
    reminder_interest_rate_override IS NULL
    OR (reminder_interest_rate_override >= 0 AND reminder_interest_rate_override < 1)
  );

-- ---------------------------------------------------------------------------
-- journal_entries: extend source_type to include 'reminder_fee'
-- ---------------------------------------------------------------------------
-- See 20260516060000 for the previous expansion pattern. We preserve all
-- pre-existing source_type values and append the new one.
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid',
    'reminder_fee'
  ));

NOTIFY pgrst, 'reload schema';
