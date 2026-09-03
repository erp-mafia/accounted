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
-- sign-in through the email identity for that address, which this trigger
-- guarantees exists. Password, BankID and social identities on other
-- addresses are untouched, so the account always keeps a way in (at minimum
-- "Glömt lösenord" to the new address).
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
  -- auth.identities is created by GoTrue at startup, not by the Postgres
  -- image. Where GoTrue has never run (a bare pg-real container, a fresh
  -- self-hosted database before first boot) there is nothing to unlink and
  -- an email change must not fail on a missing table.
  if to_regclass('auth.identities') is null then
    return new;
  end if;

  delete from auth.identities i
   where i.user_id = new.id
     and i.provider not in ('email', 'phone')
     and lower(i.identity_data->>'email') = lower(old.email);
  get diagnostics v_removed = row_count;

  if v_removed > 0 then
    -- A Google-only account (signed up with Google, never set a password) has
    -- no 'email' identity at all, so removing its Google identity would leave
    -- zero identities. GoTrue links a later "Sign in with Google" for the NEW
    -- address, and resolves password recovery, through the email identity,
    -- so make sure one exists for the new address. Same shape GoTrue writes
    -- itself (provider_id = user id). If GoTrue creates or updates the email
    -- identity later in the same change, it finds this row and updates it.
    insert into auth.identities (id, user_id, provider, provider_id, identity_data, created_at, updated_at)
    select gen_random_uuid(), new.id, 'email', new.id::text,
           jsonb_build_object('sub', new.id::text, 'email', new.email,
                              'email_verified', true, 'phone_verified', false),
           now(), now()
     where not exists (
       select 1 from auth.identities i where i.user_id = new.id and i.provider = 'email'
     );

    -- GoTrue mirrors the linked providers into app_metadata.providers on
    -- link/unlink; keep that list truthful so nothing offers a login button
    -- for a provider that is no longer linked. Recomputed from what is left
    -- rather than by removing one entry, so it is right whatever was there.
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
