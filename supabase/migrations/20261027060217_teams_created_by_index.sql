-- teams.created_by: the index the team RLS helper has been scanning without.
--
-- user_team_ids() (20260331010000_teams_table_refactor.sql) backs the SELECT
-- policies on team_members, teams, brands, capability_grants, team_invitations,
-- brand_signup_allowlist and booking_template_library. Its first branch,
--   SELECT id FROM public.teams WHERE created_by = auth.uid()
-- has no index to use, so every call is a sequential scan of teams that
-- evaluates auth.uid() (a jsonb parse of the request claims) once per row:
-- measured on production at about 3.5 ms per call over ~2,600 rows, growing
-- with every signup (one personal team each). Its second branch, on
-- team_members.user_id, is an index scan at 0.02 ms because there the same
-- auth.uid() expression becomes an index condition, evaluated once.
--
-- A team_members query with its teams embed pays the helper twice, a
-- team_members + teams + brands embed three times: pg_stat_statements shows
-- those two shapes at a mean of 39-40 ms as an authenticated user against
-- 0.0 ms for the identical shape under the service role, where RLS does not
-- apply. The Supabase performance advisor lists the same gap as an unindexed
-- foreign key (teams_created_by_fkey).
--
-- An index only: the helper, its policies and every result stay exactly as
-- they are, so no pg-real test is needed.
-- pg-test: skip (index only: no trigger, function, policy or constraint changes)

-- teams is read on every team-scoped RLS check: fail the migration job
-- rather than queue those reads behind a long lock. The table is small
-- (~2,600 rows), so the build itself takes milliseconds.
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_teams_created_by
  ON public.teams (created_by);
