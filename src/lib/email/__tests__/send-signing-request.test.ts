import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
vi.mock('@/lib/email/service', () => ({ getEmailService: async () => service }))
const identity = vi.hoisted(() => ({ resolveSigningMailIdentity: vi.fn() }))
vi.mock('@/lib/email/signing-mail-sender', () => identity)

import { sendSigningRequestMail } from '../send-signing-request'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
const params = {
  companyId: 'company-1',
  companyName: 'Arcim Technology AB',
  requester: 'Jakob Wennberg',
  title: 'Testavtal',
  email: 'emil@example.se',
  url: 'https://app.accounted.se/signera/tok_en',
  expiresAt: '2026-11-05T08:18:00.000Z',
  message: null,
  pageCount: 3,
  signerCount: 2,
  log: log as never,
}

beforeEach(() => {
  vi.clearAllMocks()
  service.isConfigured.mockReturnValue(true)
  service.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
  identity.resolveSigningMailIdentity.mockResolvedValue({
    fromName: 'Arcim Technology AB via Accounted',
    fromAddress: null,
    replyTo: null,
    platformName: 'Accounted',
    logo: { src: 'https://storage.example.test/logos/c/logo-1.png', width: 47, height: 48 },
  })
})

describe('sendSigningRequestMail', () => {
  it('mails the link as "<company> via <platform>" with the logo and the document card', async () => {
    expect(await sendSigningRequestMail(params)).toEqual({ emailSent: true })
    expect(identity.resolveSigningMailIdentity).toHaveBeenCalledWith('company-1', 'Arcim Technology AB')
    const [sent] = service.sendEmail.mock.calls[0]!
    expect(sent).toMatchObject({ to: 'emil@example.se', subject: 'Signera: Testavtal', fromName: 'Arcim Technology AB via Accounted' })
    expect(sent.fromAddress).toBeUndefined()
    expect(sent.html).toContain('Jakob Wennberg på Arcim Technology AB ber dig signera ett dokument')
    expect(sent.html).toContain('3 sidor &middot; 2 undertecknare &middot; gäller till 5 november kl. 09:18')
    expect(sent.html).toContain('<img src="https://storage.example.test/logos/c/logo-1.png" width="47" height="48"')
    expect(sent.text).toContain('Läs och signera: https://app.accounted.se/signera/tok_en')
    // The URL carries the token and the address is the signer's: neither is logged.
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('tok_en')
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('@')
  })

  it('marks a reminder in the subject and the heading', async () => {
    await sendSigningRequestMail({ ...params, reminder: true, pageCount: undefined })
    const [sent] = service.sendEmail.mock.calls[0]!
    expect(sent.subject).toBe('Signera: Testavtal (påminnelse)')
    expect(sent.html).toContain('väntar på din underskrift')
    expect(sent.html).toContain('>2 undertecknare &middot; gäller till')
  })

  it('answers emailSent false, and never throws, when the mail does not go out', async () => {
    service.sendEmail.mockResolvedValue({ success: false, error: 'bounced' })
    expect(await sendSigningRequestMail(params)).toEqual({ emailSent: false })
    service.isConfigured.mockReturnValue(false)
    expect(await sendSigningRequestMail(params)).toEqual({ emailSent: false })
    expect(identity.resolveSigningMailIdentity).toHaveBeenCalledTimes(1)
  })
})
