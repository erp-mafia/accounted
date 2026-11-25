-- A bank consent can be renewed by another member than the one who first
-- connected the bank.
--
-- What happened. An in-place renewal reuses the bank_connections row, and the
-- row's user_id (whose consent the row holds) doubled as "who started this
-- login": the callback bound the returning browser to it, and
-- read_bank_callback_configuration and finalize_bank_callback refused any
-- other actor. A second member who renewed a colleague's connection signed at
-- the bank and was then refused, and the connection stayed dead until the
-- first member renewed it.
--
-- What changes.
--   1. bank_connections.oauth_user_id names who started the pending login.
--      It is attempt state like oauth_state: written with it, read only next
--      to it, cleared when the login completes. A value an abandoned login
--      leaves behind is overwritten by the next login on the row.
--   2. Both functions accept the starter. The holder (user_id) is accepted as
--      before, so a login staged without a starter completes as it did: a row
--      in flight when this lands, or an app version that does not write the
--      column. Anyone else is refused, and so is a starter who is no longer a
--      member with write access.
--   3. finalize_bank_callback moves the row to the actor in the statement
--      that stores the new consent. user_id says whose consent the row holds,
--      and session reuse across one person's companies reads it, so it may
--      only change together with the consent: moved when the login starts, an
--      abandoned login would leave one person's consent under another's name.
--
-- The foreign key never cascades in the hosted service (account deletion
-- keeps auth.users as a tombstone); tests/pg/account-erasure.pg.test.ts
-- classifies the column.
--
-- read_bank_callback_configuration below is the definition of
-- 20260922075430_finalize_bank_callback_atomically.sql with the actor check
-- changed. finalize_bank_callback is the definition of
-- 20261110120000_bank_renewal_releases_dropped_account.sql with the actor
-- check and the final UPDATE of bank_connections changed.
--
-- pg-test: tests/pg/bank-callback-renewal-by-another-member.pg.test.ts

ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS oauth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bank_connections.oauth_user_id IS
  'Who started the pending bank login (the one oauth_state belongs to). The callback binds the returning browser to this user, and finalize_bank_callback moves user_id to them with the new consent. Read only together with oauth_state: a value left by a login that never completed is overwritten by the next one. NULL when the login was staged without a starter.';

NOTIFY pgrst, 'reload schema';
