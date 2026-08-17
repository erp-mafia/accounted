-- Skattekontoutdrag file import support
--
-- Users can download their kontohändelser from Skatteverket's skattekonto
-- e-service (CSV; legacy exports were semicolon .skv text files) and import
-- them manually. Imported rows land in skattekonto_transactions and inherit
-- the existing booking rules, matching and UI. This serves companies without
-- the paid API connection and history beyond the API's ~555-day lookback.
--
-- Two parts:
--   1. skattekonto_file_imports: one row per uploaded file, keyed on
--      (company_id, file_hash) for whole-file duplicate rejection
--      (company-scoped from day one; see 20260707130000 for why the
--      user-scoped variant on bank_file_imports had to be fixed later).
--   2. Provenance on skattekonto_transactions: source distinguishes
--      API-synced rows from file-imported ones (the sync takeover logic
--      needs it), file_import_id links back to the uploaded file.

CREATE TABLE public.skattekonto_file_imports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies ON DELETE CASCADE,
  -- Importer provenance. Nullable + SET NULL so the import record (and the
  -- file-hash dedup it provides) survives the importing user's deletion;
  -- the INSERT policy below binds it to auth.uid() so a member cannot
  -- attribute an import to a colleague.
  user_id UUID REFERENCES auth.users ON DELETE SET NULL,

  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_variant TEXT NOT NULL CHECK (file_variant IN ('csv', 'skv')),

  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  promoted_count INTEGER NOT NULL DEFAULT 0,

  date_from DATE,
  date_to DATE,

  -- "Utgående saldo" from the statement's final marker row. Not yet used
  -- for the balance snapshot (that write stays API-owned for now) but
  -- stored so an import-history or avstämning view can surface it.
  closing_saldo NUMERIC(14, 2),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, file_hash)
);

CREATE INDEX skattekonto_file_imports_company_created_idx
  ON public.skattekonto_file_imports (company_id, created_at DESC);

ALTER TABLE public.skattekonto_file_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see skattekonto file imports for their companies"
  ON public.skattekonto_file_imports FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "Users insert skattekonto file imports for their companies"
  ON public.skattekonto_file_imports FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

CREATE POLICY "Users update skattekonto file imports for their companies"
  ON public.skattekonto_file_imports FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "Users delete skattekonto file imports for their companies"
  ON public.skattekonto_file_imports FOR DELETE
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER update_skattekonto_file_imports_updated_at
  BEFORE UPDATE ON public.skattekonto_file_imports
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Provenance columns. Existing rows were all written by the API sync, so
-- the 'api' default backfills them correctly.
ALTER TABLE public.skattekonto_transactions
  ADD COLUMN source TEXT NOT NULL DEFAULT 'api'
    CHECK (source IN ('api', 'file_import')),
  ADD COLUMN file_import_id UUID
    REFERENCES public.skattekonto_file_imports ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
