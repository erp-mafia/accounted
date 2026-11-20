-- READ ONLY. Every scheduled job over the last 30 days, from the run ledger
-- (cron_runs, migration 20261112183702): runs, failures, runs the platform
-- killed at the time limit, schedules that were not called, and the longest
-- finished run against the job's limit. Worst first.
--
-- A run killed at its limit has no duration (it never finished), so it is
-- counted in `killed` and shown as the limit in `longest_s`. `pct_of_limit`
-- at 50 or above is a job to bound before it is killed. Rows named
-- pg_cron:<job> are failed runs of the database's own scheduler.
--
-- The ledger keeps 45 days and began on the day migration 20261112183702
-- was applied: before that, the same numbers come from the platform's
-- request metrics (function invocations by route), which keep 30 days.
select
  path,
  count(*) filter (where status not in ('missed', 'expected'))       as runs,
  count(*) filter (where status = 'failed')                          as failed,
  count(*) filter (where status = 'timed_out')                       as killed,
  count(*) filter (where status = 'missed')                          as missed,
  count(*) filter (where status = 'running')                         as running_now,
  -- percentile_cont answers double precision, and round(x, 1) takes numeric.
  round((percentile_cont(0.5) within group (order by duration_ms) filter (where duration_ms is not null))::numeric / 1000, 1) as median_s,
  round(greatest(
    coalesce(max(duration_ms), 0),
    coalesce(max(limit_ms) filter (where status = 'timed_out'), 0)
  ) / 1000.0, 1)                                                      as longest_s,
  round(max(limit_ms) / 1000.0)                                       as limit_s,
  round(100.0 * greatest(
    coalesce(max(duration_ms), 0),
    coalesce(max(limit_ms) filter (where status = 'timed_out'), 0)
  ) / nullif(max(limit_ms), 0))                                       as pct_of_limit,
  max(started_at) filter (where status in ('failed', 'timed_out', 'missed')) as last_problem_at,
  (array_agg(error order by started_at desc) filter (where error is not null))[1] as last_error
from cron_runs
where started_at > now() - interval '30 days'
group by path
order by killed desc, pct_of_limit desc nulls last, failed desc, path;
