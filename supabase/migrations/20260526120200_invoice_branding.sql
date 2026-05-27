-- Per-company invoice branding: primary/accent color, font family, optional
-- header/footer text. Applied to the invoice PDF and the customer email.
--
-- Defaults preserve current behavior:
--   - primary color #1a1a1a (the existing PDF heading color)
--   - accent  color #666666 (the existing muted label color)
--   - font family 'Helvetica' (the existing react-pdf built-in)
--
-- Font allowlist is restricted to the three react-pdf built-in PostScript
-- fonts (Helvetica, Times-Roman, Courier). This keeps us AGPL-clean — no
-- proprietary font binaries are bundled or fetched at render time.
--
-- Hex color format is enforced with a regex CHECK so invalid colors never
-- reach the PDF renderer (which would silently fall back to black).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_primary_color TEXT NOT NULL DEFAULT '#1a1a1a',
  ADD COLUMN IF NOT EXISTS invoice_accent_color TEXT NOT NULL DEFAULT '#666666',
  ADD COLUMN IF NOT EXISTS invoice_font_family TEXT NOT NULL DEFAULT 'Helvetica',
  ADD COLUMN IF NOT EXISTS invoice_header_text TEXT NULL,
  ADD COLUMN IF NOT EXISTS invoice_footer_text TEXT NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_invoice_font_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_invoice_font_check
  CHECK (invoice_font_family IN ('Helvetica', 'Times-Roman', 'Courier'));

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_primary_color_format;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_primary_color_format
  CHECK (invoice_primary_color ~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_accent_color_format;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_accent_color_format
  CHECK (invoice_accent_color ~ '^#[0-9A-Fa-f]{6}$');

NOTIFY pgrst, 'reload schema';
