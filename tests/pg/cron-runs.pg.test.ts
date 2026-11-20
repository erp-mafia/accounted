import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { runInBaseDatabase } from './parallel'
import { getPool, runAsServiceRole, withUserContext } from './setup'

// pg_cron keeps its jobs in one database of the server, so on several workers
// this file runs in that one and not in a copy.
runInBaseDatabase()

/**
 * pg-real coverage for migration 20261112183702_cron_runs.
 *
 * cron_runs is the run ledger of the scheduled jobs (lib/cron/run-ledger.ts,
 * lib/cron/watch.ts). Locks in:
 *   - service role only: RLS on, no policies, no privileges for anon or
 *     authenticated, on the table and on both functions;
 *   - the shape: a row is 'running' exactly while it has no finished_at, and
 *     only the six statuses exist;
 *   - the conditional writes the code relies on: the wrapper's insert under
 *     an id it made itself, its close landing on a row that is running or
 *     was called timed_out and on nothing else, and the watch job's report
 *     claim (alerted_at IS NULL ... RETURNING) returning a row once;
 *   - a failed pg_cron run is copied in once (uq_cron_runs_pg_cron_failure);
 *   - cron_latest_runs(paths): the newest start of each given path, a path
 *     without a row left out;
 *   - failed_pg_cron_runs(): runs of the database's scheduler with status
 *     'failed' since a moment, grouped per job, newest message first.
 */

const PATH = '/api/pg-test/cron-runs/cron'

