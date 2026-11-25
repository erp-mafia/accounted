/**
 * The nightly top-up from Fortnox (lib/fortnox-topup.ts): which companies a
 * night runs, that each year goes through the append as the member who
 * turned it on, and what the connection is told: vouchers added, nothing
 * new, a night tried again, or why it stopped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtensionSettings } from '@/lib/extensions/types'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/company/company-access', () => ({ readLiveMembership: vi.fn() }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/import/sie-append', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/sie-append')>()),
  appendableSIEYears: vi.fn(),
}))
vi.mock('../sie-fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sie-fetcher')>()),
  fetchProviderSieFiles: vi.fn(),
}))
vi.mock('@/lib/import/sie-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/sie-jobs')>()),
  submitSIEJob: vi.fn(),
  getSIEJob: vi.fn(),
  acceptsSIEJobs: vi.fn(),
  runsSIEJobs: vi.fn(),
}))
vi.mock('@/lib/import/sie-job-worker', () => ({ runSIEWorker: vi.fn() }))
vi.mock('@/lib/import/sie-import', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/sie-import')>()),
  loadMappings: vi.fn(),
}))

import { readLiveMembership } from '@/lib/company/company-access'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { ExecutionBudgetExceeded } from '@/lib/http/execution-budget'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { appendableSIEYears, appendConflictRefusal, appendNothingNewRefusal } from '@/lib/import/sie-append'
import {
  acceptsSIEJobs, getSIEJob, runsSIEJobs, sieAppendRefusalError, SIEJobDatabaseError, submitSIEJob,
} from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import { loadMappings } from '@/lib/import/sie-import'
import { FiscalYearSelectionError, fetchProviderSieFiles } from '../sie-fetcher'
import {
  FORTNOX_TOPUP_KEY,
  FORTNOX_TOPUP_RUN_KEY,
  fortnoxTopupErrorVerdict,
  fortnoxTopupView,
  readFortnoxTopup,
  runFortnoxTopups,
  type FortnoxTopupRun,
  type FortnoxTopupSetting,
} from '../fortnox-topup'

const NOW = Date.parse('2026-11-26T01:30:00.000Z')
const SETTING: FortnoxTopupSetting = {
  enabled: true, consentId: 'consent-1', changedBy: 'user-1', changedAt: '2026-11-20T10:00:00.000Z',
}
const YEAR_2026 = {
  fiscalPeriodId: 'p-2026', name: '2026', start: '2026-01-01', end: '2026-12-31', baseImportId: 'base-2026',
  sourceYear: { start: '2026-01-01', end: '2026-12-31' },
}
const SIE_2026 = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.62', '#SIETYP 4', '#RAR 0 20260101 20261231',
  '#KONTO 1930 "Företagskonto"', '#KONTO 3001 "Försäljning"',
  '#VER A 1 20260304 "Faktura 1"', '{', '#TRANS 1930 {} 100.00', '#TRANS 3001 {} -100.00', '}',
].join('\n')

type Row = Record<string, unknown>

function settingRow(companyId: string, setting: FortnoxTopupSetting = SETTING): Row {
  return { id: `setting-${companyId}`, company_id: companyId, key: FORTNOX_TOPUP_KEY, value: setting, updated_at: 'v-setting' }
}

function runRow(companyId: string, run: Partial<FortnoxTopupRun>): Row {
  return {
    id: `run-${companyId}`, company_id: companyId, key: FORTNOX_TOPUP_RUN_KEY, updated_at: 'v-run',
    value: { settingChangedAt: SETTING.changedAt, startedAt: '2026-11-25T01:30:00.000Z', finishedAt: '2026-11-25T01:31:00.000Z', outcome: 'nothing_new',
      added: 0, skippedDuplicates: 0, failures: 0, reason: null, ...run },
  }
}

/** extension_data as the sweep reads and writes it; `claimLost` makes the compare-and-set find nothing. */
function books(rows: Row[], options: { claimLost?: boolean } = {}) {
  const mock = createTableMockSupabase({
    extension_data: (calls) => {
      if (calls.some((c) => c.method === 'insert')) return { data: { id: 'run-new' } }
      if (calls.some((c) => c.method === 'update')) {
        const compareAndSet = calls.some((c) => c.method === 'eq' && c.args[0] === 'updated_at')
        return { data: compareAndSet && options.claimLost ? [] : [{ id: 'run-claimed' }] }
      }
      return { data: rows }
    },
  })
  return { ...mock, supabase: mock.supabase as unknown as SupabaseClient }
}

