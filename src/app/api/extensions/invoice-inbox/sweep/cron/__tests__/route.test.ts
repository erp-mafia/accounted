import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/extensions/loader', () => ({
  loadExtensions: vi.fn(),
}))

vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: {
    get: vi.fn(),
  },
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn().mockReturnValue({}),
}))

vi.mock('@/extensions/general/invoice-inbox/lib/sweep', () => ({
  runInboxSweep: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

import { GET } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { loadExtensions } from '@/lib/extensions/loader'
import { runInboxSweep } from '@/extensions/general/invoice-inbox/lib/sweep'
import { verifyCronSecret } from '@/lib/auth/cron'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockRunInboxSweep = vi.mocked(runInboxSweep)

function makeRequest() {
  return new Request('http://localhost/api/extensions/invoice-inbox/sweep/cron', {
    headers: { authorization: 'Bearer synthetic-cron-secret' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerifyCronSecret.mockReturnValue(null)
})

describe('GET /api/extensions/invoice-inbox/sweep/cron', () => {
  it('returns 401 when the cron secret is rejected', async () => {
    mockVerifyCronSecret.mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    expect(mockRunInboxSweep).not.toHaveBeenCalled()
  })

  it('returns 503 EXTENSION_DISABLED when the extension is not in the registry', async () => {
    // Physical extension routes deploy in every build; the registry, generated
    // from extensions.config.json, is what turns them on. Disabled must mean
    // no sweeping AND a visible failure if the cron is scheduled anyway.
    mockRegistryGet.mockReturnValue(undefined)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('EXTENSION_DISABLED')
    expect(mockRunInboxSweep).not.toHaveBeenCalled()
  })

  it('runs the sweep and returns its summary when enabled', async () => {
    mockRegistryGet.mockReturnValue({ id: 'invoice-inbox' } as never)
    mockRunInboxSweep.mockResolvedValue({ flipped: 3 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(loadExtensions).toHaveBeenCalled()
    expect(mockRegistryGet).toHaveBeenCalledWith('invoice-inbox')
    expect(response.status).toBe(200)
    expect(body.data).toEqual({ flipped: 3 })
  })
})
