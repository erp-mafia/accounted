import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({}),
}))

vi.mock('@/lib/extensions/loader', () => ({
  loadExtensions: vi.fn(),
}))

vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: {
    get: vi.fn(),
  },
}))

vi.mock('@/extensions/general/push-notifications/notification-scheduler', () => ({
  sendTaxDeadlineNotifications: vi.fn(),
  sendInvoiceNotifications: vi.fn(),
  sendMissingUnderlagNotifications: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

import { GET } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { loadExtensions } from '@/lib/extensions/loader'
import {
  sendTaxDeadlineNotifications,
  sendInvoiceNotifications,
  sendMissingUnderlagNotifications,
} from '@/extensions/general/push-notifications/notification-scheduler'
import { verifyCronSecret } from '@/lib/auth/cron'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockTax = vi.mocked(sendTaxDeadlineNotifications)
const mockInvoice = vi.mocked(sendInvoiceNotifications)
const mockUnderlag = vi.mocked(sendMissingUnderlagNotifications)

function makeRequest() {
  return new Request('http://localhost/api/extensions/push-notifications/cron', {
    headers: { authorization: 'Bearer synthetic-cron-secret' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerifyCronSecret.mockReturnValue(null)
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://synthetic.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role-key'
})

describe('GET /api/extensions/push-notifications/cron', () => {
  it('returns 401 when the cron secret is rejected', async () => {
    mockVerifyCronSecret.mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )

    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    expect(mockTax).not.toHaveBeenCalled()
  })

  it('returns 503 EXTENSION_DISABLED when the extension is not in the registry', async () => {
    // Physical extension routes deploy in every build; the registry, generated
    // from extensions.config.json, is what turns them on. Disabled must mean
    // no sends AND a visible failure if the cron is ever scheduled anyway.
    mockRegistryGet.mockReturnValue(undefined)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('EXTENSION_DISABLED')
    expect(mockTax).not.toHaveBeenCalled()
    expect(mockInvoice).not.toHaveBeenCalled()
    expect(mockUnderlag).not.toHaveBeenCalled()
  })

  it('runs all three schedulers and sums the totals when enabled', async () => {
    mockRegistryGet.mockReturnValue({ id: 'push-notifications' } as never)
    mockTax.mockResolvedValue({ sent: 2, skipped: 1 })
    mockInvoice.mockResolvedValue({ sent: 3, skipped: 0 })
    mockUnderlag.mockResolvedValue({ sent: 1, skipped: 4 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(loadExtensions).toHaveBeenCalled()
    expect(mockRegistryGet).toHaveBeenCalledWith('push-notifications')
    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.totalSent).toBe(6)
    expect(body.totalSkipped).toBe(5)
    expect(body.details.taxDeadlines).toEqual({ sent: 2, skipped: 1 })
  })

  it('returns the error envelope when Supabase configuration is missing', async () => {
    mockRegistryGet.mockReturnValue({ id: 'push-notifications' } as never)
    delete process.env.NEXT_PUBLIC_SUPABASE_URL

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(mockTax).not.toHaveBeenCalled()
  })
})
