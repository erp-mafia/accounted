/**
 * A company's own portals: which purchases one belongs to, that it outranks
 * the directory, and the link rule that decides what may be stored.
 */
import { describe, expect, it } from 'vitest'
import { normalizePortalUrl, portalKeyFor, resolvePortal, type CompanyPortal } from '../company-portals'

const TELIA: CompanyPortal = {
  id: 'portal-telia',
  counterparty_key: 'telia sverige',
  vendor_name: 'Telia',
  url: 'https://minasidor.telia.se/foretag',
}

/** A supplier the shared directory does not know, so only the company's portal can answer. */
const ELLEVIO: CompanyPortal = {
  id: 'portal-ellevio',
  counterparty_key: 'ellevio',
  vendor_name: 'Ellevio',
  url: 'https://www.ellevio.se/foretag',
}

describe('portalKeyFor', () => {
  it('folds the same supplier on two dates, and its autogiro row, to one key', () => {
    expect(portalKeyFor('TELIA SVERIGE AB')).toBe('telia sverige')
    expect(portalKeyFor('  TELIA SVERIGE AB ')).toBe('telia sverige')
    expect(portalKeyFor('TELIA SVERIGE AB AUTOGIRO')).toBe('telia sverige')
    expect(portalKeyFor('ELLEVIO AB AUTOGIRO')).toBe('ellevio')
  })

  it('leaves the card rails out of the key', () => {
    expect(portalKeyFor('HETZNER ONLINE GMBH K3667')).toBe('hetzner online')
  })

  it('names nobody when the fold leaves too little', () => {
    expect(portalKeyFor(null)).toBeNull()
    expect(portalKeyFor('   ')).toBeNull()
    expect(portalKeyFor('AB')).toBeNull()
    expect(portalKeyFor('12345678')).toBeNull()
  })
})

describe('resolvePortal', () => {
  it('answers the company portal for every purchase from that supplier', () => {
    for (const descriptor of ['TELIA SVERIGE AB', 'TELIA SVERIGE AB AUTOGIRO', 'Telia Sverige AB faktura 88213344']) {
      expect(resolvePortal([TELIA], descriptor)).toEqual({
        vendor: 'Telia',
        url: 'https://minasidor.telia.se/foretag',
        note: null,
        id: 'portal-telia',
      })
    }
  })

  it('matches whole words only', () => {
    expect(resolvePortal([ELLEVIO], 'ELLEVIOAB AUTOGIRO')).toBeNull()
    expect(resolvePortal([{ ...ELLEVIO, counterparty_key: 'ell' }], 'ELLEVIO AB AUTOGIRO')).toBeNull()
  })

  it('falls back to the directory, with no id, when the company has none', () => {
    expect(resolvePortal([TELIA], 'HETZNER ONLINE GMBH K3667')).toEqual({
      vendor: 'Hetzner',
      url: 'https://accounts.hetzner.com/invoice',
      note: null,
      id: null,
    })
    expect(resolvePortal([], 'ELLEVIO AB AUTOGIRO')).toBeNull()
  })

  it('puts the company portal before the directory', () => {
    const own: CompanyPortal = { id: 'p-h', counterparty_key: 'hetzner online', vendor_name: 'Hetzner', url: 'https://accounts.hetzner.com/invoice/list' }
    expect(resolvePortal([own], 'HETZNER ONLINE GMBH K3667')?.id).toBe('p-h')
  })

  it('takes the longest key when two company portals match', () => {
    const broad: CompanyPortal = { id: 'p-broad', counterparty_key: 'telia', vendor_name: 'Telia', url: 'https://telia.se' }
    expect(resolvePortal([broad, TELIA], 'TELIA SVERIGE AB')?.id).toBe('portal-telia')
    expect(resolvePortal([TELIA, broad], 'TELIA COMPANY')?.id).toBe('p-broad')
  })

  it('never gives salary or tax a portal, even a matching one', () => {
    const lon: CompanyPortal = { id: 'p-lon', counterparty_key: 'lon juli', vendor_name: 'Lön', url: 'https://x.se' }
    expect(resolvePortal([lon], 'Lön Juli Jakob')).toBeNull()
    expect(resolvePortal([TELIA], 'Skatt lön Juni BG 0000050501055')).toBeNull()
    expect(resolvePortal([TELIA], null)).toBeNull()
  })
})

describe('normalizePortalUrl', () => {
  const ok = (url: string) => ({ ok: true, url })

  it('adds https to a link pasted without a scheme', () => {
    expect(normalizePortalUrl('minasidor.telia.se/foretag')).toEqual(ok('https://minasidor.telia.se/foretag'))
    expect(normalizePortalUrl('  ellevio.se  ')).toEqual(ok('https://ellevio.se'))
    expect(normalizePortalUrl('//ellevio.se/mina-sidor')).toEqual(ok('https://ellevio.se/mina-sidor'))
    expect(normalizePortalUrl('portal.example.se:8443/fakturor')).toEqual(ok('https://portal.example.se:8443/fakturor'))
  })

  it('drops the query string, where sessions and one-time tokens ride', () => {
    expect(normalizePortalUrl('minasidor.telia.se/foretag?session=abc')).toEqual(ok('https://minasidor.telia.se/foretag'))
    expect(normalizePortalUrl('https://x.example.se/a?token=1&b=2#top')).toEqual(ok('https://x.example.se/a#top'))
  })

  it('keeps the path and the fragment a hash-routed portal needs', () => {
    expect(normalizePortalUrl('https://admin.microsoft.com/#/billing/bills-payments/invoices')).toEqual(
      ok('https://admin.microsoft.com/#/billing/bills-payments/invoices'),
    )
    expect(normalizePortalUrl('HTTPS://Minasidor.Telia.SE/Foretag')).toEqual(ok('https://minasidor.telia.se/Foretag'))
  })

  it('refuses every other scheme', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'http://minasidor.telia.se',
      'ftp://files.example.se',
      'mailto:faktura@telia.se',
      'file:///etc/passwd',
    ]) {
      expect(normalizePortalUrl(bad), bad).toEqual({ ok: false })
    }
  })

  it('refuses a user name or password in the link', () => {
    expect(normalizePortalUrl('https://user:pass@minasidor.telia.se')).toEqual({ ok: false })
    expect(normalizePortalUrl('user@minasidor.telia.se')).toEqual({ ok: false })
  })

  it('refuses a host without a dot, whitespace, and nothing at all', () => {
    for (const bad of ['localhost', 'https://localhost:3000', 'https://telia.', 'minasidor telia.se', '', '   ', null, undefined]) {
      expect(normalizePortalUrl(bad as string), String(bad)).toEqual({ ok: false })
    }
  })

  it('refuses a link longer than 2048 characters', () => {
    expect(normalizePortalUrl(`https://x.example.se/${'a'.repeat(2048)}`)).toEqual({ ok: false })
    const longest = `https://x.example.se/${'a'.repeat(2048 - 'https://x.example.se/'.length)}`
    expect(normalizePortalUrl(longest)).toEqual(ok(longest))
  })
})
