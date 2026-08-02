/**
 * From-header composition in the Resend service, including the WL-04 chain:
 * explicit fromAddress (verified brand domain) > "via" fallback > default.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

const sendMock = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock }
  },
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

// DEFAULT_FROM_EMAIL is read at module load, so env must be set before the
// dynamic import below.
let service: import('../lib/resend-service').ResendEmailService

beforeAll(async () => {
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.RESEND_FROM_EMAIL = 'noreply@gnubok.se'
  const mod = await import('../lib/resend-service')
  service = new mod.ResendEmailService()
})

beforeEach(() => {
  vi.clearAllMocks()
  sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null })
})

const BASE = { to: 'user@example.se', subject: 'Test', html: '<p>Hej</p>' }

describe('ResendEmailService From composition', () => {
  it('sends from the platform default without fromName', async () => {
    await service.sendEmail(BASE)
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Accounted <noreply@gnubok.se>' }),
    )
  })

  it('renders the via-platform pattern for fromName without fromAddress', async () => {
    await service.sendEmail({ ...BASE, fromName: 'Siffra' })
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Siffra via Accounted <noreply@gnubok.se>' }),
    )
  })

  it('rides the brand address when fromAddress is set (verified brand domain)', async () => {
    await service.sendEmail({
      ...BASE,
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
    })
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Siffra <noreply@post.siffra.se>' }),
    )
  })

  it('keeps the company display name on a brand address (invoice mail shape)', async () => {
    await service.sendEmail({
      ...BASE,
      fromName: 'Kund AB',
      fromAddress: 'noreply@post.siffra.se',
    })
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Kund AB <noreply@post.siffra.se>' }),
    )
  })

  it('uses the bare address when fromAddress is set without fromName', async () => {
    await service.sendEmail({ ...BASE, fromAddress: 'noreply@post.siffra.se' })
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'noreply@post.siffra.se' }),
    )
  })

  it('sanitizes header injection attempts in name and address parts', async () => {
    await service.sendEmail({
      ...BASE,
      fromName: 'Evil\r\nName',
      fromAddress: 'noreply@post.siffra.se>\r\n<evil@x.se',
    })
    const from = sendMock.mock.calls[0][0].from as string
    expect(from).not.toMatch(/[\r\n]/)
    // The injected angle brackets are stripped; only the wrapper pair remains.
    expect(from.match(/</g)).toHaveLength(1)
    expect(from.match(/>/g)).toHaveLength(1)
  })
})
