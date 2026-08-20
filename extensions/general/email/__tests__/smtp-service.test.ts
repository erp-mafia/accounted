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

const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_EMAIL', 'SMTP_TLS_REJECT_UNAUTHORIZED'] as const

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
    expect(readSmtpSettings()).toMatchObject({ port: 587, secure: false, rejectUnauthorized: true, user: null })
    vi.stubEnv('SMTP_SECURE', 'true')
    expect(readSmtpSettings()).toMatchObject({ port: 465, secure: true })
    vi.stubEnv('SMTP_PORT', '2525')
    expect(readSmtpSettings()?.port).toBe(2525)
  })

  it('reads credentials and the TLS override', () => {
    configure({ SMTP_USER: 'relay', SMTP_PASS: 's3cret', SMTP_TLS_REJECT_UNAUTHORIZED: 'false' })
    expect(readSmtpSettings()).toMatchObject({ user: 'relay', pass: 's3cret', rejectUnauthorized: false })
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

  it('builds the transport from the settings (auth only when a user is set)', async () => {
    configure()
    await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.se',
      port: 587,
      secure: false,
      tls: { rejectUnauthorized: true },
    })

    resetSmtpTransportForTests()
    configure({ SMTP_USER: 'relay', SMTP_PASS: 'pw', SMTP_SECURE: 'true' })
    await new SmtpEmailService().sendEmail({ to: 'a@b.se', subject: 's', html: '<p/>' })
    expect(createTransportMock).toHaveBeenLastCalledWith({
      host: 'smtp.example.se',
      port: 465,
      secure: true,
      auth: { user: 'relay', pass: 'pw' },
      tls: { rejectUnauthorized: true },
    })
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
    expect(mail.from).toBe('Nordvik ByggX-Injected: 1 via Accounted evilBcc: x <faktura@example.se>')
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
