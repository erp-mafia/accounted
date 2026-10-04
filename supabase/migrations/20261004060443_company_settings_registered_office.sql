-- Säte (registered office) as its own column on company_settings.
--
-- Until now `city` did two jobs: the postal town of the company's address
-- (settings label "Ort", printed on invoices, Peppol and INK2) and the säte
-- the annual report states ("Säte: ...", "Bolaget har sitt säte i ...", the
-- underskrifter and fastställelseintyg place). The two differ whenever a
-- company's post goes to another town than the municipality it is
-- registered in, and onboarding filled `city` from the postal address, so
-- the annual report printed the postal town as säte.
--
-- `registered_office` is the municipality (kommun) the company is registered
-- in: filled at company creation from SCB's företagsregister (Säteskommun),
-- editable in Settings next to "Ort". Never derived from the postal town.
--
-- Nullable, no backfill: the register value needs an external SCB call,
-- which a migration cannot make. While it is null the annual report falls
-- back to `city` with a visible warning asking the user to check it
-- (lib/bokslut/arsredovisning/registered-office.ts).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS registered_office text;

COMMENT ON COLUMN public.company_settings.registered_office IS
  'Säte: the municipality the company is registered in (SCB Säteskommun at creation, editable in Settings). Printed as säte in the annual report. Not the postal town; that is city.';

NOTIFY pgrst, 'reload schema';
