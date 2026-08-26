/**
 * The directory turns a bank descriptor into a page where the invoice lives.
 * What must not happen: sending someone to a portal for a salary run, guessing
 * a vendor from a fragment, or pointing a cloud bill at the wrong Google page.
 */
import { describe, it, expect } from 'vitest'
import { PORTAL_DIRECTORY, lookupPortal } from '../portal-directory'

describe('lookupPortal', () => {
  it('reads a card descriptor the bank has mangled', () => {
    // Real strings from a production ledger.
    expect(lookupPortal('OPENAI  CHATGPT SUBSCR')?.vendor).toBe('OpenAI')
    expect(lookupPortal('Kortköp 260228 HETZNER ONLINE GMBH')?.vendor).toBe('Hetzner')
  })

  it('prefers the longer alias, so a cloud bill is not sent to Workspace', () => {
    expect(lookupPortal('GOOGLE CLOUD 6ZZS77')?.vendor).toBe('Google Cloud')
    expect(lookupPortal('GOOGLE WORKSPACE REDOV')?.vendor).toBe('Google Workspace')
  })

  it('never offers a portal for a payment that has no invoice', () => {
    // A salary run has nothing to fetch, and a link would be worse than
    // silence: it implies somewhere to go.
    expect(lookupPortal('Lön Juli Jakob Överföring via internet')).toBeNull()
    expect(lookupPortal('Inbetalning skat BG 0000050501055')).toBeNull()
    expect(lookupPortal('Skatt lön Juni BG 0000050501055')).toBeNull()
  })

  it('says nothing about a supplier that emails its invoices', () => {
    // The bar is "does not send the invoice", not "also has a portal".
    // Anthropic, Vercel and Supabase all mail theirs to European customers, so
    // pointing somebody at a login sends them away from the document.
    expect(lookupPortal('ANTHROPIC* CLAUDE SUB SAN FRANCISCO')).toBeNull()
    expect(lookupPortal('Vercel Jul Överföring via internet')).toBeNull()
    expect(lookupPortal('SUPABASE PRO SUBSCRIPTION')).toBeNull()
  })

  it('says nothing about a supplier it does not know', () => {
    expect(lookupPortal('ALVIKS KOETT OCH FISK K3667')).toBeNull()
    expect(lookupPortal('RESTAURANG RIDD K3667 Kortköp/uttag')).toBeNull()
  })

  it('handles an empty or missing descriptor', () => {
    expect(lookupPortal(null)).toBeNull()
    expect(lookupPortal('')).toBeNull()
    expect(lookupPortal('   ')).toBeNull()
  })
})

describe('the directory itself', () => {
  it('sends everyone to a real https page', () => {
    // A wrong URL is worse than a missing one: it spends the trust the
    // feature runs on.
    for (const entry of PORTAL_DIRECTORY) {
      expect(() => new URL(entry.url)).not.toThrow()
      expect(entry.url.startsWith('https://')).toBe(true)
    }
  })

  it('gives every entry something to match on', () => {
    for (const entry of PORTAL_DIRECTORY) {
      expect(entry.aliases.length).toBeGreaterThan(0)
      for (const alias of entry.aliases) {
        expect(alias).toBe(alias.toLowerCase())
        // Two characters would match half the mailbox.
        expect(alias.length).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('does not name two vendors the same thing', () => {
    const names = PORTAL_DIRECTORY.map((e) => e.vendor)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps aliases distinct, so a lookup cannot be ambiguous', () => {
    const seen = new Map<string, string>()
    for (const entry of PORTAL_DIRECTORY) {
      for (const alias of entry.aliases) {
        expect(seen.has(alias)).toBe(false)
        seen.set(alias, entry.vendor)
      }
    }
  })
})
