-- Keep public.profiles.email in step with auth.users.email.
--
-- profiles.email is written once by handle_new_user (20240101000001) and was
-- never updated again; with self-service email change (PR #2017) the login
-- address can now legitimately change, and everything that reads
-- profiles.email (member lists, notification recipients in
-- lib/notifications/member-email.ts, AGI/KU contact fields, invite dedup)
-- would keep pointing at the dead address forever. Mirror the change with a
-- trigger so every path (self-service, admin API, SQL) stays in sync.

create or replace function public.sync_profile_email()
returns trigger as $$
begin
  update public.profiles
     set email = new.email
   where id = new.id
     and email is distinct from new.email;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.sync_profile_email();

-- Backfill rows that already diverged (e.g. admin-side email changes made
-- before this trigger existed).
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;
