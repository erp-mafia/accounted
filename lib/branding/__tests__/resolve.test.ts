import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// Holder assigned in beforeEach; the mock factory closes over it so each test
// gets a fresh queued client without re-mocking the module.
const serviceClient = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => serviceClient.current),
}))

import {
  resolveBrandByHost,
  resolveBrandForCompany,
  deriveChromeColor,
  getEffectiveChrome,
  isBrandColorAccessible,
  normalizeHost,
  clearBrandCache,
} from '@/lib/branding/resolve'

const brandRow = {
  id: 'brand-1',
  team_id: 'team-1',
  domain: 'app.siffra.se',
  app_name: 'Siffra',
  logo_url: null,
  favicon_url: null,
  brand_color: '#2563eb',
  chrome_color: null,
  font_key: 'default',
  support_email: 'support@siffra.se',
  auth_email_from: null,
  sender_domain: null,
  sender_domain_status: 'unverified',
  resend_domain_id: null,
}

let mock: ReturnType<typeof createQueuedMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  clearBrandCache()
  mock = createQueuedMockSupabase()
  serviceClient.current = mock.supabase
})

afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeHost', () => {
  it('lowercases and strips port and trailing dot', () => {
    expect(normalizeHost('APP.SIFFRA.SE:3000')).toBe('app.siffra.se')
    expect(normalizeHost(' app.siffra.se. ')).toBe('app.siffra.se')
    expect(normalizeHost('app.siffra.se')).toBe('app.siffra.se')
  })
})

