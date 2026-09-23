import { describe, it, expect, afterEach, vi } from 'vitest'
import { createEmailService, resolveEmailProvider } from '../lib/email-provider'
import { ResendEmailService } from '../lib/resend-service'
import { SmtpEmailService } from '../lib/smtp-service'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveEmailProvider', () => {
  it('defaults to resend when nothing is configured (unconfigured = no-op, as before)', () => {
    vi.stubEnv('EMAIL_PROVIDER', '')
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('SMTP_HOST', '')
    expect(resolveEmailProvider()).toBe('resend')
    expect(createEmailService()).toBeInstanceOf(ResendEmailService)
  })

  it('picks smtp from SMTP_HOST when no Resend key exists (self-host path)', () => {
    vi.stubEnv('EMAIL_PROVIDER', '')
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('SMTP_HOST', 'smtp.example.se')
    expect(resolveEmailProvider()).toBe('smtp')
    expect(createEmailService()).toBeInstanceOf(SmtpEmailService)
  })

  // Hosted stays hosted: SMTP variables on the side never move mail.
  it('keeps Resend when both are present', () => {
    vi.stubEnv('EMAIL_PROVIDER', '')
    vi.stubEnv('RESEND_API_KEY', 're_x')
    vi.stubEnv('SMTP_HOST', 'smtp.example.se')
    expect(resolveEmailProvider()).toBe('resend')
  })

  it('honours EMAIL_PROVIDER as the explicit choice, case-insensitively', () => {
    vi.stubEnv('RESEND_API_KEY', 're_x')
    vi.stubEnv('EMAIL_PROVIDER', ' SMTP ')
    expect(resolveEmailProvider()).toBe('smtp')
    vi.stubEnv('EMAIL_PROVIDER', 'resend')
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('SMTP_HOST', 'smtp.example.se')
    expect(resolveEmailProvider()).toBe('resend')
  })

  it('ignores an unknown EMAIL_PROVIDER value', () => {
    vi.stubEnv('EMAIL_PROVIDER', 'sendgrid')
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('SMTP_HOST', 'smtp.example.se')
    expect(resolveEmailProvider()).toBe('smtp')
  })
})
