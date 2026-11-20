import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
const { createServiceRoleClient } = vi.hoisted(() => ({ createServiceRoleClient: vi.fn(() => ({ marker: 'service' })) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient }))

import { withServiceCronContext } from '../with-cron-context'

const request = () => new Request('https://example.test/api/x/cron')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
})
afterEach(() => vi.unstubAllEnvs())

describe('withServiceCronContext', () => {
  it('hands the handler a service-role client', async () => {
    const handler = vi.fn(async (_req: Request, ctx: { supabase: unknown; requestId: string }) =>
      NextResponse.json({ client: ctx.supabase, hasRequestId: ctx.requestId.startsWith('cron_') }),
    )

    const res = await withServiceCronContext('cron.test', handler)(request())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ client: { marker: 'service' }, hasRequestId: true })
    expect(createServiceRoleClient).toHaveBeenCalledWith('https://project.supabase.co', 'service-key')
  })

  it('answers 500 INTERNAL_ERROR without the Supabase configuration, before the handler runs', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const handler = vi.fn()

    const res = await withServiceCronContext('cron.test', handler)(request())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(handler).not.toHaveBeenCalled()
    expect(createServiceRoleClient).not.toHaveBeenCalled()
  })
})
