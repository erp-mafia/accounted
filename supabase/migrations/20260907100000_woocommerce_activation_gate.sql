-- WooCommerce activation gate: an ACTIVE connection requires BOTH the
-- store-verified credentials (server-to-server wc-auth callback) AND the
-- initiating user's browser confirmation (the return leg, session-bound).
--
-- Before this, the callback alone flipped a row to active. Between that
-- moment and the initiator's browser reaching the return route the row was
-- syncable: if the person who approved in the store never came back (closed
-- the tab, skipped the sign-in, or was lured into approving a connect someone
-- else started), their store's keys stayed active inside another company's
-- books, and the manual sync button could pull orders within seconds.
--
-- browser_confirmed_at records the session-bound confirmation. The CHECK makes
-- "no sync path can use staged credentials" a database invariant instead of an
-- application promise: staged credentials live on PENDING rows, every consumer
-- selects status = 'active', and active is unreachable without both signals.

alter table public.woocommerce_connections
  add column browser_confirmed_at timestamptz;

comment on column public.woocommerce_connections.browser_confirmed_at is
  'Set when the initiating user''s browser session confirmed the wc-auth handshake (return leg) or when keys were entered manually under a session. Required, together with stored credentials, for status = active.';

-- Active rows without stored credentials cannot sync (credentialsOf() throws)
-- and would violate the invariant below: park them so the panel says why.
update public.woocommerce_connections
   set status = 'error',
       error_message = 'Anslutningen saknar API-nycklar. Anslut butiken igen.',
       oauth_state = null
 where status = 'active'
   and (consumer_key_encrypted is null or consumer_secret_encrypted is null);

-- Rows activated under the old flow completed the handshake in a browser; the
-- return leg just did not record it. Backfill from the activation timestamp.
update public.woocommerce_connections
   set browser_confirmed_at = coalesce(connected_at, created_at)
 where status = 'active'
   and browser_confirmed_at is null;

alter table public.woocommerce_connections
  add constraint woocommerce_connections_active_requires_both_signals
  check (
    status <> 'active'
    or (
      consumer_key_encrypted is not null
      and consumer_secret_encrypted is not null
      and browser_confirmed_at is not null
    )
  );

NOTIFY pgrst, 'reload schema';
