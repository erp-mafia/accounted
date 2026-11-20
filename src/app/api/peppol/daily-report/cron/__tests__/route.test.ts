import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendReportMock = vi.fn()
const serviceClient = vi.hoisted(() => ({ from: () => undefined }))
const logMock = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log
})

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => serviceClient,
}))
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => logMock,
}))
vi.mock('@/lib/invoices/peppol-daily-report', () => ({
  sendPeppolDailyReport: (...args: unknown[]) => sendReportMock(...args),
}))

import { GET } from '../route'

function request(secret: string | null): Request {
  return new Request('http://localhost:3000/api/peppol/daily-report/cron', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  })
}

describe('GET /api/peppol/daily-report/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    sendReportMock.mockResolvedValue({ sent: true, sends: 3, failures: 0, recipients: 2 })
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('rejects a call without the cron secret', async () => {
    expect((await GET(request(null))).status).toBe(401)
    expect(sendReportMock).not.toHaveBeenCalled()
  })

  it('sends the report with the service client and returns its result', async () => {
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect(sendReportMock).toHaveBeenCalledWith(serviceClient)
    expect((await response.json()).data).toEqual({ sent: true, sends: 3, failures: 0, recipients: 2 })
    expect(logMock.error).not.toHaveBeenCalled()
  })

  it('raises an alert when the e-mail fails', async () => {
    sendReportMock.mockResolvedValue({ sent: false, reason: 'send_failed', detail: 'rate limited' })
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect(logMock.error).toHaveBeenCalledWith('peppol daily report: e-mail failed', expect.any(Error), { alert: true })
  })

  it('is a quiet no-op without recipients', async () => {
    sendReportMock.mockResolvedValue({ sent: false, reason: 'no_recipients' })
    expect((await (await GET(request('cron-secret'))).json()).data).toEqual({ sent: false, reason: 'no_recipients' })
    expect(logMock.error).not.toHaveBeenCalled()
  })
})
