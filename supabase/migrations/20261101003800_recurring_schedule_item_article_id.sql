-- Recurring invoice schedule lines keep their article (accounted#52).
--
-- recurring_invoice_schedule_items had no article_id, so a line picked from
-- the artikelregister lost its link when saved on a schedule: every invoice
-- the schedule generated booked to the VAT-derived revenue account instead of
-- the article's, and per-article reporting never saw recurring sales.
--
-- article_id mirrors invoice_items.article_id (20260621120000): a nullable
-- soft reference, ON DELETE SET NULL so the template line keeps its own
-- description and price if the article is ever hard-deleted. The spawn
-- (lib/invoices/recurring-schedule-service.ts) copies it onto the generated
-- invoice line together with the article's number and revenue account, read
-- when that invoice is created, the way the invoice editor copies them when a
-- line is written. Tenancy (the article belongs to the schedule's company) is
-- checked by every door before the write and by the spawn's company-scoped
-- read.
--
-- Additive only: one nullable column (metadata-only, no table rewrite; every
-- existing row reads NULL = no article, today's behaviour) and its FK index.
-- The app tolerates the column missing for the minutes between deploy and
-- this migration (PGRST204/42703 fallback in recurring-schedule-items.ts).
--
-- pg-test: skip (plain nullable column + FK index, no trigger/RPC/RLS/DEFERRABLE change; propagation is TS-side, covered by recurring-schedule-service unit tests)

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.recurring_invoice_schedule_items
  ADD COLUMN IF NOT EXISTS article_id uuid REFERENCES public.articles(id) ON DELETE SET NULL;

-- ON DELETE SET NULL looks up referencing rows by article_id.
CREATE INDEX IF NOT EXISTS idx_risi_article_id
  ON public.recurring_invoice_schedule_items (article_id)
  WHERE article_id IS NOT NULL;

COMMENT ON COLUMN public.recurring_invoice_schedule_items.article_id IS
  'Article this template line was picked from; copied onto invoice_items.article_id (with the article number and revenue account) for every invoice the schedule generates. NULL = free-text line.';

NOTIFY pgrst, 'reload schema';