/** The run each company's night ended with: the last write of the run row. */
function finalRun(payloads: (table: string, method: string) => unknown[]): FortnoxTopupRun {
  return (payloads('extension_data', 'update').at(-1) as { value: FortnoxTopupRun }).value
}

let clock = NOW
const sweep = (supabase: SupabaseClient) => runFortnoxTopups({
  supabase, deadline: NOW + 600_000, hardDeadline: NOW + 760_000,
  now: () => clock, sleep: async (ms) => { clock += ms },
})

beforeEach(() => {
  vi.resetAllMocks()
  clock = NOW
  vi.mocked(acceptsSIEJobs).mockReturnValue(true)
  vi.mocked(runsSIEJobs).mockReturnValue(true)
  vi.mocked(readLiveMembership).mockResolvedValue({ role: 'owner', companyName: null })
  vi.mocked(appendableSIEYears).mockResolvedValue([YEAR_2026])
  vi.mocked(resolveConsent).mockResolvedValue({ consent: { provider: 'fortnox' }, accessToken: 'token-1' })
  vi.mocked(fetchProviderSieFiles).mockResolvedValue({
    files: [{ fiscalYear: 2026, rawContent: SIE_2026 }], failedYears: [], sourceYears: [], omittedYears: [],
  })
  vi.mocked(loadMappings).mockResolvedValue([])
  vi.mocked(submitSIEJob).mockResolvedValue({ id: 'import-1', job_state: 'queued' } as never)
  vi.mocked(runSIEWorker).mockResolvedValue({ jobs: 1, chunks: 1 })
  vi.mocked(getSIEJob).mockResolvedValue({
    id: 'import-1', job_state: 'completed', job_result: { details: { append: { added: 3, possibleDuplicatesSkipped: 1 } } },
  } as never)
})

