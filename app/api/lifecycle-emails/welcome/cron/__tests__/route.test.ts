import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({ tag: 'service-client' })),
}))

vi.mock('@/lib/lifecycle-emails/welcome', () => ({
  runWelcomeEmailSweep: vi.fn(),
}))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { runWelcomeEmailSweep } from '@/lib/lifecycle-emails/welcome'
import { ensureInitialized } from '@/lib/init'

// Captured before any beforeEach clears mock history: the call happens once,
// at module import, and that is exactly what the first test locks in.
const initCallsAtImport = vi.mocked(ensureInitialized).mock.calls.length

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/lifecycle-emails/welcome/cron')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/lifecycle-emails/welcome/cron', () => {
  it('wires the extension registry at module load so the email service is real', () => {
    expect(initCallsAtImport).toBeGreaterThanOrEqual(1)
  })

  it('returns 401 without a valid cron secret and runs nothing', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const res = await GET(cronRequest())

    expect(res.status).toBe(401)
    expect(runWelcomeEmailSweep).not.toHaveBeenCalled()
  })

  it('runs the sweep with the service client and returns its summary', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(null)
    vi.mocked(runWelcomeEmailSweep).mockResolvedValue({
      configured: true,
      candidates: 2,
      sent: 1,
      skipped: 1,
      failed: 0,
    })

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      configured: true,
      candidates: 2,
      sent: 1,
      skipped: 1,
      failed: 0,
    })
    expect(runWelcomeEmailSweep).toHaveBeenCalledWith(
      { tag: 'service-client' },
      expect.objectContaining({ log: expect.anything() }),
    )
  })

  it('maps a thrown sweep error to the canonical error envelope', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(null)
    vi.mocked(runWelcomeEmailSweep).mockRejectedValue(new Error('welcome candidates lookup failed'))

    const res = await GET(cronRequest())

    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })
})
