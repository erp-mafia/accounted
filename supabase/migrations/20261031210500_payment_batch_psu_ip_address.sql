-- The IP address of the person who started a payment signing, kept next to
-- the PSU-ID the signing's payments were created with, so the unattended
-- status reads and cancels of those payments can send it again.
--
-- Why: the status sync (lib/payments/orders/sync.ts, the hourly cron) reads
-- every open Open Payments payment with no person present and sent no
-- PSU-IP-Address. Länsförsäkringar answers that read with 400 FORMAT_ERROR
-- "Invalid PSU-IP-Address" and SEB with "PSU-IP-Address is mandatory for
-- payment", so their signed and awaiting payments were never moved forward.
-- Every other bank accepts the read without it. Never a guessed or a server
-- address: only the address the signing request came from, and only when it
-- is a plain IP address (lib/auth/resource-psu.ts signerIpAddress, the same
-- rule Connect's sanitiseIpAddress applies before it sends the header).
--
-- Personal data, kept only while the signing's payments may still be read
-- or cancelled: the status sync clears it once no order of the signing is
-- at the bank any more (every one final, released, or moved to a newer
-- signing). The row itself (the encrypted PSU-ID) is unchanged: it stays
-- service role only, never exported, and goes with the signing, the company
-- and account erasure (erase_user_personal_data, 20261014230000) as before.
--
-- Additive only: one nullable column and its check. inet refuses anything
-- that is not an address; the check refuses a network (a prefix shorter than
-- a single host). A row without an address reads as before (no IP sent).
--
-- pg-test: covered-by tests/pg/payment-batch-psu-ip.pg.test.ts

ALTER TABLE public.payment_batch_psus
  ADD COLUMN psu_ip_address inet;

ALTER TABLE public.payment_batch_psus
  ADD CONSTRAINT payment_batch_psus_ip_is_host
  CHECK (
    psu_ip_address IS NULL
    OR masklen(psu_ip_address) = CASE family(psu_ip_address) WHEN 4 THEN 32 ELSE 128 END
  );

COMMENT ON COLUMN public.payment_batch_psus.psu_ip_address IS
  'The IP address the signing was started from (PSU-IP-Address), sent again on the unattended status reads and cancels of its payments. Cleared by the status sync once no order of the signing is at the bank. Service-role only; never exported.';

NOTIFY pgrst, 'reload schema';