describe('a night of the top-up', () => {
  it('adds each year\'s new vouchers through the append, as the member who turned it on', async () => {
    const { supabase, payloads } = books([settingRow('company-1')])
    const result = await sweep(supabase)

    expect(fetchProviderSieFiles).toHaveBeenCalledWith('fortnox', 'token-1', undefined, { years: [2026] })
    expect(submitSIEJob).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', SIE_2026, expect.any(Array),
      { filename: 'fortnox-2026-11-26.se', createFiscalPeriod: false, importOpeningBalances: false,
        importTransactions: true, onExistingPeriod: 'append' },
      undefined, 'provider_migration',
      { source: 'migration', via: 'provider_migration', fetchedBy: { type: 'cron', user_id: 'user-1', label: 'fortnox-topup' } })
    expect(runSIEWorker).toHaveBeenCalledWith(expect.objectContaining({ importId: 'import-1', supabase }))
    // The first night claims the company by inserting its run row.
    expect(payloads('extension_data', 'insert')).toEqual([expect.objectContaining({
      company_id: 'company-1', user_id: 'user-1', extension_id: 'arcim-migration', key: FORTNOX_TOPUP_RUN_KEY,
      value: expect.objectContaining({ outcome: 'running', finishedAt: null }),
    })])
    expect(finalRun(payloads)).toEqual({ settingChangedAt: SETTING.changedAt, startedAt: '2026-11-26T01:30:00.000Z', finishedAt: expect.any(String),
      outcome: 'added', added: 3, skippedDuplicates: 1, failures: 0, reason: null })
    expect(result).toEqual({ due: 1, ran: 1, added: 1, nothingNew: 0, failed: 0, stopped: 0, running: 0 })
  })

  it('records a night with nothing new, and the possible duplicates it left out', async () => {
    vi.mocked(submitSIEJob).mockRejectedValue(sieAppendRefusalError(appendNothingNewRefusal(40, 2)))
    const { supabase, payloads } = books([settingRow('company-1'), runRow('company-1', {})])
    await sweep(supabase)
    expect(runSIEWorker).not.toHaveBeenCalled()
    expect(finalRun(payloads)).toMatchObject({ outcome: 'nothing_new', added: 0, skippedDuplicates: 2, failures: 0, reason: null })
  })

  it('stops on a refusal with its own sentence, and the connection shows it until the top-up is turned on again', async () => {
    vi.mocked(submitSIEJob).mockRejectedValue(sieAppendRefusalError(appendConflictRefusal([{ sourceId: 'A7', voucher: 'A7' }])))
    const { supabase, payloads } = books([settingRow('company-1')])
    const result = await sweep(supabase)

    const run = finalRun(payloads)
    expect(run).toMatchObject({ outcome: 'stopped', added: 0, reason: { code: 'SIE_IMPORT_APPEND_CONFLICT' } })
    expect(run.reason!.message).toContain('A7')
    // An English reader gets the refusal's English, as at the other doors.
    expect(run.reason!.message_en).toBe(getErrorEntry('SIE_IMPORT_APPEND_CONFLICT')!.message_en)
    expect(result.stopped).toBe(1)
    expect(fortnoxTopupView(SETTING, run)).toEqual({ consentId: 'consent-1', enabled: false, lastRun: run })
    // Turned on again: a new choice, the stop belongs to the one before.
    expect(fortnoxTopupView({ ...SETTING, changedAt: '2026-11-26T09:00:00.000Z' }, run))
      .toEqual({ consentId: 'consent-1', enabled: true, lastRun: null })
  })

  it('tries a night Fortnox does not answer again the next night, and the third failed night in a row stops it', async () => {
    vi.mocked(fetchProviderSieFiles).mockRejectedValue(new ProviderCallError('PROVIDER_UPSTREAM_ERROR', 'fortnox', 'HTTP 502'))
    const second = books([settingRow('company-1'), runRow('company-1', { outcome: 'failed', failures: 1 })])
    await sweep(second.supabase)
    // The claim is a compare-and-set on the row as read.
    expect(second.findCalls('extension_data', 'eq')).toEqual(expect.arrayContaining([['id', 'run-company-1'], ['updated_at', 'v-run']]))
    expect(finalRun(second.payloads)).toMatchObject({ outcome: 'failed', failures: 2, reason: { code: 'FORTNOX_TOPUP_PROVIDER_UNAVAILABLE' } })
    expect(submitSIEJob).not.toHaveBeenCalled()

    const third = books([settingRow('company-1'), runRow('company-1', { outcome: 'failed', failures: 2 })])
    await sweep(third.supabase)
    const run = finalRun(third.payloads)
    expect(run).toMatchObject({ outcome: 'stopped', failures: 3 })
    expect(run.reason!.message).toContain('tre misslyckade nätter i rad')
    expect(run.reason!.message_en).toContain('three failed nights in a row')

    // Failed nights under an earlier choice do not count: it was turned on again since.
    const again = books([settingRow('company-1'), runRow('company-1', { outcome: 'failed', failures: 2, settingChangedAt: '2026-11-01T08:00:00.000Z' })])
    await sweep(again.supabase)
    expect(finalRun(again.payloads)).toMatchObject({ outcome: 'failed', failures: 1, settingChangedAt: SETTING.changedAt })
  })

  it('stops at once when Fortnox refuses the connection', async () => {
    vi.mocked(resolveConsent).mockRejectedValue(new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'refresh refused'))
    const { supabase, payloads } = books([settingRow('company-1')])
    await sweep(supabase)
    expect(fetchProviderSieFiles).not.toHaveBeenCalled()
    expect(finalRun(payloads)).toMatchObject({ outcome: 'stopped', reason: {
      code: 'PROVIDER_AUTH_EXPIRED', message: getErrorEntry('PROVIDER_AUTH_EXPIRED')!.message_sv,
    } })
  })

  it('replaces a token Fortnox ends midway once, and fetches the years again', async () => {
    vi.mocked(resolveConsent)
      .mockResolvedValueOnce({ consent: { provider: 'fortnox' }, accessToken: 'old' })
      .mockResolvedValueOnce({ consent: { provider: 'fortnox' }, accessToken: 'new' })
    vi.mocked(fetchProviderSieFiles).mockResolvedValueOnce({
      files: [], failedYears: [{ year: 2026, error: 'HTTP 401', code: 'PROVIDER_AUTH_EXPIRED' }], sourceYears: [], omittedYears: [],
    })
    const { supabase, payloads } = books([settingRow('company-1')])
    await sweep(supabase)
    expect(resolveConsent).toHaveBeenLastCalledWith('company-1', 'consent-1', { rejectedAccessToken: 'old' })
    expect(fetchProviderSieFiles).toHaveBeenLastCalledWith('fortnox', 'new', undefined, { years: [2026] })
    expect(finalRun(payloads)).toMatchObject({ outcome: 'added', added: 3 })
  })

  it('stops before Fortnox is asked when the member who turned it on can no longer book', async () => {
    vi.mocked(readLiveMembership).mockResolvedValue({ role: 'viewer', companyName: null })
    const { supabase, payloads } = books([settingRow('company-1')])
    await sweep(supabase)
    expect(readLiveMembership).toHaveBeenCalledWith(supabase, 'user-1', 'company-1')
    expect(resolveConsent).not.toHaveBeenCalled()
    expect(finalRun(payloads)).toMatchObject({ outcome: 'stopped', reason: { code: 'FORTNOX_TOPUP_ACTOR_CANNOT_BOOK' } })
  })

  it('stops when no year imported from Fortnox takes vouchers any more', async () => {
    vi.mocked(appendableSIEYears).mockResolvedValue([])
    const { supabase, payloads } = books([settingRow('company-1')])
    await sweep(supabase)
    expect(appendableSIEYears).toHaveBeenCalledWith(supabase, 'company-1', 'Fortnox')
    expect(resolveConsent).not.toHaveBeenCalled()
    expect(finalRun(payloads)).toMatchObject({ outcome: 'stopped', reason: {
      code: 'PROVIDER_TOPUP_NO_OPEN_YEAR', message: getErrorEntry('PROVIDER_TOPUP_NO_OPEN_YEAR')!.message_sv,
    } })
  })

  it('leaves alone a company that ran tonight, one that stopped, one switched off and one another delivery took', async () => {
    const { supabase } = books([
      settingRow('ran'), runRow('ran', { startedAt: '2026-11-25T23:30:00.000Z' }),
      settingRow('stopped'), runRow('stopped', { outcome: 'stopped', reason: { code: 'X', message: 'Stopp.' } }),
      settingRow('off', { ...SETTING, enabled: false }),
      settingRow('taken'), runRow('taken', {}),
    ], { claimLost: true })
    const result = await sweep(supabase)
    expect(result).toEqual({ due: 1, ran: 0, added: 0, nothingNew: 0, failed: 0, stopped: 0, running: 0 })
    expect(readLiveMembership).not.toHaveBeenCalled()
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('runs nothing and records nothing while the installation has SIE imports paused', async () => {
    vi.mocked(acceptsSIEJobs).mockReturnValue(false)
    const { supabase, tables } = books([settingRow('company-1')])
    expect(await sweep(supabase)).toMatchObject({ paused: true, ran: 0 })
    expect(tables()).toEqual([])
  })

  it('counts a run the platform ended as a failed night, and stops at the third', async () => {
    // Claimed 30 minutes ago and never finished: the cron is long gone.
    const { supabase, payloads } = books([settingRow('company-1'),
      runRow('company-1', { startedAt: '2026-11-26T01:00:00.000Z', finishedAt: null, outcome: 'running', failures: 2 })])
    await sweep(supabase)
    expect(submitSIEJob).not.toHaveBeenCalled()
    expect(finalRun(payloads)).toMatchObject({ outcome: 'stopped', failures: 3, reason: { code: 'FORTNOX_TOPUP_UNFINISHED' } })
  })

  it('leaves an import that outlasts the run to the SIE worker, and the connection reads it once it has ended', async () => {
    vi.mocked(getSIEJob).mockResolvedValue({ id: 'import-1', job_state: 'running' } as never)
    const { supabase, payloads } = books([settingRow('company-1')])
    const result = await sweep(supabase)
    const run = finalRun(payloads)
    expect(run).toMatchObject({ outcome: 'running', importId: 'import-1', finishedAt: expect.any(String) })
    expect(result.running).toBe(1)

    vi.mocked(getSIEJob).mockResolvedValue({
      id: 'import-1', job_state: 'completed', job_result: { details: { append: { added: 4, possibleDuplicatesSkipped: 0 } } },
    } as never)
    const stored: Record<string, unknown> = { [FORTNOX_TOPUP_KEY]: SETTING, [FORTNOX_TOPUP_RUN_KEY]: run }
    const settings = { get: vi.fn(async (key: string) => stored[key] ?? null), set: vi.fn(), clear: vi.fn() } as unknown as ExtensionSettings
    const view = await readFortnoxTopup(settings, supabase, 'company-1')
    expect(getSIEJob).toHaveBeenLastCalledWith(supabase, 'company-1', 'import-1')
    expect(view).toMatchObject({ enabled: true, lastRun: { outcome: 'added', added: 4 } })
  })
})

