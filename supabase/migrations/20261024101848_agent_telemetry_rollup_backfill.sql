-- Backfill agent_telemetry_daily and agent_tool_transitions_daily from every
-- whole day of agent telemetry still in event_log, before the 180-day purge
-- reaches the first logged day (2026-05-06, purged from 2026-11-02).
--
-- Its own file so the tables and the RPC stay in place if this one fails: the
-- events cleanup cron then rolls the missing days a few per night, oldest
-- first. 181 days is the cron's 180-day retention plus the day the last purge
-- may have cut into. On prod this reads about a million rows (~1-2 minutes);
-- on a fresh database it reads none.
SELECT public.rollup_agent_telemetry(now() - interval '181 days', 400);
