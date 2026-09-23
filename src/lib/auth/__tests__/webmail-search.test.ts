import { describe, it, expect } from 'vitest'
import { detectWebmailHint } from '../webmail-search'

const FROM = 'noreply@gnubok.se'

describe('detectWebmailHint', () => {
  it('returns Gmail with a pre-populated search for gmail.com', () => {
    const hint = detectWebmailHint('user@gmail.com', FROM)
    expect(hint).not.toBeNull()
    expect(hint!.id).toBe('gmail')
    expect(hint!.name).toBe('Gmail')
    expect(hint!.hasSearch).toBe(true)
    expect(hint!.url).toBe(
      `https://mail.google.com/mail/u/0/#search/${encodeURIComponent('from:noreply@gnubok.se')}`,
    )
  })

  it('also handles googlemail.com as Gmail', () => {
    const hint = detectWebmailHint('user@googlemail.com', FROM)
    expect(hint!.id).toBe('gmail')
    expect(hint!.hasSearch).toBe(true)
  })

  it('detects Outlook variants (outlook.com, hotmail.com, live.com, msn.com)', () => {
    for (const domain of ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.se']) {
      const hint = detectWebmailHint(`user@${domain}`, FROM)
      expect(hint?.id, domain).toBe('outlook')
      expect(hint?.hasSearch, domain).toBe(false)
      expect(hint?.url, domain).toBe('https://outlook.live.com/mail/0/inbox')
    }
  })

  it('detects Yahoo variants', () => {
    for (const domain of ['yahoo.com', 'yahoo.co.uk', 'yahoo.se', 'ymail.com']) {
      const hint = detectWebmailHint(`user@${domain}`, FROM)
      expect(hint?.id, domain).toBe('yahoo')
      expect(hint?.hasSearch, domain).toBe(false)
    }
  })

  it('detects iCloud variants (icloud.com, me.com, mac.com)', () => {
    for (const domain of ['icloud.com', 'me.com', 'mac.com']) {
      const hint = detectWebmailHint(`user@${domain}`, FROM)
      expect(hint?.id, domain).toBe('icloud')
      expect(hint?.hasSearch, domain).toBe(false)
    }
  })

  it('detects Proton variants', () => {
    for (const domain of ['proton.me', 'protonmail.com', 'pm.me']) {
      const hint = detectWebmailHint(`user@${domain}`, FROM)
      expect(hint?.id, domain).toBe('proton')
      expect(hint?.hasSearch, domain).toBe(false)
    }
  })

  it('is case-insensitive on the domain', () => {
    const hint = detectWebmailHint('User@GMAIL.COM', FROM)
    expect(hint?.id).toBe('gmail')
  })

  it('returns null for unknown / custom domains', () => {
    expect(detectWebmailHint('me@mycompany.com', FROM)).toBeNull()
    expect(detectWebmailHint('me@example.org', FROM)).toBeNull()
  })

  it('returns null for malformed email input', () => {
    expect(detectWebmailHint('not-an-email', FROM)).toBeNull()
    expect(detectWebmailHint('', FROM)).toBeNull()
    expect(detectWebmailHint('@gmail.com', FROM)).not.toBeNull()
    expect(detectWebmailHint('user@', FROM)).toBeNull()
  })

  it('URL-encodes the sender address (handles special characters)', () => {
    const hint = detectWebmailHint('user@gmail.com', 'no+reply@gnubok.se')
    expect(hint!.url).toContain(encodeURIComponent('from:no+reply@gnubok.se'))
  })
})
