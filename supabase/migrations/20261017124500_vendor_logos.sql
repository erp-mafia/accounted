-- Vendor logos fetched once from the brand's own website and served from
-- our own storage, instead of through a logo service (those either require
-- hotlinking or restrict rehosting).
--
-- One row per vendor domain, never per company: the cron in
-- src/app/api/vendor-logos/cron resolves domains from the vendors companies
-- pay, fetches each domain's icon from the domain itself once, normalises it
-- to a 128 px PNG and stores it in the public `logos` bucket
-- (20260420120000_logos_bucket.sql) under vendor-icons/<sha256>.png. The
-- browser only ever loads the icon from our storage, never from the vendor.
--
-- The storage path is the content hash, never the domain, so the public
-- bucket cannot be probed for "does some customer pay X". This table is the
-- only place domain and file meet, and its domain list is the union of every
-- customer's vendors: RLS is on with no policies, and anon and authenticated
-- hold no grant at all. Only the service role reads or writes it (the cron
-- and src/lib/vendor-logos/read.ts, which hands out public URLs only).
--
-- A global cache, not company data and not räkenskapsinformation: no
-- company_id, no audit trigger, nothing for the archive export.
--
-- pg-test: covered-by tests/pg/vendor-logos.pg.test.ts

CREATE TABLE public.vendor_logos (
  -- The registrable host, lower case ("telia.se", never "www.telia.se").
  domain          text PRIMARY KEY
                    CHECK (char_length(domain) BETWEEN 3 AND 253
                           AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'found', 'missing', 'blocked', 'excluded')),
  storage_path    text CHECK (storage_path ~ '^vendor-icons/[0-9a-f]{64}\.png$'),
  source          text CHECK (source IN ('apple-touch-icon', 'svg-icon', 'icon', 'root-apple-touch-icon')),
  width           integer CHECK (width > 0 AND width <= 8192),
  sha256          text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  fetched_at      timestamptz,
  next_attempt_at timestamptz DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A found row always names its file, and the file is its hash.
  CONSTRAINT vendor_logos_found_has_file CHECK (
    status <> 'found'
    OR (storage_path IS NOT NULL AND sha256 IS NOT NULL AND source IS NOT NULL
        AND storage_path = 'vendor-icons/' || sha256 || '.png')
  )
);

COMMENT ON TABLE public.vendor_logos IS
  'Vendor icons fetched once per domain from the vendor''s own website and stored in the public logos bucket by content hash. Service role only: the domain list is the union of every customer''s vendors.';
COMMENT ON COLUMN public.vendor_logos.status IS
  'pending (not fetched yet), found (icon stored), missing (no usable icon, retried after 30 days), blocked (403, robots.txt or an unsafe address, retried after 90 days), excluded (never fetched: a bank, a mail or invoice platform, Skatteverket).';
COMMENT ON COLUMN public.vendor_logos.attempts IS
  'Consecutive failed attempts that may succeed on retry (timeouts, 5xx). The third moves the row to its 30-day window and resets the count.';
COMMENT ON COLUMN public.vendor_logos.next_attempt_at IS
  'When the cron may fetch the domain again; NULL means never (excluded).';

CREATE INDEX idx_vendor_logos_due ON public.vendor_logos (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

CREATE TRIGGER set_updated_at_vendor_logos
  BEFORE UPDATE ON public.vendor_logos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.vendor_logos ENABLE ROW LEVEL SECURITY;

-- No policies: a browser session never sees which domains exist.
REVOKE ALL ON TABLE public.vendor_logos FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_logos TO service_role;

NOTIFY pgrst, 'reload schema';
