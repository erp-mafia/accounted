import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const sendEmailMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ sendEmail: sendEmailMock, isConfigured: () => true }),
}))

const resolveBrandByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandByHost: resolveBrandByHostMock,
  // Imported by lib/email/brand-sender (not called on this path).
  resolveBrandForCompany: vi.fn(),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.gnubok.se' }),
}))

import {
  buildConfirmationUrl,
  sendBankIdSignupConfirmation,
} from '../lib/bankid-confirmation-mail'

function serviceClient(generateLinkResult: unknown) {
  const generateLink = vi.fn().mockResolvedValue(generateLinkResult)
  return {
    generateLink,
    supabase: { auth: { admin: { generateLink } } } as unknown as SupabaseClient,
  }
}

const LINK_OK = { data: { properties: { hashed_token: 'hashed-123' } }, error: null }

beforeEach(() => {
  vi.clearAllMocks()
  resolveBrandByHostMock.mockResolvedValue(null)
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'm-1' })
})

describe('buildConfirmationUrl', () => {
  it('lands on the originating host with the token_hash + magiclink verify pattern', () => {
    expect(buildConfirmationUrl('app.siffra.se', 'https', 'tok')).toBe(
      'https://app.siffra.se/auth/callback?token_hash=tok&type=magiclink',
    )
  })

  it('defaults to https when the proxy did not forward a protocol', () => {
    expect(buildConfirmationUrl('app.siffra.se', null, 'tok')).toMatch(/^https:\/\/app\.siffra\.se\//)
  })

  it('falls back to the canonical app URL without a host', () => {
    expect(buildConfirmationUrl('', undefined, 'tok')).toBe(
      'https://app.gnubok.se/auth/callback?token_hash=tok&type=magiclink',
    )
  })
})

describe('sendBankIdSignupConfirmation', () => {
  it('mints a magic link server-side and mails it to the typed address, never returning the token', async () => {
    const { supabase, generateLink } = serviceClient(LINK_OK)

    const result = await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: 'app.gnubok.se',
      proto: 'https',
    })

    expect(result).toEqual({ ok: true })
    expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'fresh@example.com' })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const mail = sendEmailMock.mock.calls[0][0]
    expect(mail.to).toBe('fresh@example.com')
    expect(mail.subject).toBe('Bekräfta din e-postadress')
    expect(mail.text).toContain(
      'https://app.gnubok.se/auth/callback?token_hash=hashed-123&type=magiclink',
    )
    expect(mail.text).toContain('BankID')
    // Platform sender: no brand on the canonical host.
    expect(mail.fromName).toBeUndefined()
    expect(mail.fromAddress).toBeUndefined()
  })

  it('sends in the brand of the requesting host', async () => {
    resolveBrandByHostMock.mockResolvedValue({
      appName: 'Siffra',
      domain: 'app.siffra.se',
      supportEmail: 'support@siffra.se',
      authEmailFrom: 'noreply@post.siffra.se',
      senderDomainStatus: 'verified',
    })
    const { supabase } = serviceClient(LINK_OK)

    await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: 'app.siffra.se',
      proto: 'https',
    })

    expect(resolveBrandByHostMock).toHaveBeenCalledWith('app.siffra.se')
    const mail = sendEmailMock.mock.calls[0][0]
    expect(mail.fromName).toBe('Siffra')
    expect(mail.fromAddress).toBe('noreply@post.siffra.se')
    expect(mail.replyTo).toBe('support@siffra.se')
    expect(mail.text).toContain('https://app.siffra.se/auth/callback?token_hash=hashed-123')
    expect(mail.html).not.toMatch(/accounted/i)
  })

  it('reports a generateLink failure without sending anything', async () => {
    const { supabase } = serviceClient({ data: null, error: { message: 'link boom', code: 'x' } })

    const result = await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: '',
    })

    expect(result).toEqual({ ok: false, step: 'generate_link', message: 'link boom' })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('reports a send failure so the caller can roll the signup back', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'Email service not configured' })
    const { supabase } = serviceClient(LINK_OK)

    const result = await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: '',
    })

    expect(result).toEqual({ ok: false, step: 'send', message: 'Email service not configured' })
  })
})
