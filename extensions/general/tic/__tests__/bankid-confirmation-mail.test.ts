import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const sendEmailMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ sendEmail: sendEmailMock, isConfigured: () => true }),
}))

const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandByHost: vi.fn(),
  // The one registry read: the trusted-origin resolver classifies the
  // request host through it, and the helper reads the sender brand from it.
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
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

const CANONICAL = 'https://app.gnubok.se'
const BRAND_HOST = 'app.testbrand.example'
const TESTBRAND = {
  appName: 'Testbrand',
  domain: BRAND_HOST,
  supportEmail: 'support@testbrand.example',
  authEmailFrom: 'noreply@post.testbrand.example',
  senderDomainStatus: 'verified',
}

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

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
  process.env.NEXT_PUBLIC_APP_URL = CANONICAL
  // Registry: only the test brand host is registered; everything else is
  // unknown. Both resolvers read the same table.
  resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
    brand: host === BRAND_HOST ? TESTBRAND : null,
    lookupFailed: false,
  }))
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'm-1' })
})

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
})

describe('buildConfirmationUrl', () => {
  it('appends the token_hash + magiclink verify pattern to the resolved origin', () => {
    expect(buildConfirmationUrl('https://app.testbrand.example', 'tok')).toBe(
      'https://app.testbrand.example/auth/callback?token_hash=tok&type=magiclink',
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

  it('links to and sends in the brand of a registered requesting host', async () => {
    const { supabase } = serviceClient(LINK_OK)

    await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: BRAND_HOST,
    })

    expect(resolveBrandResultByHostMock).toHaveBeenCalledWith(BRAND_HOST)
    const mail = sendEmailMock.mock.calls[0][0]
    expect(mail.fromName).toBe('Testbrand')
    expect(mail.fromAddress).toBe('noreply@post.testbrand.example')
    expect(mail.replyTo).toBe('support@testbrand.example')
    expect(mail.text).toContain(
      'https://app.testbrand.example/auth/callback?token_hash=hashed-123',
    )
    expect(mail.html).not.toMatch(/accounted/i)
  })

  it.each([
    ['a spoofed unknown host', 'evil.example'],
    ['a lookalike of a registered host', 'app.testbrand.example.evil.example'],
    ['a registered host on a non-default port', 'app.testbrand.example:8443'],
    ['a credential-bearing host', 'app.testbrand.example@evil.example'],
    ['a missing host', ''],
  ])('sends a canonical link for %s instead of following the header', async (_label, host) => {
    const { supabase } = serviceClient(LINK_OK)

    const result = await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host,
    })

    expect(result).toEqual({ ok: true })
    const mail = sendEmailMock.mock.calls[0][0]
    expect(mail.text).toContain(
      'https://app.gnubok.se/auth/callback?token_hash=hashed-123&type=magiclink',
    )
    expect(mail.text).not.toContain('evil.example')
    expect(mail.text).not.toContain(':8443')
    // Canonical link means canonical sender: brand and destination agree.
    expect(mail.fromName).toBeUndefined()
    expect(mail.fromAddress).toBeUndefined()
  })

  it('refuses before minting a link when the brand registry cannot be read', async () => {
    resolveBrandResultByHostMock.mockResolvedValue({ brand: null, lookupFailed: true })
    const { supabase, generateLink } = serviceClient(LINK_OK)

    const result = await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: BRAND_HOST,
    })

    expect(result).toMatchObject({ ok: false, step: 'resolve_origin' })
    expect(generateLink).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('refuses before minting a link when the brand read fails after the origin resolved', async () => {
    // First read (origin classification) succeeds, second (sender) fails:
    // never platform-branded mail carrying a brand link, and no token minted.
    resolveBrandResultByHostMock
      .mockResolvedValueOnce({ brand: TESTBRAND, lookupFailed: false })
      .mockResolvedValueOnce({ brand: null, lookupFailed: true })
    const { supabase, generateLink } = serviceClient(LINK_OK)

    const result = await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: BRAND_HOST,
    })

    expect(result).toMatchObject({ ok: false, step: 'resolve_origin' })
    expect(generateLink).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('still sends canonical mail when the brand read fails on the canonical origin', async () => {
    resolveBrandResultByHostMock.mockResolvedValue({ brand: null, lookupFailed: true })
    const { supabase } = serviceClient(LINK_OK)

    const result = await sendBankIdSignupConfirmation({
      supabase,
      email: 'fresh@example.com',
      host: 'app.gnubok.se',
    })

    expect(result).toEqual({ ok: true })
    const mail = sendEmailMock.mock.calls[0][0]
    expect(mail.text).toContain('https://app.gnubok.se/auth/callback?token_hash=hashed-123')
    expect(mail.fromName).toBeUndefined()
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
