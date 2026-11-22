import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

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
import { runSweep } from '@/extensions/general/whatsapp-inbox/lib/sweep'
import { verifyCronSecret } from '@/lib/auth/cron'
import { currentAiDeadline } from '@/lib/ai/call-limit'

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

  it('answers 200 skipped when the extension is not in the registry', async () => {
    // Physical extension routes deploy in every build; the registry, generated
    // from extensions.config.json, is what turns them on. Disabled means no
    // sweeping, and a skip (not a failure) for the crontab that calls it anyway.
    mockRegistryGet.mockResolvedValue(undefined)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ skipped: true, reason: 'extension_disabled', processed: 0 })
    expect(mockRunSweep).not.toHaveBeenCalled()
  })

  it('runs the sweep and returns its summary when enabled', async () => {
    mockRegistryGet.mockResolvedValue({ id: 'whatsapp-inbox' } as never)
    mockRunSweep.mockResolvedValue({
      reclaimedReceived: 2,
      reclaimedProcessing: 1,
      erroredMaxAttempts: 0,
      finalizedAcks: 1,
      expiredQuestions: 1,
      clearedPins: 0,
      outboundFailed24h: 3,
      reopenedOrphans: 0,
      deferred: 0,
      resentErrorNotices: 0,
      failedPasses: [],
    })

    const response = await GET(makeRequest())
    const body = await response.json()

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
      reopenedOrphans: 0,
      deferred: 0,
      resentErrorNotices: 0,
      failedPasses: [],
    })
  })

  const cleanSummary = {
    reclaimedReceived: 0,
    reclaimedProcessing: 0,
    erroredMaxAttempts: 0,
    finalizedAcks: 0,
    expiredQuestions: 0,
    clearedPins: 0,
    outboundFailed24h: 0,
    reopenedOrphans: 0,
    deferred: 0,
    resentErrorNotices: 0,
    failedPasses: [] as string[],
  }

  it('gives the sweep a deadline counted from when the request arrived, and ends its model calls before the function is killed', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    mockRegistryGet.mockResolvedValue({ id: 'whatsapp-inbox' } as never)
    let modelStop: number | undefined
    mockRunSweep.mockImplementation(async () => {
      modelStop = currentAiDeadline()
      return cleanSummary
    })
    try {
      await GET(makeRequest())
    } finally {
      clock.mockRestore()
    }
    expect(mockRunSweep).toHaveBeenCalledWith(expect.anything(), { deadlineAt: 1_200_000 })
    expect(modelStop).toBe(1_270_000)
  })

  it('answers 500 when a pass could not read its work: a 200 would say the recovery is running', async () => {
    mockRegistryGet.mockResolvedValue({ id: 'whatsapp-inbox' } as never)
    mockRunSweep.mockResolvedValue({ ...cleanSummary, reclaimedProcessing: 1, failedPasses: ['received'] })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error.code).toBe('SWEEP_PASS_FAILED')
    // What the other passes did is still reported.
    expect(body.data.reclaimedProcessing).toBe(1)
    expect(body.data.failedPasses).toEqual(['received'])
  })
})