describe('fortnoxTopupErrorVerdict', () => {
  it.each([
    ['another import of the company still going', new SIEJobDatabaseError('SIE import is unfinished: resume or undo it', 'SIE_IMPORT_UNFINISHED', '55000'), false],
    ['a connection that is gone', { status: 404, message: 'Consent not found' }, true],
    ['a register Fortnox closed', new ProviderCallError('PROVIDER_RESOURCE_FORBIDDEN', 'fortnox', 'Saknar behörighet'), true],
    ['a year Fortnox no longer has', new FiscalYearSelectionError([2025]), true],
    ['a run out of time', new ExecutionBudgetExceeded('fortnox-topup'), false],
    ['an error nobody expected', new Error('boom'), false],
  ])('%s: stop %s', (_label, error, stop) => {
    expect(fortnoxTopupErrorVerdict(error).stop).toBe(stop)
  })

  it('names the year Fortnox no longer has', () => {
    expect(fortnoxTopupErrorVerdict(new FiscalYearSelectionError([2025])).reason.message).toContain('2025')
  })
})

describe('fortnoxTopupView', () => {
  const run = runRow('company-1', { startedAt: '2026-11-25T01:30:00.000Z', outcome: 'added', added: 2 }).value as FortnoxTopupRun
  it('shows the latest run while the top-up is on', () => {
    expect(fortnoxTopupView(SETTING, run)).toEqual({ consentId: 'consent-1', enabled: true, lastRun: run })
  })
  it('shows no run once it is switched off, and nothing when it was never turned on', () => {
    expect(fortnoxTopupView({ ...SETTING, enabled: false, changedAt: '2026-11-25T12:00:00.000Z' }, run))
      .toEqual({ consentId: 'consent-1', enabled: false, lastRun: null })
    expect(fortnoxTopupView(null, run)).toBeNull()
  })
})
