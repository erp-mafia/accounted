-- Server-side "sign this user out everywhere" for the pending-BankID
-- adoption path (BankID instant login, 2026-09-05).
--
-- A BankID signup now signs the holder in before the typed address is
-- proven. If the real owner of that address later proves it through another
-- credential (Google sign-in, password reset), /auth/callback revokes the
-- pending BankID link; from that moment the BankID holder must also lose the
-- sessions they already hold, or the revoke is cosmetic until their refresh
-- token dies. GoTrue's admin API has no per-user sign-out (admin.signOut
-- needs the victim's own JWT), so the sessions are removed here. GoTrue
-- validates the session_id claim of every access token against
-- auth.sessions, so a deleted session invalidates its access token at once;
-- auth.refresh_tokens cascades on session delete.
--
-- p_keep_session_id: the session the address owner just minted in the same
-- request (the callback's own exchange), which must survive.
--
-- service_role only: this is an operator action taken by the auth callback
-- with the service client, never by a browser session.

create or replace function public.revoke_user_sessions(
  p_user_id uuid,
  p_keep_session_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer := 0;
begin
  if p_user_id is null then
    return 0;
  end if;

  -- auth.sessions is created by GoTrue at startup, not by the Postgres
  -- image: a bare pg-real container has nothing to revoke.
  if to_regclass('auth.sessions') is null then
    return 0;
  end if;

  delete from auth.sessions s
   where s.user_id = p_user_id
     and (p_keep_session_id is null or s.id <> p_keep_session_id);
  get diagnostics v_removed = row_count;

  return v_removed;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
