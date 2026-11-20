-- Article number on the invoice (crm#1084).
--
-- 1. invoice_items.article_number: the article's number COPIED onto the line
--    when the line is written from an article (lib/invoices/build-invoice-write.ts),
--    the same frozen-copy rule as invoice_items.revenue_account. The invoice
--    PDF and the Peppol e-invoice print the number from the line, so an issued
--    invoice keeps printing the number it was issued with after the article
--    is renumbered, deactivated or deleted (article_id is ON DELETE SET NULL).
--    NULL for free-text and text rows, and for every line written before this
--    migration: nothing is backfilled, so no issued invoice changes.
--
-- 2. company_settings.invoice_show_article_number: whether the invoice PDF
--    prints an article number column and the e-invoice carries the number as
--    the seller's item identifier (BT-155). Off by default, so no company's
--    invoice layout changes until it turns the setting on.

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS article_number text;

COMMENT ON COLUMN public.invoice_items.article_number IS
  'The article number copied from articles.article_number when the line was written from an article; printed on the invoice when company_settings.invoice_show_article_number is on. Never read back from the article.';

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_show_article_number boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.invoice_show_article_number IS
  'Print the article number column on the invoice PDF and send it as the seller item identifier in the Peppol e-invoice.';

NOTIFY pgrst, 'reload schema';
