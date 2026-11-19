import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'

const { verifyCronSecret } = vi.hoisted(() => ({ verifyCronSecret: vi.fn((): unknown => null) }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret }))
const { createServiceRoleClient } = vi.hoisted(() => ({ createServiceRoleClient: vi.fn(() => ({ marker: 'service' })) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient }))
const { registryGet } = vi.hoisted(() => ({ registryGet: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: registryGet } }))

import { withCronContext, withServiceCronContext } from '../with-cron-context'

const request = () => new Request('https://example.test/api/extensions/x/cron')

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecret.mockReturnValue(null)
  registryGet.mockResolvedValue({ id: 'shopify' })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
})
afterEach(() => vi.unstubAllEnvs())

describe('withCronContext extension gate', () => {
  it('answers 200 skipped when the extension is not enabled, before the handler runs', async () => {
    registryGet.mockResolvedValue(undefined)
    const handler = vi.fn()

    const res = await withCronContext('cron.test', handler, { requireExtension: 'shopify' })(request())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ skipped: true, reason: 'extension_disabled', processed: 0 })
    expect(res.headers.get('X-Request-Id')).toMatch(/^cron_/)
    expect(registryGet).toHaveBeenCalledWith('shopify')
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the handler when the extension is enabled', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ran: true }))

    const res = await withCronContext('cron.test', handler, { requireExtension: 'shopify' })(request())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ran: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('checks the cron secret before the gate', async () => {
    verifyCronSecret.mockReturnValue({ error: 'unauthorized' })
    const handler = vi.fn()

    const res = await withCronContext('cron.test', handler, { requireExtension: 'shopify' })(request())

    expect(res.status).toBe(401)
    expect(registryGet).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('leaves a cron without requireExtension ungated', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ran: true }))

    const res = await withCronContext('cron.test', handler)(request())

    expect(res.status).toBe(200)
    expect(registryGet).not.toHaveBeenCalled()
  })

  it('withServiceCronContext gates before checking the Supabase configuration', async () => {
    registryGet.mockResolvedValue(undefined)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const handler = vi.fn()

    const res = await withServiceCronContext('cron.test', handler, { requireExtension: 'stripe' })(request())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ skipped: true, reason: 'extension_disabled', processed: 0 })
    expect(createServiceRoleClient).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })
})
