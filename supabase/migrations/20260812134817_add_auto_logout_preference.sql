-- Per-user opt-in automatic logout (founder-approved 2026-08-12): the hosted
-- session timeouts (idle/absolute) only apply to users who enable this.
-- Default false keeps everyone signed in for the full Supabase session
-- lifetime, the behavior from before the 2026-07 session hardening.
alter table public.user_preferences
  add column if not exists auto_logout boolean not null default false;

notify pgrst, 'reload schema';