describe('cron_runs (migration 20261112183702)', () => {
  it('has RLS enabled, no policies, and no privileges for anon or authenticated', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cron_runs'::regclass`)
    expect(rls.rows[0]?.relrowsecurity).toBe(true)

    const policies = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cron_runs'`)
    expect(policies.rows[0]?.n).toBe('0')

    const grants = await getPool().query<{ role: string; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; latest: boolean; pg_cron: boolean }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.cron_runs', 'SELECT') AS can_select,
              has_table_privilege(r.role, 'public.cron_runs', 'INSERT') AS can_insert,
              has_table_privilege(r.role, 'public.cron_runs', 'UPDATE') AS can_update,
              has_table_privilege(r.role, 'public.cron_runs', 'DELETE') AS can_delete,
              has_function_privilege(r.role, 'public.cron_latest_runs(text[])', 'EXECUTE') AS latest,
              has_function_privilege(r.role, 'public.failed_pg_cron_runs(timestamptz)', 'EXECUTE') AS pg_cron
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
       ORDER BY r.role`,
    )
    expect(grants.rows).toEqual([
      { role: 'anon', can_select: false, can_insert: false, can_update: false, can_delete: false, latest: false, pg_cron: false },
      { role: 'authenticated', can_select: false, can_insert: false, can_update: false, can_delete: false, latest: false, pg_cron: false },
      { role: 'service_role', can_select: true, can_insert: true, can_update: true, can_delete: true, latest: true, pg_cron: true },
    ])
  })

  it('lets a signed-in member neither read the ledger nor call its functions', async () => {
    const { userId } = await seedCompany()
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.cron_runs LIMIT 1`))).rejects.toThrow(/permission denied/)
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.cron_latest_runs(ARRAY['/api/x/cron'])`))).rejects.toThrow(/permission denied/)
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.failed_pg_cron_runs(now() - interval '1 day')`))).rejects.toThrow(/permission denied/)
  })

  it('opens a run as running with no finish, and refuses a status the ledger does not know or a finish that disagrees with it', async () => {
    const opened = await runAsServiceRole((client) =>
      client.query<{ status: string; finished_at: string | null; alerted_at: string | null }>(
        `INSERT INTO public.cron_runs (path, operation, limit_ms, request_id) VALUES ($1, 'cron.pg_test', 300000, 'cron_pg') RETURNING status, finished_at, alerted_at`,
        [`${PATH}/shape`],
      ),
    )
    expect(opened.rows).toEqual([{ status: 'running', finished_at: null, alerted_at: null }])

    await expect(getPool().query(`INSERT INTO public.cron_runs (path, operation, status, finished_at) VALUES ($1, 'x', 'skipped', now())`, [PATH])).rejects.toThrow(/cron_runs_status_check/)
    await expect(getPool().query(`INSERT INTO public.cron_runs (path, operation, status) VALUES ($1, 'x', 'expected')`, [PATH])).rejects.toThrow(/cron_runs_running_is_open/)
    await expect(getPool().query(`INSERT INTO public.cron_runs (path, operation, status) VALUES ($1, 'x', 'ok')`, [PATH])).rejects.toThrow(/cron_runs_running_is_open/)
    await expect(getPool().query(`INSERT INTO public.cron_runs (path, operation, status, finished_at) VALUES ($1, 'x', 'running', now())`, [PATH])).rejects.toThrow(/cron_runs_running_is_open/)
    await expect(getPool().query(`INSERT INTO public.cron_runs (path, operation, limit_ms) VALUES ($1, 'x', 0)`, [PATH])).rejects.toThrow(/cron_runs_limit_ms_check/)
  })

  it('opens a row under an id the caller made, and the first-sight row of a scheduled job is a finished row of its own status', async () => {
    const id = '6f1c1e0a-2b0f-4d7e-9d0a-3f5a7c9b1e21'
    await runAsServiceRole((client) => client.query(`INSERT INTO public.cron_runs (id, path, operation, limit_ms, request_id) VALUES ($1, $2, 'cron.pg_test', 60000, 'cron_pg')`, [id, `${PATH}/own-id`]))
    const { rows } = await getPool().query<{ id: string; status: string }>(`SELECT id, status FROM public.cron_runs WHERE path = $1`, [`${PATH}/own-id`])
    expect(rows).toEqual([{ id, status: 'running' }])

    const expected = await runAsServiceRole((client) =>
      client.query<{ status: string }>(`INSERT INTO public.cron_runs (path, operation, status, started_at, finished_at) VALUES ($1, 'cron.watch', 'expected', now(), now()) RETURNING status`, [`${PATH}/expected`]),
    )
    expect(expected.rows).toEqual([{ status: 'expected' }])
  })

  it('closes a run that is running or was called timed out, and nothing else: a run that answers was not killed', async () => {
    const path = `${PATH}/close`
    const { rows } = await runAsServiceRole((client) =>
      client.query<{ id: string }>(
        `INSERT INTO public.cron_runs (path, operation, status, started_at, finished_at) VALUES
           ($1, 'x', 'running', now() - interval '10 minutes', NULL),
           ($1, 'x', 'running', now(), NULL),
           ($1, 'x', 'failed', now() - interval '1 hour', now() - interval '1 hour')
         RETURNING id`,
        [path],
      ),
    )
    const [late, live, closed] = rows.map((row) => row.id)

    // The watch job: still open past its limit. Only while running.
    const called = await runAsServiceRole((client) =>
      client.query(`UPDATE public.cron_runs SET status = 'timed_out', finished_at = now() WHERE id = ANY($1::uuid[]) AND status = 'running' RETURNING id`, [[late, closed]]),
    )
    expect(called.rows).toEqual([{ id: late }])

    // The wrapper's close, as it writes it, for all three.
    const close = `UPDATE public.cron_runs SET status = 'ok', finished_at = now(), duration_ms = 1200, http_status = 200 WHERE id = $1 AND status IN ('running', 'timed_out') RETURNING id`
    expect((await runAsServiceRole((client) => client.query(close, [late]))).rows).toEqual([{ id: late }])
    expect((await runAsServiceRole((client) => client.query(close, [live]))).rows).toEqual([{ id: live }])
    expect((await runAsServiceRole((client) => client.query(close, [closed]))).rows).toEqual([])

    const after = await getPool().query<{ id: string; status: string }>(`SELECT id, status FROM public.cron_runs WHERE path = $1`, [path])
    expect(new Map(after.rows.map((row) => [row.id, row.status]))).toEqual(new Map([[late, 'ok'], [live, 'ok'], [closed, 'failed']]))
  })

  it('takes a failed run of the database scheduler once: a second copy of the same failure is refused', async () => {
    const copy = `INSERT INTO public.cron_runs (path, operation, status, started_at, finished_at, error) VALUES ('pg_cron:pg-test-job', 'pg_cron', 'failed', '2026-11-01T06:00:00Z', '2026-11-01T06:00:00Z', 'x')`
    await runAsServiceRole((client) => client.query(copy))
    await expect(runAsServiceRole((client) => client.query(copy))).rejects.toThrow(/uq_cron_runs_pg_cron_failure/)
    // A job's own runs may share a path and a start time: the key is for the scheduler's rows only.
    const twin = `INSERT INTO public.cron_runs (path, operation, status, started_at, finished_at) VALUES ($1, 'cron.x', 'ok', '2026-11-01T06:00:00Z', '2026-11-01T06:00:01Z')`
    await runAsServiceRole((client) => client.query(twin, [`${PATH}/twin`]))
    await runAsServiceRole((client) => client.query(twin, [`${PATH}/twin`]))
  })

  it('claims a problem for a report once, and again after the claim is released', async () => {
    const { rows } = await runAsServiceRole((client) =>
      client.query<{ id: string }>(`INSERT INTO public.cron_runs (path, operation, status, finished_at, http_status) VALUES ($1, 'x', 'failed', now(), 500) RETURNING id`, [`${PATH}/claim`]),
    )
    const id = rows[0]!.id
    const claim = `UPDATE public.cron_runs SET alerted_at = now() WHERE id = ANY($1::uuid[]) AND alerted_at IS NULL RETURNING id`

    expect((await runAsServiceRole((client) => client.query(claim, [[id]]))).rows).toEqual([{ id }])
    // An overlapping watch run sees the same problem: nothing comes back, nothing is mailed twice.
    expect((await runAsServiceRole((client) => client.query(claim, [[id]]))).rows).toEqual([])
    // A digest that could not be sent releases the claim.
    await runAsServiceRole((client) => client.query(`UPDATE public.cron_runs SET alerted_at = NULL WHERE id = $1`, [id]))
    expect((await runAsServiceRole((client) => client.query(claim, [[id]]))).rows).toEqual([{ id }])
  })
})

