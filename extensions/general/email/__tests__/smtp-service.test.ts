import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sendMailMock = vi.fn()
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }))
vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => createTransportMock(...(args as [])) },
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted <evil>\r\nBcc: x' }),
}))

import {
  SmtpEmailService,
  readSmtpSettings,
  resetSmtpTransportForTests,
} from '../lib/smtp-service'

const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_EMAIL', 'SMTP_TLS_REJECT_UNAUTHORIZED', 'SMTP_REQUIRE_TLS'] as const

beforeEach(() => {
  vi.clearAllMocks()
  resetSmtpTransportForTests()
  for (const k of ENV) vi.stubEnv(k, '')
  sendMailMock.mockResolvedValue({ messageId: '<abc@relay>' })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

function configure(overrides: Partial<Record<(typeof ENV)[number], string>> = {}) {
  vi.stubEnv('SMTP_HOST', 'smtp.example.se')
  vi.stubEnv('SMTP_FROM_EMAIL', 'faktura@example.se')
  for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v)
}

describe('readSmtpSettings', () => {
  it('is null without host + from (the minimum)', () => {
    expect(readSmtpSettings()).toBeNull()
    vi.stubEnv('SMTP_HOST', 'smtp.example.se')
    expect(readSmtpSettings()).toBeNull()
  })

  it('defaults to STARTTLS on 587 and implicit TLS on 465 when SMTP_SECURE=true', () => {
    configure()
    expect(readSmtpSettings()).toMatchObject({ port: 587, secure: false, rejectUnauthorized: true, requireTLS: true, user: null })
    vi.stubEnv('SMTP_SECURE', 'true')
    expect(readSmtpSettings()).toMatchObject({ port: 465, secure: true })
    vi.stubEnv('SMTP_PORT', '2525')
    expect(readSmtpSettings()?.port).toBe(2525)
  })

  it('reads credentials and the TLS overrides', () => {
    configure({ SMTP_USER: 'relay', SMTP_PASS: 's3cret', SMTP_TLS_REJECT_UNAUTHORIZED: 'false', SMTP_REQUIRE_TLS: 'false' })
    expect(readSmtpSettings()).toMatchObject({ user: 'relay', pass: 's3cret', rejectUnauthorized: false, requireTLS: false })
  })
})

describe('SmtpEmailService', () => {
  it('reports not configured and sends nothing without settings', async () => {
    const svc = new SmtpEmailService()
    expect(svc.isConfigured()).toBe(false)
    const result = await svc.sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(result).toEqual({ success: false, error: 'Email service is not configured' })
    expect(createTransportMock).not.toHaveBeenCalled()
  })

  it('builds the transport from the settings (auth only when a user is set, STARTTLS required by default)', async () => {
    configure()
    await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    // requireTLS: nodemailer's default is opportunistic STARTTLS, which a
    // STARTTLS-stripping on-path attacker downgrades to cleartext AUTH + mail.
    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.se',
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
    })

    resetSmtpTransportForTests()
    configure({ SMTP_USER: 'relay', SMTP_PASS: 'pw', SMTP_SECURE: 'true' })
    await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(createTransportMock).toHaveBeenLastCalledWith({
      host: 'smtp.example.se',
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: 'relay', pass: 'pw' },
      tls: { rejectUnauthorized: true },
    })
  })

  it('lets SMTP_REQUIRE_TLS=false opt a plaintext LAN relay out of mandatory STARTTLS', async () => {
    configure({ SMTP_REQUIRE_TLS: 'false' })
    await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: false }),
    )
  })

  // Same From shape and the same header-injection defence as the Resend
  // service: CR/LF and angle brackets never reach the header.
  it('builds the From header like Resend does and strips injection characters', async () => {
    configure()
    const result = await new SmtpEmailService().sendEmail({
      to: ['a@b.se', 'c@d.se'],
      cc: 'e@f.se',
      subject: 'Faktura 1001',
      html: '<p>Hej</p>',
      text: 'Hej',
      replyTo: 'svar@example.se',
      fromName: 'Nordvik <Bygg>\r\nX-Injected: 1',
      attachments: [
        { filename: 'f.pdf', content: Buffer.from('PDF').toString('base64'), contentType: 'application/pdf' },
        { filename: 'g.pdf', content: Buffer.from('PDF2') },
      ],
    })
    expect(result).toEqual({ success: true, provider: 'smtp', messageId: '<abc@relay>' })
    const mail = sendMailMock.mock.calls[0][0]
    // The colon in the sanitized name makes RFC 5322 require quoting, as in Resend.
    expect(mail.from).toBe('"Nordvik ByggX-Injected: 1" <faktura@example.se>')
    expect(mail.from).not.toMatch(/[\r\n<>].*</)
    expect(mail.to).toEqual(['a@b.se', 'c@d.se'])
    expect(mail.cc).toEqual(['e@f.se'])
    expect(mail.bcc).toBeUndefined()
    expect(mail.replyTo).toBe('svar@example.se')
    expect(mail.attachments[0]).toMatchObject({ filename: 'f.pdf', contentType: 'application/pdf' })
    expect(Buffer.isBuffer(mail.attachments[0].content)).toBe(true)
    expect(mail.attachments[0].content.toString()).toBe('PDF')
    expect(mail.attachments[1].content.toString()).toBe('PDF2')
  })

  it('sends from the company sender when options.from is given, with the same injection guard', async () => {
    configure()
    const service = new SmtpEmailService()
    await service.sendEmail({
      to: 'a@b.se',
      subject: 'Faktura 1002',
      html: '<p>Hej</p>',
      fromName: 'ignored when from is explicit',
      from: { name: 'Nordvik Bygg AB', address: ' Faktura@Nordvik.se ' },
    })
    expect(sendMailMock.mock.calls[0][0].from).toBe('Nordvik Bygg AB <faktura@nordvik.se>')

    await service.sendEmail({
      to: 'a@b.se',
      subject: 'Faktura 1003',
      html: '<p>Hej</p>',
      from: { name: 'Nordvik, Bygg <AB>\r\nBcc: x', address: 'faktura@nordvik.se' },
    })
    const injected = sendMailMock.mock.calls[1][0].from
    expect(injected).toBe('"Nordvik, Bygg ABBcc: x" <faktura@nordvik.se>')
    expect(injected).not.toMatch(/[\r\n<>].*</)
  })

  it('falls back to the platform sender when options.from is malformed', async () => {
    configure()
    await new SmtpEmailService().sendEmail({
      to: 'a@b.se',
      subject: 'Faktura 1004',
      html: '<p>Hej</p>',
      fromName: 'Nordvik',
      from: { name: 'Nordvik', address: 'not an address' },
    })
    expect(sendMailMock.mock.calls[0][0].from).toBe('Nordvik <faktura@example.se>')
    expect(sendMailMock).toHaveBeenCalledTimes(1)
  })

  it('uses the app name alone as the platform sender when no fromName is given', async () => {
    configure()
    await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(sendMailMock.mock.calls[0][0].from).toBe('"Accounted evilBcc: x" <faktura@example.se>')
  })

  // Same shape as the Resend service for a VERIFIED brand sender domain
  // (fromAddress is only set by lib/email/brand-sender.ts).
  it('sends as the brand sender when fromAddress is set and retries as the platform sender if refused', async () => {
    configure()
    const service = new SmtpEmailService()
    await service.sendEmail({
      to: 'a@b.se',
      subject: 'Faktura 1006',
      html: '<p>Hej</p>',
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
    })
    expect(sendMailMock.mock.calls[0][0].from).toBe('Siffra <noreply@post.siffra.se>')
    expect(sendMailMock).toHaveBeenCalledTimes(1)

    sendMailMock.mockRejectedValueOnce(new Error('5.7.60 SMTP; Client does not have permissions to send as this sender'))
    const result = await service.sendEmail({
      to: 'a@b.se',
      subject: 'Faktura 1007',
      html: '<p>Hej</p>',
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
    })
    expect(result).toEqual({ success: true, provider: 'smtp', messageId: '<abc@relay>' })
    expect(sendMailMock).toHaveBeenCalledTimes(3)
    expect(sendMailMock.mock.calls[1][0].from).toBe('Siffra <noreply@post.siffra.se>')
    expect(sendMailMock.mock.calls[2][0].from).toBe('Siffra <faktura@example.se>')
  })

  it('strips header injection attempts from fromName and fromAddress', async () => {
    configure()
    await new SmtpEmailService().sendEmail({
      to: 'a@b.se',
      subject: 'Faktura 1008',
      html: '<p>Hej</p>',
      fromName: 'Evil\r\nName',
      fromAddress: 'noreply@post.siffra.se>\r\n<evil@x.se',
    })
    const from = sendMailMock.mock.calls[0][0].from as string
    expect(from).not.toMatch(/[\r\n]/)
    // The injected angle brackets are stripped; only the wrapper pair remains.
    expect(from.match(/</g)).toHaveLength(1)
    expect(from.match(/>/g)).toHaveLength(1)
    expect(from).toBe('EvilName <noreply@post.siffra.seevil@x.se>')
  })

  it('retries once as the platform sender when the relay refuses the company sender', async () => {
    configure()
    sendMailMock.mockRejectedValueOnce(new Error('5.7.60 SMTP; Client does not have permissions to send as this sender'))
    const result = await new SmtpEmailService().sendEmail({
      to: 'a@b.se',
      subject: 'Faktura 1005',
      html: '<p>Hej</p>',
      fromName: 'Nordvik',
      from: { name: 'Nordvik Bygg AB', address: 'faktura@nordvik.se' },
    })
    expect(result).toEqual({ success: true, provider: 'smtp', messageId: '<abc@relay>' })
    expect(sendMailMock).toHaveBeenCalledTimes(2)
    expect(sendMailMock.mock.calls[0][0].from).toBe('Nordvik Bygg AB <faktura@nordvik.se>')
    expect(sendMailMock.mock.calls[1][0].from).toBe('Nordvik <faktura@example.se>')
  })

  it('does not retry when the platform sender itself is refused', async () => {
    configure()
    sendMailMock.mockRejectedValueOnce(new Error('421 relay busy'))
    const result = await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 'x', html: 'x', fromName: 'Nordvik' })
    expect(result).toEqual({ success: false, provider: 'smtp', error: '421 relay busy' })
    expect(sendMailMock).toHaveBeenCalledTimes(1)
  })

  it('reuses one transport across sends and rebuilds it when settings change', async () => {
    configure()
    const svc = new SmtpEmailService()
    await svc.sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    await svc.sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(createTransportMock).toHaveBeenCalledTimes(1)
    vi.stubEnv('SMTP_PORT', '2525')
    await svc.sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(createTransportMock).toHaveBeenCalledTimes(2)
  })

  it('returns the relay error instead of throwing', async () => {
    configure()
    sendMailMock.mockRejectedValueOnce(new Error('535 Authentication failed'))
    const result = await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(result).toEqual({ success: false, provider: 'smtp', error: '535 Authentication failed' })
  })
})
