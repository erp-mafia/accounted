-- BankID signup: the e-mail address must be proven before the identity counts.
--
-- Security audit 2026-09: in signup mode the BankID /complete route created
-- an email-confirmed, MFA-exempt (app_metadata.bankid_linked) account for
-- whatever address the caller typed, without ever mailing that address. The
-- real owner of the address could later adopt the account (forgot-password,
-- Google login) while the BankID holder kept a permanent login into it
-- (account pre-hijacking).
--
-- email_verified_at records when the address on the linked auth user was
-- confirmed through the confirmation mail the BankID signup now sends. NULL
-- means the identity is PENDING: BankID login is refused and the account is
-- not MFA-exempt until the link in that mail is clicked (app/(auth)/auth/
-- callback promotes it). A pending row attached to an account that has since
-- been adopted through another credential is deleted, never promoted.
--
-- No column default on purpose (fail closed): every insert path must say
-- whether the address is proven. The authenticated /bankid/link route writes
-- now(); the BankID signup writes NULL. Existing rows predate this change and
-- were adopted through the old flow, so they are grandfathered as verified at
-- their creation time.

ALTER TABLE public.bankid_identities
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz NULL;

UPDATE public.bankid_identities
SET email_verified_at = created_at
WHERE email_verified_at IS NULL;

COMMENT ON COLUMN public.bankid_identities.email_verified_at IS
  'When the linked auth user''s e-mail address was proven for this BankID identity. NULL = pending: BankID login refused, no MFA exemption, until the signup confirmation mail is clicked. Rows created before 2026-09-02 are backfilled with created_at.';

NOTIFY pgrst, 'reload schema';
