import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest, parseJsonResponse } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({ run: vi.fn(), registry: vi.fn() }))
vi.mock('@/extensions/general/skatteverket/lib/ombud-announcement', () => ({
  runOmbudAnnouncementCron: (...a: unknown[]) => mocks.run(...a),
}))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: (id: string) => mocks.registry(id) } }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => ({ tag: 'cron-service' }) }))

import { GET } from '../route'

const PATH = '/api/extensions/skatteverket/ombud/announcement/cron'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 'secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.se')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  mocks.registry.mockReturnValue({ id: 'skatteverket' })
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/extensions/skatteverket/ombud/announcement/cron', () => {
  it('answers 401 to a missing or wrong secret and runs nothing', async () => {
    expect((await GET(createCronRequest(PATH))).status).toBe(401)
    expect((await GET(createCronRequest(PATH, 'Bearer wrong'))).status).toBe(401)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('skips when the Skatteverket extension is not enabled', async () => {
    mocks.registry.mockReturnValue(undefined)
    const { status, body } = await parseJsonResponse<{ skipped: boolean }>(await GET(createCronRequest(PATH, 'Bearer secret')))
    expect(status).toBe(200)
    expect(body.skipped).toBe(true)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('runs on the service role with a send deadline and answers the counts', async () => {
    const summary = { ombud_enabled: true, mails: false, used_recently: 4, eligible_companies: 2, recipients: 3, mails_due: 3, sent: 0 }
    mocks.run.mockResolvedValue(summary)
    const { status, body } = await parseJsonResponse(await GET(createCronRequest(PATH, 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual(summary)
    expect(mocks.run.mock.calls[0][0]).toEqual({ tag: 'cron-service' })
    expect(mocks.run.mock.calls[0][2].deadline).toBeGreaterThan(Date.now())
  })
})
