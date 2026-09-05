-- A completed login-email change must close every door that was opened by
-- the old address, the social login included.
--
-- GoTrue keys OAuth identities (Google, ...) on the provider's subject, not
-- on the address, so after a secure email change from A to B the Google
-- identity that was auto-linked for A stays on the account: "Logga in med
-- Google" while signed into the A mailbox still opens the company, although
-- the user just told us A is no longer theirs (reproduced on prod
-- 2026-09-03 with a test account: both Google logins kept working after
-- the change). Product decision (Emil, 2026-09-03): a change is a change;
-- only identities bound to the address the user switched FROM go,
-- everything else stays. Google with the NEW address keeps working: GoTrue
-- auto-links it on the first sign-in through the email identity for that
-- address, which this trigger guarantees exists. Password, BankID and
-- social identities on other addresses are untouched, so the account always
-- keeps a way in (at minimum "Glömt lösenord" to the new address).
--
-- A trigger rather than app code so every completion path is covered: the
-- hook-built link, the stock GoTrue link, a click from a phone mail app with
-- no session, and an admin-side change. Sits next to sync_profile_email
-- (20260828191950) on the same event.

create or replace function public.unlink_old_address_identities()
returns trigger as $$
declare
  v_removed     integer;
  v_providers   text[];
  -- GoTrue's ConfirmEmailChange writes email = email_change and clears
  -- email_change in the same UPDATE, so "the pending address became the
  -- address" is the signature of a change the user confirmed from both
  -- mailboxes. Anything else (admin API, SQL) is unconfirmed.
  v_confirmed   boolean := old.email_change is not null
                       and old.email_change <> ''
                       and lower(old.email_change) = lower(new.email);
begin
  -- auth.identities is created by GoTrue at startup, not by the Postgres
  -- image. Where GoTrue has never run (a bare pg-real container, a fresh
  -- self-hosted database before first boot) there is nothing to unlink and
  -- an email change must not fail on a missing table.
  if to_regclass('auth.identities') is null then
    return new;
  end if;

  with removed as (
    delete from auth.identities i
     where i.user_id = new.id
       and i.provider not in ('email', 'phone')
       and lower(i.identity_data->>'email') = lower(old.email)
     returning i.provider
  )
  select count(*), array_agg(provider order by provider)
    into v_removed, v_providers
    from removed;

  if v_removed > 0 then
    -- A Google-only account (signed up with Google, never set a password) has
    -- no 'email' identity at all, so removing its Google identity would leave
    -- zero identities. GoTrue links a later "Sign in with Google" for the NEW
    -- address, and resolves password recovery, through the email identity,
    -- so make sure one exists for the new address. Same shape GoTrue writes
    -- itself (provider_id = user id). email_verified is only claimed for a
    -- change the user confirmed; an admin-side change gets an unverified
    -- identity, exactly as GoTrue would create it. If GoTrue creates or
    -- updates the email identity later in the same change, it finds this row
    -- and updates it.
    insert into auth.identities (id, user_id, provider, provider_id, identity_data, created_at, updated_at)
    select gen_random_uuid(), new.id, 'email', new.id::text,
           jsonb_build_object('sub', new.id::text, 'email', new.email,
                              'email_verified', v_confirmed, 'phone_verified', false),
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

    -- Removing a login method is a security-relevant event; leave the same
    -- trail GoTrue leaves for its own identity_unlink, in its own audit
    -- table, so the account history reads as one sequence.
    if to_regclass('auth.audit_log_entries') is not null then
      insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
      values (
        new.instance_id,
        gen_random_uuid(),
        jsonb_build_object(
          'action', 'identity_unlink',
          'actor_id', new.id,
          'actor_username', old.email,
          'actor_via_sso', false,
          'log_type', 'user',
          'traits', jsonb_build_object(
            'reason', 'email_change',
            'providers', to_jsonb(v_providers),
            'old_email', old.email,
            'new_email', new.email,
            'confirmed', v_confirmed
          )
        )::json,
        now(),
        ''
      );
    end if;
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
