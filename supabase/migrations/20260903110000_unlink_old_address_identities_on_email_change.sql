-- A completed login-email change must close every door that was opened by
-- the old address, the social login included.
--
-- GoTrue keys OAuth identities (Google, ...) on the provider's subject, not
-- on the address, so after a secure email change from A to B the Google
-- identity that was auto-linked for A stays on the account: "Logga in med
-- Google" while signed into the A mailbox still opens the company, although
-- the user just told us A is no longer theirs (observed on prod 2026-09-03:
-- willemduplessis999 -> levandefisken kept both Google logins). Product
-- decision (Emil, 2026-09-03): a change is a change; only identities bound
-- to the address the user switched FROM go, everything else stays. Google
-- with the NEW address keeps working: GoTrue auto-links it on the first
-- sign-in because the addresses match. Password, magic link (email
-- identity) and BankID are untouched, so the account always keeps a way in.
--
-- A trigger rather than app code so every completion path is covered: the
-- hook-built link, the stock GoTrue link, a click from a phone mail app with
-- no session, and an admin-side change. Sits next to sync_profile_email
-- (20260828191950) on the same event.

create or replace function public.unlink_old_address_identities()
returns trigger as $$
declare
  v_removed integer;
begin
  delete from auth.identities i
   where i.user_id = new.id
     and i.provider not in ('email', 'phone')
     and lower(i.identity_data->>'email') = lower(old.email);
  get diagnostics v_removed = row_count;

  -- GoTrue mirrors the linked providers into app_metadata.providers on
  -- link/unlink; keep that list truthful so nothing offers a login button
  -- for a provider that is no longer linked. Recomputed from what is left
  -- rather than by removing one entry, so it is right whatever was there.
  if v_removed > 0 then
    new.raw_app_meta_data := jsonb_set(
      coalesce(new.raw_app_meta_data, '{}'::jsonb),
      '{providers}',
      coalesce(
        (select jsonb_agg(distinct i.provider order by i.provider)
           from auth.identities i
          where i.user_id = new.id),
        '[]'::jsonb
      )
    );
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- BEFORE so the providers list lands in the same row write; the identity
-- delete does not depend on the users row having been updated yet.
drop trigger if exists on_auth_user_email_updated_unlink_old_identities on auth.users;
create trigger on_auth_user_email_updated_unlink_old_identities
  before update of email on auth.users
  for each row
  when (old.email is not null and new.email is distinct from old.email)
  execute function public.unlink_old_address_identities();

revoke all on function public.unlink_old_address_identities() from public, anon, authenticated;
