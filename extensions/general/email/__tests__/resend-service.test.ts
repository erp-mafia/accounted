import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events'
import {
  buildFromHeader,
  encodeDisplayName,
  ResendEmailService,
} from '@/extensions/general/email/lib/resend-service'

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

const { sendMock } = vi.hoisted(() => {
  // RESEND_FROM_EMAIL / RESEND_API_KEY are read at module load; set them
  // before the service module is evaluated.
  process.env.RESEND_FROM_EMAIL = 'noreply@platform.example'
  process.env.RESEND_API_KEY = 'test-key'
  return { sendMock: vi.fn() }
})

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock }
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('buildFromHeader', () => {
  it('renders the platform default with the company name "via" the app', () => {
    expect(buildFromHeader({ fromName: 'Hans Bolag AB' })).toBe(
      'Hans Bolag AB via Accounted <noreply@platform.example>',
    )
  })

  it('renders the bare app sender without a company name', () => {
    expect(buildFromHeader({})).toBe('Accounted <noreply@platform.example>')
  })

  it('renders an explicit sender as "<name> <address>" with no "via"', () => {
    expect(
      buildFromHeader({ fromName: 'ignored', from: { name: 'Hans Bolag AB', address: 'faktura@hansbolag.example' } }),
    ).toBe('Hans Bolag AB <faktura@hansbolag.example>')
  })

  it('strips header-injection characters from the explicit name', () => {
    expect(
      buildFromHeader({ from: { name: 'Hans <Bolag>\r\nBcc: x', address: 'faktura@hansbolag.example' } }),
    ).toBe('"Hans BolagBcc: x" <faktura@hansbolag.example>') // CR/LF/<> stripped; ':' forces quoting
  })

  it('quotes a display name only when it carries RFC 5322 specials, escaping quotes and backslashes', () => {
    expect(encodeDisplayName('Hans Bolag AB')).toBe('Hans Bolag AB')
    expect(encodeDisplayName('Hans "Bolag", AB')).toBe('"Hans \\"Bolag\\", AB"')
    expect(encodeDisplayName('Back\\slash')).toBe('"Back\\\\slash"')
    expect(buildFromHeader({ from: { name: 'Hans Bolag, AB', address: 'faktura@hansbolag.example' } })).toBe(
      '"Hans Bolag, AB" <faktura@hansbolag.example>',
    )
    // Platform path: a comma in the company name used to yield an ambiguous
    // mailbox list; plain names are byte-identical to before.
    expect(buildFromHeader({ fromName: 'Hans Bolag, AB' })).toBe(
      '"Hans Bolag, AB via Accounted" <noreply@platform.example>',
    )
  })

  it('falls back to the platform sender when the explicit address is malformed', () => {
    expect(buildFromHeader({ fromName: 'Hans Bolag AB', from: { name: 'Hans', address: 'not an address' } })).toBe(
      'Hans Bolag AB via Accounted <noreply@platform.example>',
    )
    expect(buildFromHeader({ fromName: 'Hans Bolag AB', from: { name: '   ', address: 'faktura@hansbolag.example' } })).toBe(
      'Hans Bolag AB via Accounted <noreply@platform.example>',
    )
  })
})

describe('ResendEmailService.sendEmail', () => {
  const service = new ResendEmailService()
  const base = { to: 'kund@example.com', subject: 'Faktura 1', html: '<p>x</p>', fromName: 'Hans Bolag AB' }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    sendMock.mockReset()
  })

  it('sends once as the platform sender when no explicit From is given', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_1' }, error: null })
    const result = await service.sendEmail(base)
    expect(result).toEqual({ success: true, provider: 'resend', messageId: 'msg_1' })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0].from).toBe('Hans Bolag AB via Accounted <noreply@platform.example>')
  })

  it('sends as the company sender when Resend accepts it', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_2' }, error: null })
    const result = await service.sendEmail({
      ...base,
      from: { name: 'Hans Bolag AB', address: 'faktura@hansbolag.example' },
    })
    expect(result.success).toBe(true)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0].from).toBe('Hans Bolag AB <faktura@hansbolag.example>')
  })

  it('retries once as the platform sender when Resend rejects the company sender', async () => {
    sendMock
      .mockResolvedValueOnce({ data: null, error: { message: 'The hansbolag.example domain is not verified' } })
      .mockResolvedValueOnce({ data: { id: 'msg_3' }, error: null })
    const result = await service.sendEmail({
      ...base,
      from: { name: 'Hans Bolag AB', address: 'faktura@hansbolag.example' },
    })
    expect(result).toEqual({ success: true, provider: 'resend', messageId: 'msg_3' })
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock.mock.calls[0][0].from).toBe('Hans Bolag AB <faktura@hansbolag.example>')
    expect(sendMock.mock.calls[1][0].from).toBe('Hans Bolag AB via Accounted <noreply@platform.example>')
    // Same recipients and content on the retry.
    expect(sendMock.mock.calls[1][0].to).toEqual(['kund@example.com'])
    expect(sendMock.mock.calls[1][0].subject).toBe('Faktura 1')
  })

  it('does not retry a platform-sender failure (nothing to fall back to)', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'invalid recipient' } })
    const result = await service.sendEmail(base)
    expect(result).toEqual({ success: false, provider: 'resend', error: 'invalid recipient' })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('reports the platform-sender error when the fallback also fails', async () => {
    sendMock
      .mockResolvedValueOnce({ data: null, error: { message: 'domain not verified' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'rate limited' } })
    const result = await service.sendEmail({
      ...base,
      from: { name: 'Hans Bolag AB', address: 'faktura@hansbolag.example' },
    })
    expect(result).toEqual({ success: false, provider: 'resend', error: 'rate limited' })
    expect(sendMock).toHaveBeenCalledTimes(2)
  })
})
