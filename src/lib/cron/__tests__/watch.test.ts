/**
 * The cron watch (../watch.ts) over a ledger held in memory: the table
 * resolver applies the filters each step sends, so every test states what is
 * in cron_runs and reads what the watch made of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const sendEmail = vi.fn()
const isConfigured = vi.fn()
vi.mock('@/lib/email/service', () => ({ getEmailService: async () => ({ isConfigured, sendEmail }) }))
const selfHosted = vi.fn(() => false)
vi.mock('@/lib/env/public-flags', () => ({ isSelfHosted: () => selfHosted() }))

import { SCHEDULED_JOBS } from '../schedule'
import { digestLine, getOpsAlertRecipients, ID_CHUNK, killedAfterMs, QUIET_HOURS, RETENTION_DAYS, scheduleVerdicts, watchCronRuns } from '../watch'

type Row = Record<string, unknown>
type Call = { method: string; args: unknown[] }

const NOW = new Date('2026-11-12T08:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const PAYMENTS = '/api/payments/orders/status/cron'

let rows: Row[]
let latest: Row[] | null
let pgCron: Row[]
/** The longest id list any one request carried. */
let longestIdList: number
let db: ReturnType<typeof createTableMockSupabase>
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

function matching(chain: Call[]): Row[] {
  let out = [...rows]
  for (const { method, args } of chain) {
    const [column, value, third] = args as [string, unknown, unknown]
    if (method === 'eq') out = out.filter((row) => row[column] === value)
    else if (method === 'in') {
      if (column === 'id') longestIdList = Math.max(longestIdList, (value as unknown[]).length)
      out = out.filter((row) => (value as unknown[]).includes(row[column]))
    } else if (method === 'is') out = out.filter((row) => (row[column] ?? null) === value)
    else if (method === 'not' && value === 'is' && third === null) out = out.filter((row) => (row[column] ?? null) !== null)
    else if (method === 'lt') out = out.filter((row) => String(row[column]) < String(value))
    else if (method === 'gte') out = out.filter((row) => String(row[column]) >= String(value))
    else if (method === 'order') {
      const direction = (args[1] as { ascending?: boolean }).ascending === false ? -1 : 1
      out.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * direction)
    } else if (method === 'limit') out = out.slice(0, Number(args[0]))
  }
  return out
}

function ledger(chain: Call[]) {
  const write = chain.find(({ method }) => ['insert', 'update', 'delete'].includes(method))
  if (!write) return { data: matching(chain) }
  if (write.method === 'insert') {
    const row = write.args[0] as Row
    if (row.operation === 'pg_cron' && rows.some((known) => known.path === row.path && known.started_at === row.started_at)) {
      return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_cron_runs_pg_cron_failure"' } }
    }
    rows.push({ id: `new-${rows.length + 1}`, alerted_at: null, ...row })
    return { data: null }
  }
  const hit = matching(chain)
  if (write.method === 'delete') {
    rows = rows.filter((row) => !hit.includes(row))
    return { data: null, count: hit.length }
  }
  for (const row of hit) Object.assign(row, write.args[0] as Row)
  return { data: hit.map((row) => ({ id: row.id })) }
}

function run(id: string, overrides: Row = {}): Row {
  return { id, path: PAYMENTS, operation: 'cron.payment_order_status', status: 'ok', started_at: ago(5 * MINUTE), finished_at: ago(4 * MINUTE), duration_ms: 60_000, limit_ms: 300_000, http_status: 200, error: null, alerted_at: null, ...overrides }
}

async function watch() {
  return watchCronRuns(db.supabase as unknown as SupabaseClient, log, NOW)
}

beforeEach(() => {
  vi.clearAllMocks()
  rows = []
  // Every scheduled job ran a minute ago unless a test says otherwise.
  latest = SCHEDULED_JOBS.map((job) => ({ path: job.path, last_started_at: ago(MINUTE) }))
  pgCron = []
  longestIdList = 0
  selfHosted.mockReturnValue(false)
  isConfigured.mockReturnValue(true)
  sendEmail.mockResolvedValue({ success: true })
  vi.stubEnv('OPS_ALERT_RECIPIENTS', 'ops@example.test')
  db = createTableMockSupabase({
    cron_runs: ledger,
    'rpc:cron_latest_runs': () => ({ data: latest }),
    'rpc:failed_pg_cron_runs': () => ({ data: pgCron }),
  })
})
afterEach(() => vi.unstubAllEnvs())

