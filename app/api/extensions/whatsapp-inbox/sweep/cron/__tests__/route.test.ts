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

vi.mock('@/extensions/general/whatsapp-inbox/lib/sweep', () => ({
  runSweep: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

import { GET } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { loadExtensions } from '@/lib/extensions/loader'
import { runSweep } from '@/extensions/general/whatsapp-inbox/lib/sweep'
import { verifyCronSecret } from '@/lib/auth/cron'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockRunSweep = vi.mocked(runSweep)

function makeRequest() {
  return new Request('http://localhost/api/extensions/whatsapp-inbox/sweep/cron', {
    headers: { authorization: 'Bearer synthetic-cron-secret' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerifyCronSecret.mockReturnValue(null)
})

describe('GET /api/extensions/whatsapp-inbox/sweep/cron', () => {
  it('returns 401 when the cron secret is rejected', async () => {
    mockVerifyCronSecret.mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    expect(mockRunSweep).not.toHaveBeenCalled()
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
    expect(mockRunSweep).not.toHaveBeenCalled()
  })

  it('runs the sweep and returns its summary when enabled', async () => {
    mockRegistryGet.mockReturnValue({ id: 'whatsapp-inbox' } as never)
    mockRunSweep.mockResolvedValue({
      reclaimedReceived: 2,
      reclaimedProcessing: 1,
      erroredMaxAttempts: 0,
      finalizedAcks: 1,
      expiredQuestions: 1,
      clearedPins: 0,
      outboundFailed24h: 3,
    })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(loadExtensions).toHaveBeenCalled()
    expect(mockRegistryGet).toHaveBeenCalledWith('whatsapp-inbox')
    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      reclaimedReceived: 2,
      reclaimedProcessing: 1,
      erroredMaxAttempts: 0,
      finalizedAcks: 1,
      expiredQuestions: 1,
      clearedPins: 0,
      outboundFailed24h: 3,
    })
  })
})
