import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest, parseJsonResponse } from '@/tests/helpers'

/**
 * The batched attest mail's two jobs (crm#1569): the cron secret guards both,
 * and each runs on the service role. The 5-minute request job also sweeps the
 * approvals stuck in 'committing': the nightly expire cron alone left such a
 * row invisible for up to a day.
 */

const mocks = vi.hoisted(() => ({ requests: vi.fn(), followUps: vi.fn(), recoverStuck: vi.fn() }))
vi.mock('@/lib/supplier-invoices/attest-mail-run', () => ({
  runAttestRequestRound: (...a: unknown[]) => mocks.requests(...a),
  runAttestFollowUps: (...a: unknown[]) => mocks.followUps(...a),
}))
vi.mock('@/lib/pending-operations/recover-stuck-committing', () => ({
  recoverStuckCommittingOperations: (...a: unknown[]) => mocks.recoverStuck(...a),
}))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => ({ tag: 'cron-service' }) }))

import { GET as requestCron } from '../cron/route'
import { GET as followUpCron } from '../follow-up/cron/route'

const NOTHING_STUCK = { scanned: 0, committed: 0, unknown: 0, skipped: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.recoverStuck.mockResolvedValue(NOTHING_STUCK)
  vi.stubEnv('CRON_SECRET', 'secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.se')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('GET /api/supplier-invoices/attest-mail/cron', () => {
  it('refuses a missing or wrong secret', async () => {
    expect((await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron'))).status).toBe(401)
    expect((await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron', 'Bearer wrong'))).status).toBe(401)
    expect(mocks.requests).not.toHaveBeenCalled()
    expect(mocks.recoverStuck).not.toHaveBeenCalled()
  })

  const summary = { skipped: null, queued: 3, companies: 1, invoices_asked: 3, request_mails_sent: 1, blocked_notices_sent: 0, failed_companies: 0 }

  it('runs the request round on the service role and answers its summary, with the stuck-approval sweep after it', async () => {
    mocks.requests.mockResolvedValue(summary)
    mocks.recoverStuck.mockResolvedValue({ scanned: 1, committed: 0, unknown: 1, skipped: 0 })
    const { status, body } = await parseJsonResponse(await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron', 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual({ ...summary, stuck_operations: { scanned: 1, committed: 0, unknown: 1, skipped: 0 } })
    expect(mocks.requests).toHaveBeenCalledWith({ tag: 'cron-service' }, expect.anything())
    // Every 5 minutes: a row that keeps failing is a warning here, an error in the nightly sweep.
    expect(mocks.recoverStuck).toHaveBeenCalledWith({ tag: 'cron-service' }, expect.objectContaining({ failureLevel: 'warn' }))
    expect(mocks.requests.mock.invocationCallOrder[0]).toBeLessThan(mocks.recoverStuck.mock.invocationCallOrder[0]!)
  })

  it('still answers the round when the sweep fails', async () => {
    mocks.requests.mockResolvedValue(summary)
    mocks.recoverStuck.mockRejectedValue(new Error('listing broke'))
    const { status, body } = await parseJsonResponse(await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron', 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual({ ...summary, stuck_operations: { error: 'recovery_sweep_failed' } })
  })

  it('starts no sweep when the round used the run up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mocks.requests.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 250_000))
      return summary
    })
    const { body } = await parseJsonResponse(await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron', 'Bearer secret')))
    expect(body).toEqual({ ...summary, stuck_operations: { skipped: 'out_of_time' } })
    expect(mocks.recoverStuck).not.toHaveBeenCalled()
  })
})

describe('GET /api/supplier-invoices/attest-mail/follow-up/cron', () => {
  it('refuses a missing or wrong secret', async () => {
    expect((await followUpCron(createCronRequest('/api/supplier-invoices/attest-mail/follow-up/cron'))).status).toBe(401)
    expect((await followUpCron(createCronRequest('/api/supplier-invoices/attest-mail/follow-up/cron', 'Bearer wrong'))).status).toBe(401)
    expect(mocks.followUps).not.toHaveBeenCalled()
  })

  it('runs the follow-ups on the service role and answers their summary', async () => {
    const summary = { skipped: 'schema_missing', waiting: 0, reminder_mails_sent: 0, overdue_notices_sent: 0, blocked_notices_sent: 0, failed_companies: 0 }
    mocks.followUps.mockResolvedValue(summary)
    const { status, body } = await parseJsonResponse(await followUpCron(createCronRequest('/api/supplier-invoices/attest-mail/follow-up/cron', 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual(summary)
    expect(mocks.followUps).toHaveBeenCalledWith({ tag: 'cron-service' }, expect.anything())
  })
})
