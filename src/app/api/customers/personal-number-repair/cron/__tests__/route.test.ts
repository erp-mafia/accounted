import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: logWarn, error: logError, child: (): unknown => logger }
  return { ...actual, createLogger: () => logger }
})
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => ({})) }))
vi.mock('@/lib/customers/org-number-repair', () => ({ repairIndividualOrgNumbers: vi.fn() }))

import { GET, maxDuration } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { repairIndividualOrgNumbers, type OrgNumberRepairRun } from '@/lib/customers/org-number-repair'

const call = () => GET(new Request('http://localhost/api/customers/personal-number-repair/cron'))
const run = (overrides: Partial<OrgNumberRepairRun> = {}): OrgNumberRepairRun => ({
  individuals: 3,
  companies: 2,
  counts: { move: 2, clear_same: 1, clear_differ: 0, skip_unreadable: 0, skip_not_personal_number: 0 },
  written: 3,
  changedUnderneath: 0,
  failed: {},
  stopped: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
})
afterEach(() => vi.useRealTimers())

describe('GET /api/customers/personal-number-repair/cron', () => {
  it('refuses a request without the cron secret before reading anything', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await call()).status).toBe(401)
    expect(repairIndividualOrgNumbers).not.toHaveBeenCalled()
  })

  it('writes the repair, stops writing 200 s in and answers the counts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    vi.mocked(repairIndividualOrgNumbers).mockResolvedValue(run())
    const { status, body } = await parseJsonResponse(await call())
    expect(maxDuration).toBe(300)
    expect(status).toBe(200)
    expect(repairIndividualOrgNumbers).toHaveBeenCalledWith(expect.anything(), {
      apply: true,
      deadline: start + 200_000,
      actorLabel: 'cron customer-personal-number-repair',
    })
    expect(body).toEqual({ data: run() })
  })

  describe('rows it could not write', () => {
    const stuck = run({ written: 1, failed: { '23514': 2, P0001: 1 } })
    const details = { unwritten: 3, failedByCode: { '23514': 2, P0001: 1 }, written: 1, counts: stuck.counts }
    const at = async (iso: string) => {
      vi.useFakeTimers({ now: new Date(iso), toFake: ['Date'] })
      vi.mocked(repairIndividualOrgNumbers).mockResolvedValue(stuck)
      return parseJsonResponse(await call())
    }

    it('are one error with their codes on the day\'s 06:00 UTC run, and the counts are still answered', async () => {
      const { status, body } = await at('2026-11-13T06:00:04.000Z')
      expect(status).toBe(200)
      expect(body).toEqual({ data: stuck })
      expect(logError).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalledWith('customer personal number repair could not write some rows', undefined, details)
    })

    it('are a warning on every other run: one error a day, not 288', async () => {
      for (const iso of ['2026-11-13T06:05:02.000Z', '2026-11-13T05:55:03.000Z', '2026-11-13T12:00:01.000Z']) {
        await at(iso)
      }
      expect(logError).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledTimes(3)
      expect(logWarn).toHaveBeenCalledWith('customer personal number repair could not write some rows', details)
    })
  })

  it('logs no error for a run whose writes all went through', async () => {
    vi.mocked(repairIndividualOrgNumbers).mockResolvedValue(run())
    await call()
    expect(logError).not.toHaveBeenCalled()
  })

  it('fails the run when the last written row got no audit row', async () => {
    vi.mocked(repairIndividualOrgNumbers).mockResolvedValue(run({ written: 1, stopped: 'audit_failed', auditError: '42501' }))
    expect((await call()).status).toBe(500)
  })
})