describe('resolveBrandByHost', () => {
  it('resolves a brand row and maps it to the camelCase Brand shape', async () => {
    mock.enqueue({ data: brandRow })

    const brand = await resolveBrandByHost('app.siffra.se')

    expect(brand).toEqual({
      id: 'brand-1',
      teamId: 'team-1',
      domain: 'app.siffra.se',
      appName: 'Siffra',
      logoUrl: null,
      faviconUrl: null,
      brandColor: '#2563eb',
      chromeColor: null,
      fontKey: 'default',
      supportEmail: 'support@siffra.se',
      authEmailFrom: null,
      senderDomain: null,
      senderDomainStatus: 'unverified',
      resendDomainId: null,
    })
    expect(mock.findCall('brands', 'eq')).toEqual(['domain', 'app.siffra.se'])
  })

  it('normalizes the host before lookup and shares the cache entry across variants', async () => {
    mock.enqueue({ data: brandRow })

    const first = await resolveBrandByHost('APP.SIFFRA.SE:3000')
    expect(first?.domain).toBe('app.siffra.se')
    expect(mock.findCall('brands', 'eq')).toEqual(['domain', 'app.siffra.se'])

    const second = await resolveBrandByHost('app.siffra.se')
    expect(second?.id).toBe('brand-1')
    // Cache hit: only the first call reached the database.
    expect(mock.supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns null for unknown hosts and caches the miss', async () => {
    mock.enqueue({ data: null })

    expect(await resolveBrandByHost('app.gnubok.se')).toBeNull()
    expect(await resolveBrandByHost('app.gnubok.se')).toBeNull()
    expect(mock.supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns null without touching the database for an empty host', async () => {
    expect(await resolveBrandByHost('')).toBeNull()
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('expires cache entries after the TTL', async () => {
    vi.useFakeTimers()
    mock.enqueueMany([{ data: brandRow }, { data: brandRow }])

    await resolveBrandByHost('app.siffra.se')
    vi.advanceTimersByTime(59_000)
    await resolveBrandByHost('app.siffra.se')
    expect(mock.supabase.from).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    await resolveBrandByHost('app.siffra.se')
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })

  it('does not cache a query error, so the next call retries', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })

    expect(await resolveBrandByHost('app.siffra.se')).toBeNull()

    mock.enqueue({ data: brandRow })
    const brand = await resolveBrandByHost('app.siffra.se')
    expect(brand?.id).toBe('brand-1')
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })
})

describe('resolveBrandForCompany', () => {
  it('resolves companies.team_id -> brands.team_id', async () => {
    mock.enqueueMany([{ data: { team_id: 'team-1' } }, { data: brandRow }])

    const brand = await resolveBrandForCompany('company-1')

    expect(brand?.teamId).toBe('team-1')
    expect(mock.findCall('companies', 'eq')).toEqual(['id', 'company-1'])
    expect(mock.findCall('brands', 'eq')).toEqual(['team_id', 'team-1'])
  })

  it('returns null and caches when the company has no team', async () => {
    mock.enqueue({ data: { team_id: null } })

    expect(await resolveBrandForCompany('company-1')).toBeNull()
    expect(await resolveBrandForCompany('company-1')).toBeNull()
    // One from('companies') call total; never reached brands.
    expect(mock.supabase.from).toHaveBeenCalledTimes(1)
    expect(mock.findCall('brands', 'eq')).toBeUndefined()
  })

  it('returns null when the company does not exist', async () => {
    mock.enqueue({ data: null })

    expect(await resolveBrandForCompany('missing')).toBeNull()
  })

  it('returns null when the team has no brand, and caches per company key', async () => {
    mock.enqueueMany([{ data: { team_id: 'team-9' } }, { data: null }])

    expect(await resolveBrandForCompany('company-9')).toBeNull()
    expect(await resolveBrandForCompany('company-9')).toBeNull()
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })
})

describe('deriveChromeColor', () => {
  it('derives a deterministic deep chrome tone from the brand color', () => {
    expect(deriveChromeColor('#2563eb')).toBe('#1c263b')
    expect(deriveChromeColor('#2563eb')).toBe('#1c263b')
    expect(deriveChromeColor('#dc2626')).toBe('#3b1c1c')
    expect(deriveChromeColor('#304D83')).toBe('#1c273b')
  })

  it('keeps near-achromatic brand colors neutral instead of tinting them red', () => {
    // Pure gray input: saturating to 30% would produce a dark red (hue 0).
    expect(deriveChromeColor('#1a1a1a')).toBe('#262626')
  })

  it('always emits a six-digit lowercase hex color', () => {
    for (const input of ['#ffffff', '#000000', '#00ff00', '#ABCDEF']) {
      expect(deriveChromeColor(input)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('throws on invalid input (format is CHECK-enforced upstream)', () => {
    expect(() => deriveChromeColor('blue')).toThrow(/Invalid hex color/)
  })
})

describe('getEffectiveChrome', () => {
  it('prefers the explicit chrome_color override', () => {
    expect(getEffectiveChrome({ brandColor: '#2563eb', chromeColor: '#101418' })).toBe('#101418')
  })

  it('derives from the brand color when no override is set', () => {
    expect(getEffectiveChrome({ brandColor: '#2563eb', chromeColor: null })).toBe('#1c263b')
  })
})

describe('isBrandColorAccessible', () => {
  it('accepts colors where white text clears 4.5:1', () => {
    expect(isBrandColorAccessible('#1a1a1a')).toBe(true)
    expect(isBrandColorAccessible('#2563eb')).toBe(true)
  })

  it('rejects colors where white text fails 4.5:1', () => {
    expect(isBrandColorAccessible('#ffff00')).toBe(false)
    expect(isBrandColorAccessible('#ffffff')).toBe(false)
  })

  it('rejects invalid hex strings instead of throwing', () => {
    expect(isBrandColorAccessible('blue')).toBe(false)
    expect(isBrandColorAccessible('#12345')).toBe(false)
    expect(isBrandColorAccessible('')).toBe(false)
  })
})

describe('clearBrandCache', () => {
  it('forces the next resolution back to the database', async () => {
    mock.enqueueMany([{ data: brandRow }, { data: brandRow }])

    await resolveBrandByHost('app.siffra.se')
    clearBrandCache()
    await resolveBrandByHost('app.siffra.se')

    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })
})
