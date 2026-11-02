import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest, parseJsonResponse } from '@/tests/helpers'

/** The batched attest mail's two jobs (crm#1569): the cron secret guards both, and each runs on the service role. */

const mocks = vi.hoisted(() => ({ requests: vi.fn(), followUps: vi.fn() }))
vi.mock('@/lib/supplier-invoices/attest-mail-run', () => ({
  runAttestRequestRound: (...a: unknown[]) => mocks.requests(...a),
  runAttestFollowUps: (...a: unknown[]) => mocks.followUps(...a),
}))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => ({ tag: 'cron-service' }) }))

import { GET as requestCron } from '../cron/route'
import { GET as followUpCron } from '../follow-up/cron/route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 'secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.se')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/supplier-invoices/attest-mail/cron', () => {
  it('refuses a missing or wrong secret', async () => {
    expect((await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron'))).status).toBe(401)
    expect((await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron', 'Bearer wrong'))).status).toBe(401)
    expect(mocks.requests).not.toHaveBeenCalled()
  })

  it('runs the request round on the service role and answers its summary', async () => {
    const summary = { skipped: null, queued: 3, companies: 1, invoices_asked: 3, request_mails_sent: 1, blocked_notices_sent: 0, failed_companies: 0 }
    mocks.requests.mockResolvedValue(summary)
    const { status, body } = await parseJsonResponse(await requestCron(createCronRequest('/api/supplier-invoices/attest-mail/cron', 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual(summary)
    expect(mocks.requests).toHaveBeenCalledWith({ tag: 'cron-service' }, expect.anything())
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
