/**
 * Tests for the invoice reminder cron gate: automatic reminder sending has
 * been deliberately disabled since May 2026 (PR #583). The route and the
 * invoice settings UI both read REMINDERS_SENDING_ENABLED, so these tests
 * pin the contract: while the flag is off the route answers 503 and never
 * touches the reminder processor; when the flag is flipped on, the route
 * runs the original sending pipeline. Scheduling the route again (it has
 * had no vercel.json cron entry since PR #559) and the pre-flip idempotency
 * work are separate steps; see lib/invoices/reminders-enabled.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  processOverdueReminders: vi.fn(),
  isConfigured: vi.fn(),
}))

vi.mock('@/lib/api/with-cron-context', () => ({
  withCronContext:
    (_name: string, handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request) =>
      handler(req, {
        log: { info: h.logInfo, error: h.logError, warn: vi.fn() },
        requestId: 'req_test',
      }),
}))

vi.mock('@/lib/invoices/reminder-processor', () => ({
  processOverdueReminders: h.processOverdueReminders,
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: h.isConfigured }),
}))

import { GET, POST } from '../route'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/invoices/reminders/cron')
}

describe('REMINDERS_SENDING_ENABLED flag', () => {
  it('is off: re-enabling automatic reminder sending is a deliberate founder decision', () => {
    expect(REMINDERS_SENDING_ENABLED).toBe(false)
  })
})

describe('GET /api/invoices/reminders/cron with sending disabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 503 and never invokes the reminder processor', async () => {
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).toEqual({ disabled: true })
    expect(h.processOverdueReminders).not.toHaveBeenCalled()
    expect(h.isConfigured).not.toHaveBeenCalled()
    expect(h.logInfo).toHaveBeenCalledWith(
      'invoice reminders feature is disabled; skipping run'
    )
  })

  it('exposes POST as the same gated handler (manual dashboard trigger)', async () => {
    expect(POST).toBe(GET)

    const res = await POST(cronRequest())
    expect(res.status).toBe(503)
    expect(h.processOverdueReminders).not.toHaveBeenCalled()
  })
})

describe('GET /api/invoices/reminders/cron with sending enabled (flag flipped)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  async function importRouteWithFlagOn() {
    vi.doMock('@/lib/invoices/reminders-enabled', () => ({
      REMINDERS_SENDING_ENABLED: true,
    }))
    return import('../route')
  }

  it('runs the reminder pipeline and reports the summary', async () => {
    h.isConfigured.mockReturnValue(true)
    h.processOverdueReminders.mockResolvedValue({
      processed: 2,
      sent: 1,
      failed: 1,
      results: [
        {
          invoiceId: 'inv-1',
          invoiceNumber: 'F-1001',
          customerEmail: 'kund@testbrand.example',
          reminderLevel: 1,
          success: true,
        },
        {
          invoiceId: 'inv-2',
          invoiceNumber: 'F-1002',
          customerEmail: 'kund2@testbrand.example',
          reminderLevel: 2,
          success: false,
          error: 'bounce',
        },
      ],
    })

    const { GET: gatedGet } = await importRouteWithFlagOn()
    const res = await gatedGet(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(h.processOverdueReminders).toHaveBeenCalledTimes(1)
    expect(body).toEqual({
      success: true,
      processed: 2,
      sent: 1,
      failed: 1,
      results: [
        { invoiceNumber: 'F-1001', reminderLevel: 1, success: true },
        { invoiceNumber: 'F-1002', reminderLevel: 2, success: false, error: 'bounce' },
      ],
    })
  })

  it('still refuses to run when the email service is not configured', async () => {
    h.isConfigured.mockReturnValue(false)

    const { GET: gatedGet } = await importRouteWithFlagOn()
    const res = await gatedGet(cronRequest())

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(h.processOverdueReminders).not.toHaveBeenCalled()
    expect(h.logError).toHaveBeenCalledWith(
      'email service not configured; skipping reminder run'
    )
  })
})