describe('cron_latest_runs(paths)', () => {
  it('answers the newest start of each given path and leaves out a path with no row', async () => {
    const a = `${PATH}/latest-a`
    const b = `${PATH}/latest-b`
    const never = `${PATH}/latest-never-ran`
    await runAsServiceRole((client) =>
      client.query(
        `INSERT INTO public.cron_runs (path, operation, status, started_at, finished_at) VALUES
           ($1, 'x', 'ok', '2001-01-01T00:00:00Z', '2001-01-01T00:00:01Z'),
           ($1, 'x', 'ok', now() - interval '2 hours', now()),
           ($1, 'x', 'missed', now() - interval '5 minutes', now()),
           ($2, 'x', 'failed', now() - interval '1 day', now()),
           ($3, 'x', 'ok', now(), now())`,
        [a, b, `${PATH}/latest-not-asked-for`],
      ),
    )

    const { rows } = await runAsServiceRole((client) =>
      client.query<{ path: string; age_minutes: number }>(
        `SELECT path, round(extract(epoch FROM now() - last_started_at) / 60)::int AS age_minutes FROM public.cron_latest_runs($1::text[]) ORDER BY path`,
        [[a, b, never]],
      ),
    )

    expect(rows).toEqual([{ path: a, age_minutes: 5 }, { path: b, age_minutes: 1440 }])
  })
})

describe('failed_pg_cron_runs()', () => {
  it('answers the failed runs of the database scheduler since a moment, per job, with the newest message', async () => {
    const jobname = 'pg-test-cron-runs-failing'
    // The scheduler's own bookkeeping, written directly: a job with two failed runs, one succeeded and one still running.
    await getPool().query(`SELECT cron.schedule($1, '0 0 1 1 *', 'SELECT 1')`, [jobname])
    const job = await getPool().query<{ jobid: string }>(`SELECT jobid::text FROM cron.job WHERE jobname = $1`, [jobname])
    const jobid = job.rows[0]!.jobid
    try {
      // Run ids given here, far above any the scheduler hands out: the test
      // role may write the history table but not draw from cron.runid_seq.
      // The rows carry this database and this role, as the scheduler's own
      // rows do, so pg_cron's row policy (username = current_user) admits them.
      await getPool().query(
        `INSERT INTO cron.job_run_details (jobid, runid, database, username, command, status, return_message, start_time, end_time) VALUES
           ($1, $2::bigint + 1, current_database(), current_user, 'SELECT 1', 'failed', 'ERROR: older', now() - interval '3 hours', now() - interval '3 hours'),
           ($1, $2::bigint + 2, current_database(), current_user, 'SELECT 1', 'failed', 'ERROR: writes to an archived company are refused', now() - interval '1 hour', now() - interval '1 hour'),
           ($1, $2::bigint + 3, current_database(), current_user, 'SELECT 1', 'succeeded', '1 row', now() - interval '30 minutes', now() - interval '30 minutes'),
           ($1, $2::bigint + 4, current_database(), current_user, 'SELECT 1', 'running', NULL, now(), NULL),
           ($1, $2::bigint + 5, current_database(), current_user, 'SELECT 1', 'failed', 'ERROR: last week', now() - interval '8 days', now() - interval '8 days')`,
        [jobid, String(9_000_000_000_000 + Number(jobid) * 10)],
      )

      const { rows } = await runAsServiceRole((client) =>
        client.query<{ jobname: string; failed_runs: string; last_message: string }>(
          `SELECT jobname, failed_runs::text, last_message FROM public.failed_pg_cron_runs(now() - interval '1 day') WHERE jobname = $1`,
          [jobname],
        ),
      )

      expect(rows).toEqual([{ jobname, failed_runs: '2', last_message: 'ERROR: writes to an archived company are refused' }])
      const none = await runAsServiceRole((client) => client.query(`SELECT 1 FROM public.failed_pg_cron_runs(now() - interval '10 minutes') WHERE jobname = $1`, [jobname]))
      expect(none.rows).toEqual([])
    } finally {
      await getPool().query(`DELETE FROM cron.job_run_details WHERE jobid = $1`, [jobid])
      await getPool().query(`SELECT cron.unschedule($1)`, [jobname])
    }
  })
})
