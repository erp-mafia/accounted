-- Per-user preference to hide the floating assistant button (FAB) shown
-- bottom-right on every dashboard page. UI-only: the sidebar assistant entry
-- is unaffected. Default false keeps current behavior for everyone.
alter table public.user_preferences
  add column if not exists hide_assistant_fab boolean not null default false;