describe('watchCronRuns: a run the platform killed', () => {
  it('closes a run still open a minute past its limit as timed out, and reports it', async () => {
    // Production, 2026-11-10 04:30: killed at 300 s, and nothing anywhere said so.
    rows.push(run('killed', { status: 'running', started_at: ago(7 * MINUTE), finished_at: null, duration_ms: null, http_status: null }))

    const result = await watch()

    expect(result).toMatchObject({ timedOut: 1, reportedJobs: 1, reportedRuns: 1, mailed: true, errors: 0 })
    expect(rows[0]).toMatchObject({ status: 'timed_out', finished_at: NOW.toISOString(), alerted_at: NOW.toISOString() })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const mail = sendEmail.mock.calls[0]![0] as { subject: string; text: string; to: string[] }
    expect(mail.to).toEqual(['ops@example.test'])
    expect(mail.subject).toContain('1 jobb har problem')
    expect(mail.text).toContain(`${PAYMENTS} | 1 körning avbröts vid tidsgränsen (300 s)`)
    expect(log.error).toHaveBeenCalledWith('scheduled job failing', expect.objectContaining({ alert: true, path: PAYMENTS, statuses: ['timed_out'] }))
  })

  it('leaves a run inside its limit, and one just past it, open', async () => {
    rows.push(
      run('young', { status: 'running', started_at: ago(4 * MINUTE), finished_at: null }),
      run('grace', { status: 'running', started_at: ago(5 * MINUTE + 30_000), finished_at: null }),
      run('long', { status: 'running', started_at: ago(12 * MINUTE), finished_at: null, limit_ms: 800_000 }),
    )

    expect(await watch()).toMatchObject({ timedOut: 0, reportedJobs: 0 })
    expect(rows.map((row) => row.status)).toEqual(['running', 'running', 'running'])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('gives a row without a limit the longest limit in the app before calling it killed', async () => {
    rows.push(run('a', { status: 'running', started_at: ago(14 * MINUTE), finished_at: null, limit_ms: null }), run('b', { status: 'running', started_at: ago(17 * MINUTE), finished_at: null, limit_ms: null }))

    expect(await watch()).toMatchObject({ timedOut: 1 })
    expect(rows.map((row) => row.status)).toEqual(['running', 'timed_out'])
  })

  it('closes many killed runs a hundred ids at a time: the ids travel in the query string', async () => {
    for (let i = 0; i < 150; i++) rows.push(run(`k${i}`, { status: 'running', started_at: ago(10 * MINUTE + i * 1000), finished_at: null }))

    expect(await watch()).toMatchObject({ timedOut: 150 })
    expect(rows.every((row) => row.status === 'timed_out')).toBe(true)
    expect(longestIdList).toBe(ID_CHUNK)
  })

  it('on a self-hosted server, where nothing kills a run at its limit, waits six hours before calling a run dead', async () => {
    selfHosted.mockReturnValue(true)
    rows.push(run('slow', { status: 'running', started_at: ago(40 * MINUTE), finished_at: null }), run('dead', { status: 'running', started_at: ago(7 * HOUR), finished_at: null }))

    expect(await watch()).toMatchObject({ timedOut: 1 })
    expect(rows.map((row) => row.status)).toEqual(['running', 'timed_out'])
    expect(killedAfterMs(300_000, true)).toBe(6 * HOUR)
    expect(killedAfterMs(300_000, false)).toBe(301_000 + 59_000)
  })
})

describe('watchCronRuns: a job that failed', () => {
  it('reports each failing job once, with its count, span, status and newest error', async () => {
    rows.push(
      run('f1', { status: 'failed', started_at: ago(50 * MINUTE), http_status: 500, error: 'Error: register_repair_progress write failed' }),
      run('f2', { status: 'failed', started_at: ago(20 * MINUTE), http_status: 503, error: 'Error: canceling statement due to statement timeout' }),
      run('ok', {}),
    )

    const result = await watch()

    expect(result).toMatchObject({ reportedJobs: 1, reportedRuns: 2, mailed: true })
    const mail = sendEmail.mock.calls[0]![0] as { text: string }
    expect(mail.text).toContain('2 körningar misslyckades | 2026-11-12 07:10 till 2026-11-12 07:40 UTC | HTTP 503 | Error: canceling statement due to statement timeout')
    expect(rows.filter((row) => row.alerted_at).map((row) => row.id)).toEqual(['f1', 'f2'])

    sendEmail.mockClear()
    expect(await watch()).toMatchObject({ reportedJobs: 0, reportedRuns: 0, mailed: false })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('does not mail again about a job reported within the quiet window: its new failures are stamped as covered by that report and leave the queue', async () => {
    const reportedAt = ago(3 * HOUR)
    rows.push(run('old', { status: 'failed', started_at: ago(3 * HOUR), alerted_at: reportedAt }), run('new', { status: 'failed', started_at: ago(10 * MINUTE) }))

    expect(await watch()).toMatchObject({ reportedJobs: 0, quietJobs: 1, mailed: false })
    // Stamped with the time of the report, not of this pass: the window is not moved.
    expect(rows[1].alerted_at).toBe(reportedAt)
    expect(sendEmail).not.toHaveBeenCalled()

    // Nothing is left in the queue for the next pass.
    expect(await watch()).toMatchObject({ quietJobs: 0, reportedJobs: 0 })
  })

  it('reports a new kind of problem at once: a killed run after a reported failure is not hidden by the quiet window', async () => {
    rows.push(
      run('old', { status: 'failed', started_at: ago(2 * HOUR), alerted_at: ago(2 * HOUR) }),
      run('again', { status: 'failed', started_at: ago(30 * MINUTE) }),
      run('killed', { status: 'running', started_at: ago(10 * MINUTE), finished_at: null }),
    )

    const result = await watch()

    expect(result).toMatchObject({ timedOut: 1, reportedJobs: 1, reportedRuns: 1, quietJobs: 1, mailed: true })
    const mail = sendEmail.mock.calls[0]![0] as { text: string }
    expect(mail.text).toContain(`${PAYMENTS} | 1 körning avbröts vid tidsgränsen`)
    expect(mail.text).not.toContain('misslyckades')
    // The repeated failure is covered by its earlier report.
    expect(rows.find((row) => row.id === 'again')?.alerted_at).toBe(ago(2 * HOUR))
  })

  it('reports a job again at its first failure after the quiet window', async () => {
    rows.push(run('old', { status: 'failed', started_at: ago(7 * HOUR), alerted_at: ago(QUIET_HOURS * HOUR + MINUTE) }), run('new', { status: 'failed', started_at: ago(10 * MINUTE) }))

    expect(await watch()).toMatchObject({ reportedJobs: 1, reportedRuns: 1, quietJobs: 0, mailed: true })
  })

  it('reads another job\'s first failure however many failures a quiet job piles up, and sends ids a hundred at a time', async () => {
    // Two minute-jobs failing through a quiet window are 720 rows: more than one read, and ids travel in the query string.
    const noisy = '/api/webhooks/dispatch/cron'
    rows.push(run('reported', { path: noisy, status: 'failed', started_at: ago(5 * HOUR), alerted_at: ago(5 * HOUR) }))
    for (let i = 0; i < 620; i++) rows.push(run(`n${i}`, { path: noisy, status: 'failed', started_at: ago(4 * HOUR - i * 1000) }))
    rows.push(run('first', { status: 'failed', started_at: ago(5 * MINUTE), error: 'Error: new' }))

    // The first pass drains the quiet job's oldest 500 without a mail.
    expect(await watch()).toMatchObject({ quietJobs: 1, reportedJobs: 0, mailed: false })
    // The second reaches the other job's failure and mails it.
    const second = await watch()
    expect(second).toMatchObject({ reportedJobs: 1, reportedRuns: 1, mailed: true })
    expect((sendEmail.mock.calls[0]![0] as { text: string }).text).toContain(`${PAYMENTS} | 1 körning misslyckades`)
    expect(rows.filter((row) => row.alerted_at === null)).toEqual([])
    expect(longestIdList).toBe(ID_CHUNK)
  })

  it('releases its claims when the digest could not be sent, so the next run reports the lot', async () => {
    rows.push(run('f1', { status: 'failed' }))
    sendEmail.mockResolvedValueOnce({ success: false, error: 'rate limited' })

    expect(await watch()).toMatchObject({ reportedJobs: 0, reportedRuns: 0, mailed: false, errors: 1 })
    expect(rows[0].alerted_at).toBeNull()
    expect(log.error).toHaveBeenCalledWith('cron watch digest could not be sent', { alert: true, reason: 'rate limited' })

    expect(await watch()).toMatchObject({ reportedJobs: 1, mailed: true })
  })

  it('says so when a failed digest\'s claims could not be released either: those problems were logged, not mailed', async () => {
    rows.push(run('f1', { status: 'failed' }))
    sendEmail.mockRejectedValueOnce(new Error('smtp down'))
    db.setTable('cron_runs', (chain) =>
      chain.some(({ method, args }) => method === 'update' && (args[0] as Row).alerted_at === null) ? { data: null, error: { message: 'connection reset' } } : ledger(chain),
    )

    const result = await watch()

    expect(result).toMatchObject({ mailed: false, errors: 1, reportedJobs: 1 })
    expect(log.error).toHaveBeenCalledWith('cron watch claims could not be released', { alert: true, reason: 'connection reset' })
    expect(log.error).toHaveBeenCalledWith('scheduled job failing', expect.objectContaining({ path: PAYMENTS }))
  })

  it('gives back what a claim took when it fails half way: stamped rows nobody mails would also quiet their job for hours', async () => {
    for (let i = 0; i < 150; i++) rows.push(run(`f${i}`, { status: 'failed', started_at: ago(50 * MINUTE - i * 1000) }))
    let claims = 0
    db.setTable('cron_runs', (chain) => {
      const update = chain.find(({ method }) => method === 'update')
      if (update && (update.args[0] as Row).alerted_at === NOW.toISOString() && ++claims === 2) return { data: null, error: { message: 'canceling statement due to statement timeout' } }
      return ledger(chain)
    })

    const result = await watch()

    expect(result).toMatchObject({ reportedJobs: 0, mailed: false, errors: 1 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(rows.filter((row) => row.alerted_at !== null)).toEqual([])
    expect(log.error).toHaveBeenCalledWith('cron watch: reporting failed', { alert: true, reason: 'canceling statement due to statement timeout' })

    // The next pass reports the lot.
    db.setTable('cron_runs', ledger)
    expect(await watch()).toMatchObject({ reportedJobs: 1, reportedRuns: 150, mailed: true })
  })

  it('gives the claims back when the e-mail service cannot be reached, a hundred ids at a time', async () => {
    for (let i = 0; i < 120; i++) rows.push(run(`f${i}`, { status: 'failed', started_at: ago(50 * MINUTE - i * 1000) }))
    isConfigured.mockImplementationOnce(() => {
      throw new Error('init failed: email extension did not load')
    })

    const result = await watch()

    expect(result).toMatchObject({ reportedJobs: 0, mailed: false, errors: 1 })
    expect(rows.filter((row) => row.alerted_at !== null)).toEqual([])
    expect(longestIdList).toBe(ID_CHUNK)
    expect(log.error).toHaveBeenCalledWith('cron watch digest could not be sent', { alert: true, reason: 'init failed: email extension did not load' })
  })

  it('reports through the error log alone when no e-mail service is configured, and keeps the claim', async () => {
    rows.push(run('f1', { status: 'failed' }))
    isConfigured.mockReturnValue(false)

    expect(await watch()).toMatchObject({ reportedJobs: 1, mailed: false, errors: 0 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(rows[0].alerted_at).toBe(NOW.toISOString())
    expect(log.error).toHaveBeenCalledWith('scheduled job failing', expect.objectContaining({ path: PAYMENTS }))
  })

  it('does not mail about a problem older than a week', async () => {
    rows.push(run('stale', { status: 'failed', started_at: ago(8 * DAY) }))

    expect(await watch()).toMatchObject({ reportedJobs: 0, mailed: false })
  })
})

describe('watchCronRuns: a job the schedule did not call', () => {
  const jobs = [
    { path: '/api/a/cron', schedule: '* * * * *', maxDurationSeconds: 60 },
    { path: '/api/b/cron', schedule: '0 6 * * *', maxDurationSeconds: 300 },
    { path: '/api/c/cron', schedule: '0 6 1 * *', maxDurationSeconds: 300 },
  ]
  const paths = (list: Array<{ path: string }>) => list.map((job) => job.path)

  it('calls a job missed once its newest row is older than its period and grace', () => {
    const at = NOW.getTime()
    const last = new Map([['/api/a/cron', at - 17 * MINUTE], ['/api/b/cron', at - 26 * HOUR], ['/api/c/cron', at - 20 * DAY]])
    expect(paths(scheduleVerdicts(jobs, last, at).missed)).toEqual(['/api/a/cron'])
    last.set('/api/a/cron', at - 15 * MINUTE)
    last.set('/api/b/cron', at - 28 * HOUR)
    expect(paths(scheduleVerdicts(jobs, last, at).missed)).toEqual(['/api/b/cron'])
  })

  it('never calls a job missed that has no row yet: it is new, and only expected from now', () => {
    const verdicts = scheduleVerdicts(jobs, new Map([['/api/a/cron', NOW.getTime() - MINUTE]]), NOW.getTime())
    expect(paths(verdicts.expected)).toEqual(['/api/b/cron', '/api/c/cron'])
    expect(verdicts.missed).toEqual([])
  })

  it('on the first pass after the ledger is created writes one expected row per scheduled job and mails nobody', async () => {
    latest = []

    const result = await watch()

    expect(result).toMatchObject({ expected: SCHEDULED_JOBS.length, missed: 0, reportedJobs: 0, mailed: false, errors: 0 })
    expect(rows).toHaveLength(SCHEDULED_JOBS.length)
    expect(rows.every((row) => row.status === 'expected' && row.finished_at === NOW.toISOString() && row.operation === 'cron.watch')).toBe(true)
    expect(db.findCall('rpc:cron_latest_runs', 'rpc')).toEqual([{ p_paths: SCHEDULED_JOBS.map((job) => job.path) }])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('records a missed row for a job that stayed away, reports it, and does not record another on the next pass', async () => {
    latest = latest!.map((row) => (row.path === PAYMENTS ? { ...row, last_started_at: ago(HOUR) } : row))

    const result = await watch()

    expect(result).toMatchObject({ missed: 1, expected: 0, reportedJobs: 1, mailed: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: PAYMENTS, status: 'missed', operation: 'cron.watch', limit_ms: 300_000 })
    expect((sendEmail.mock.calls[0]![0] as { text: string }).text).toContain(`${PAYMENTS} | ingen körning inom schemat`)

    // The next pass counts from the missed row, which is the job's newest.
    latest = latest!.map((row) => (row.path === PAYMENTS ? { ...row, last_started_at: NOW.toISOString() } : row))
    expect(await watch()).toMatchObject({ missed: 0 })
    expect(rows).toHaveLength(1)
  })
})

describe('watchCronRuns: the database scheduler', () => {
  it('copies a failed pg_cron run into the ledger once, and reports it', async () => {
    // update-overdue-supplier-invoices failed on every run from 2026-08-29 to 2026-09-24 and nobody was told.
    pgCron = [{ jobname: 'update-overdue-supplier-invoices', failed_runs: 1, last_failed_at: ago(2 * HOUR), last_message: 'ERROR: writes to an archived company are refused' }]

    expect(await watch()).toMatchObject({ pgCronFailed: 1, reportedJobs: 1, mailed: true })
    expect(rows[0]).toMatchObject({ path: 'pg_cron:update-overdue-supplier-invoices', status: 'failed', operation: 'pg_cron' })
    expect(rows[0].error).toContain('1 failed in 24 h. ERROR: writes to an archived company are refused')

    expect(await watch()).toMatchObject({ pgCronFailed: 0, reportedJobs: 0 })
    expect(rows).toHaveLength(1)
  })

  it('redacts the scheduler\'s message, which may quote a row, and takes a copy another pass made first as done', async () => {
    const failedAt = ago(2 * HOUR)
    pgCron = [{ jobname: 'redact-expired-invoice-delivery-pii', failed_runs: 2, last_failed_at: failedAt, last_message: 'ERROR: Failing row contains (19800101-9879, ...)' }]
    // The other pass's copy lands between this pass's read and its insert: the read sees nothing, the insert is refused.
    db.setTable('cron_runs', (chain) => {
      const reads = !chain.some(({ method }) => ['insert', 'update', 'delete'].includes(method))
      const isKnownCheck = reads && chain.some(({ method, args }) => method === 'eq' && args[0] === 'path' && String(args[1]).startsWith('pg_cron:'))
      if (isKnownCheck && rows.length === 0) {
        rows.push({ id: 'theirs', path: 'pg_cron:redact-expired-invoice-delivery-pii', operation: 'pg_cron', status: 'failed', started_at: failedAt, finished_at: failedAt, alerted_at: NOW.toISOString(), error: 'copied by the other pass' })
        return { data: [] }
      }
      return ledger(chain)
    })

    const result = await watch()

    expect(result).toMatchObject({ pgCronFailed: 0, errors: 0 })
    expect(rows).toHaveLength(1)

    rows = []
    db.setTable('cron_runs', ledger)
    await watch()
    expect(String(rows[0].error)).not.toContain('9879')
  })
})

describe('watchCronRuns: housekeeping and its own failures', () => {
  it('deletes rows past the retention and keeps the rest', async () => {
    rows.push(run('old', { started_at: ago((RETENTION_DAYS + 1) * DAY) }), run('kept', { started_at: ago((RETENTION_DAYS - 1) * DAY) }))

    expect(await watch()).toMatchObject({ pruned: 1 })
    expect(rows.map((row) => row.id)).toEqual(['kept'])
  })

  it('goes on past a step that cannot run: a broken scheduler read never stops a killed run from being reported', async () => {
    rows.push(run('killed', { status: 'running', started_at: ago(10 * MINUTE), finished_at: null }))
    db.setTable('rpc:failed_pg_cron_runs', { data: null, error: { message: 'permission denied for schema cron' } })
    db.setTable('rpc:cron_latest_runs', { data: null, error: { message: 'function does not exist' } })

    const result = await watch()

    expect(result).toMatchObject({ timedOut: 1, reportedJobs: 1, mailed: true, errors: 2 })
    expect(log.error).toHaveBeenCalledWith('cron watch: reading the database scheduler failed', { alert: true, reason: 'permission denied for schema cron' })
    expect(log.error).toHaveBeenCalledWith('cron watch: reading the schedule failed', { alert: true, reason: 'function does not exist' })
  })
})

describe('watchCronRuns: before its migration has run', () => {
  it('does nothing and raises nothing while the ledger table is missing', async () => {
    db.setTable('cron_runs', { data: null, error: { code: '42P01', message: 'relation "public.cron_runs" does not exist' } })

    expect(await watch()).toMatchObject({ ledgerMissing: true, errors: 0, mailed: false })
    expect(log.error).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(db.tables()).toEqual(['cron_runs'])
  })
})

describe('who is told', () => {
  it('prefers OPS_ALERT_RECIPIENTS, then the Peppol digest recipients, then the operator\'s own support address', () => {
    vi.stubEnv('OPS_ALERT_RECIPIENTS', '')
    vi.stubEnv('PEPPOL_ALERT_RECIPIENTS', '')
    vi.stubEnv('SUPPORT_RECIPIENT_EMAIL', 'support@example.test')
    expect(getOpsAlertRecipients()).toEqual(['support@example.test'])
    vi.stubEnv('PEPPOL_ALERT_RECIPIENTS', 'a@example.test, b@example.test')
    expect(getOpsAlertRecipients()).toEqual(['a@example.test', 'b@example.test'])
    vi.stubEnv('OPS_ALERT_RECIPIENTS', 'ops@example.test,not-an-address')
    expect(getOpsAlertRecipients()).toEqual(['ops@example.test'])
  })

  it('mails nobody when no address is set: never the brand\'s default support address, which on a self-hosted install is the vendor', async () => {
    vi.stubEnv('OPS_ALERT_RECIPIENTS', '')
    vi.stubEnv('PEPPOL_ALERT_RECIPIENTS', '')
    vi.stubEnv('SUPPORT_RECIPIENT_EMAIL', '')
    rows.push(run('f1', { status: 'failed' }))

    expect(getOpsAlertRecipients()).toEqual([])
    expect(await watch()).toMatchObject({ reportedJobs: 1, mailed: false, errors: 0 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith('scheduled job failing', expect.objectContaining({ path: PAYMENTS }))
  })
})

describe('digestLine', () => {
  it('names every kind of problem a job had', () => {
    const line = digestLine({
      path: PAYMENTS,
      rows: [
        { id: '1', path: PAYMENTS, operation: 'x', status: 'timed_out', started_at: '2026-11-10T04:30:32Z', duration_ms: null, limit_ms: 300_000, http_status: null, error: 'No finish was recorded: the platform killed the run at its time limit.' },
        { id: '2', path: PAYMENTS, operation: 'x', status: 'failed', started_at: '2026-11-10T04:45:32Z', duration_ms: 900, limit_ms: 300_000, http_status: 500, error: null },
        { id: '3', path: PAYMENTS, operation: 'x', status: 'missed', started_at: '2026-11-10T05:30:00Z', duration_ms: null, limit_ms: 300_000, http_status: null, error: null },
      ],
    })
    expect(line).toBe(`${PAYMENTS} | 1 körning avbröts vid tidsgränsen (300 s), 1 körning misslyckades, ingen körning inom schemat | 2026-11-10 04:30 till 2026-11-10 05:30 UTC | HTTP 500 | No finish was recorded: the platform killed the run at its time limit.`)
  })
})
