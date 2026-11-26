import { describe, it, expect, beforeEach } from 'vitest'
import {
  ACTIVE_COMPANY_HEADER,
  COMPANY_SWITCH_PATH,
  TAB_COMPANY_HEADER,
  companyObservedFromResponse,
  isSameOriginApiUrl,
  shouldRefuseForTabCompany,
  withTabCompanyHeader,
  decodeStorageValue,
  encodeStorageValue,
  guardBrowserWrite,
  guardStore,
  isTabMismatch,
  markCompanySwitchInFlight,
  markSelfSwitchTarget,
  requestHasNextActionHeader,
  resolveObservedCompanyName,
  shouldBlockMutation,
} from '../tab-guard'

const ORIGIN = 'http://localhost:3000'

describe('encode/decodeStorageValue', () => {
  it('round-trips a company id', () => {
    expect(decodeStorageValue(encodeStorageValue('company-2'))).toBe('company-2')
  })

  it('reads malformed payloads as unknown', () => {
    expect(decodeStorageValue(null)).toBeNull()
    expect(decodeStorageValue('not json')).toBeNull()
    expect(decodeStorageValue(JSON.stringify({ companyId: 42 }))).toBeNull()
  })
})

describe('isTabMismatch', () => {
  it('mismatches only on positive evidence of a different company', () => {
    expect(isTabMismatch('company-1', 'company-2')).toBe(true)
    expect(isTabMismatch('company-1', 'company-1')).toBe(false)
  })

  it('never mismatches on unknown observations', () => {
    expect(isTabMismatch('company-1', null)).toBe(false)
    expect(isTabMismatch('company-1', undefined)).toBe(false)
  })

  it('never mismatches when the tab has no company', () => {
    expect(isTabMismatch(null, 'company-2')).toBe(false)
  })
})

describe('shouldBlockMutation', () => {
  const mismatch = {
    pageOrigin: ORIGIN,
    tabCompanyId: 'company-1',
    observedCompanyId: 'company-2',
  }

  it('blocks a mutating same-origin /api request from a stale tab', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(
        shouldBlockMutation({ ...mismatch, method, url: '/api/invoices' }),
      ).toBe(true)
    }
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: `${ORIGIN}/api/transactions/tx-1/categorize`,
      }),
    ).toBe(true)
  })

  it('never blocks reads', () => {
    expect(
      shouldBlockMutation({ ...mismatch, method: 'GET', url: '/api/invoices' }),
    ).toBe(false)
    expect(
      shouldBlockMutation({ ...mismatch, method: undefined, url: '/api/invoices' }),
    ).toBe(false)
  })

  it('never blocks while tab and active company agree', () => {
    expect(
      shouldBlockMutation({
        pageOrigin: ORIGIN,
        tabCompanyId: 'company-1',
        observedCompanyId: 'company-1',
        method: 'POST',
        url: '/api/invoices',
      }),
    ).toBe(false)
  })

  it('never blocks on unknown active company (no positive evidence)', () => {
    expect(
      shouldBlockMutation({
        pageOrigin: ORIGIN,
        tabCompanyId: 'company-1',
        observedCompanyId: null,
        method: 'POST',
        url: '/api/invoices',
      }),
    ).toBe(false)
  })

  it('only guards same-origin /api paths for plain fetches', () => {
    // Cross-origin (e.g. browser-direct Supabase) is outside the seam.
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: 'https://xyz.supabase.co/rest/v1/transactions',
      }),
    ).toBe(false)
    // A plain (non-action) POST to a page route is not guarded.
    expect(
      shouldBlockMutation({ ...mismatch, method: 'POST', url: '/clients' }),
    ).toBe(false)
    // Prefix trickery: /apiary is not /api/.
    expect(
      shouldBlockMutation({ ...mismatch, method: 'POST', url: '/apiary/things' }),
    ).toBe(false)
  })

  it('blocks a server-action POST to a page route from a stale tab', () => {
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: '/transactions',
        isServerAction: true,
      }),
    ).toBe(true)
  })

  it('lets the sanctioned company switch through while in flight, and nothing else', () => {
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: COMPANY_SWITCH_PATH,
        companySwitchInFlight: true,
      }),
    ).toBe(false)
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: `${ORIGIN}${COMPANY_SWITCH_PATH}`,
        companySwitchInFlight: true,
      }),
    ).toBe(false)
    // Without the flag the switch route is an ordinary /api mutation.
    expect(
      shouldBlockMutation({ ...mismatch, method: 'POST', url: COMPANY_SWITCH_PATH }),
    ).toBe(true)
    // The flag opens only the switch route: another write racing the switch
    // stays blocked.
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: '/api/invoices',
        companySwitchInFlight: true,
      }),
    ).toBe(true)
  })

  it('never lets a server action through, even while the switch is in flight', () => {
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: '/clients',
        isServerAction: true,
        companySwitchInFlight: true,
      }),
    ).toBe(true)
  })

  it('never blocks a server action while tab and active company agree', () => {
    expect(
      shouldBlockMutation({
        pageOrigin: ORIGIN,
        tabCompanyId: 'company-1',
        observedCompanyId: 'company-1',
        method: 'POST',
        url: '/clients',
        isServerAction: true,
      }),
    ).toBe(false)
  })

  it('never blocks a cross-origin request even with the action marker', () => {
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: 'https://evil.example/steal',
        isServerAction: true,
      }),
    ).toBe(false)
  })
})

describe('requestHasNextActionHeader', () => {
  it('detects the header on init.headers as a plain record (Next 16 shape)', () => {
    expect(
      requestHasNextActionHeader('/clients', {
        headers: { Accept: 'text/x-component', 'Next-Action': 'abc123' },
      }),
    ).toBe(true)
    expect(
      requestHasNextActionHeader('/clients', { headers: { 'next-action': 'abc123' } }),
    ).toBe(true)
  })

  it('detects the header on Headers instances and entry arrays', () => {
    expect(
      requestHasNextActionHeader('/clients', {
        headers: new Headers({ 'Next-Action': 'abc123' }),
      }),
    ).toBe(true)
    expect(
      requestHasNextActionHeader('/clients', { headers: [['Next-Action', 'abc123']] }),
    ).toBe(true)
  })

  it('detects the header on a Request input when init has none', () => {
    const req = new Request('http://localhost/clients', {
      method: 'POST',
      headers: { 'Next-Action': 'abc123' },
    })
    expect(requestHasNextActionHeader(req)).toBe(true)
  })

  it('is false for ordinary requests', () => {
    expect(requestHasNextActionHeader('/api/invoices')).toBe(false)
    expect(
      requestHasNextActionHeader('/api/invoices', {
        headers: { 'Content-Type': 'application/json' },
      }),
    ).toBe(false)
    expect(requestHasNextActionHeader(new URL('http://localhost/x'))).toBe(false)
  })
})

describe('markSelfSwitchTarget', () => {
  it('sets and clears the self-switch marker on the store', () => {
    markSelfSwitchTarget('company-2')
    expect(guardStore.selfSwitchTargetId).toBe('company-2')
    markSelfSwitchTarget(null)
    expect(guardStore.selfSwitchTargetId).toBeNull()
  })
})

describe('guardBrowserWrite', () => {
  beforeEach(() => {
    guardStore.tabCompanyId = null
    guardStore.observedCompanyId = null
    guardStore.notifyBlocked = null
    markCompanySwitchInFlight(false)
  })

  it('allows the write when tab and observation agree (or nothing observed)', () => {
    guardStore.tabCompanyId = 'company-1'
    expect(guardBrowserWrite()).toBe(true)
    guardStore.observedCompanyId = 'company-1'
    expect(guardBrowserWrite()).toBe(true)
  })

  it('refuses the write and raises the dialog on positive mismatch evidence', () => {
    let notified = 0
    guardStore.tabCompanyId = 'company-1'
    guardStore.observedCompanyId = 'company-2'
    guardStore.notifyBlocked = () => {
      notified += 1
    }
    expect(guardBrowserWrite()).toBe(false)
    expect(notified).toBe(1)
  })

  it('allows the write when no guard is mounted (no tab belief)', () => {
    expect(guardBrowserWrite()).toBe(true)
  })
})

describe('resolveObservedCompanyName', () => {
  const companies = [
    { company: { id: 'c-arcim', name: 'Arcim Technology AB' } },
    { company: { id: 'c-demo', name: 'Demo AB' } },
  ]
  const foreign = [{ id: 'c-byra', name: 'Klientbolaget AB' }]

  it('names a company from the switcher list', () => {
    expect(resolveObservedCompanyName('c-demo', companies, foreign)).toBe('Demo AB')
  })

  it('names a company homed on another host from the signpost list', () => {
    expect(resolveObservedCompanyName('c-byra', companies, foreign)).toBe('Klientbolaget AB')
  })

  it('is null for unknown ids and for no observation, so the dialog keeps its unnamed wording', () => {
    expect(resolveObservedCompanyName('c-elsewhere', companies, foreign)).toBeNull()
    expect(resolveObservedCompanyName(null, companies, foreign)).toBeNull()
    expect(resolveObservedCompanyName(undefined, companies)).toBeNull()
  })
})

describe('header names', () => {
  it('are the wire names', () => {
    expect(TAB_COMPANY_HEADER).toBe('x-tab-company-id')
    expect(ACTIVE_COMPANY_HEADER).toBe('x-active-company-id')
  })
})

describe('isSameOriginApiUrl', () => {
  it('accepts relative and absolute same-origin /api/ urls', () => {
    expect(isSameOriginApiUrl('/api/invoices', ORIGIN)).toBe(true)
    expect(isSameOriginApiUrl(`${ORIGIN}/api/invoices?x=1`, ORIGIN)).toBe(true)
  })

  it('rejects other origins, other paths and /api itself', () => {
    expect(isSameOriginApiUrl('https://example.com/api/invoices', ORIGIN)).toBe(false)
    expect(isSameOriginApiUrl('/invoices', ORIGIN)).toBe(false)
    expect(isSameOriginApiUrl('/apix/invoices', ORIGIN)).toBe(false)
    expect(isSameOriginApiUrl('/api', ORIGIN)).toBe(false)
  })
})

describe('withTabCompanyHeader', () => {
  const opts = { tabCompanyId: 'company-1', pageOrigin: ORIGIN }
  const headerOf = (init: RequestInit | undefined, name: string) =>
    new Headers(init?.headers).get(name)

  it('labels a string input', () => {
    const out = withTabCompanyHeader('/api/invoices', { method: 'POST' }, opts)
    expect(out.input).toBe('/api/invoices')
    expect(out.init?.method).toBe('POST')
    expect(headerOf(out.init, TAB_COMPANY_HEADER)).toBe('company-1')
  })

  it('labels a URL input without init', () => {
    const out = withTabCompanyHeader(new URL(`${ORIGIN}/api/x`), undefined, opts)
    expect(headerOf(out.init, TAB_COMPANY_HEADER)).toBe('company-1')
  })

  it('carries the headers of a Request input when init sets none', () => {
    const request = new Request(`${ORIGIN}/api/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Other': 'a' },
    })
    const out = withTabCompanyHeader(request, undefined, opts)
    expect(out.input).toBe(request)
    expect(headerOf(out.init, TAB_COMPANY_HEADER)).toBe('company-1')
    expect(headerOf(out.init, 'content-type')).toBe('application/json')
    expect(headerOf(out.init, 'x-other')).toBe('a')
  })

  it('keeps the caller headers of a Headers init', () => {
    const out = withTabCompanyHeader('/api/x', { headers: new Headers({ 'X-A': '1' }) }, opts)
    expect(headerOf(out.init, 'x-a')).toBe('1')
    expect(headerOf(out.init, TAB_COMPANY_HEADER)).toBe('company-1')
  })

  it('keeps the caller headers of an entries-array init', () => {
    const out = withTabCompanyHeader('/api/x', { headers: [['X-A', '1'], ['X-B', '2']] }, opts)
    expect(headerOf(out.init, 'x-a')).toBe('1')
    expect(headerOf(out.init, 'x-b')).toBe('2')
    expect(headerOf(out.init, TAB_COMPANY_HEADER)).toBe('company-1')
  })

  it('keeps the caller headers of a record init', () => {
    const out = withTabCompanyHeader('/api/x', { headers: { 'X-A': '1' } }, opts)
    expect(headerOf(out.init, 'x-a')).toBe('1')
    expect(headerOf(out.init, TAB_COMPANY_HEADER)).toBe('company-1')
  })

  it('keeps a company header the caller set itself', () => {
    const out = withTabCompanyHeader('/api/x', { headers: { [TAB_COMPANY_HEADER]: 'company-9' } }, opts)
    expect(headerOf(out.init, TAB_COMPANY_HEADER)).toBe('company-9')
  })

  it('leaves cross-origin and non-api requests alone', () => {
    const init = { method: 'POST' }
    expect(withTabCompanyHeader('https://example.com/api/x', init, opts).init).toBe(init)
    expect(withTabCompanyHeader('/dashboard', init, opts).init).toBe(init)
    expect(withTabCompanyHeader(new Request('https://example.com/api/x'), undefined, opts).init).toBeUndefined()
  })

  it('leaves everything alone when the tab has no company', () => {
    const init = { method: 'POST' }
    expect(withTabCompanyHeader('/api/x', init, { ...opts, tabCompanyId: null }).init).toBe(init)
  })
})

describe('companyObservedFromResponse', () => {
  const base = {
    tabCompanyId: 'company-1',
    companySwitchInFlight: false,
    selfSwitchTargetId: null,
  }

  it('returns the company the server acted on when it differs from the tab', () => {
    expect(companyObservedFromResponse({ ...base, responseCompanyId: 'company-2' })).toBe('company-2')
  })

  it('returns null when it matches the tab', () => {
    expect(companyObservedFromResponse({ ...base, responseCompanyId: 'company-1' })).toBeNull()
  })

  it('returns null when the response carries no header', () => {
    expect(companyObservedFromResponse({ ...base, responseCompanyId: null })).toBeNull()
    expect(companyObservedFromResponse({ ...base, responseCompanyId: '' })).toBeNull()
  })

  it('returns null while this tab switches company', () => {
    expect(
      companyObservedFromResponse({ ...base, responseCompanyId: 'company-2', companySwitchInFlight: true }),
    ).toBeNull()
    expect(
      companyObservedFromResponse({ ...base, responseCompanyId: 'company-2', selfSwitchTargetId: 'company-2' }),
    ).toBeNull()
  })

  it('returns null for a tab with no company', () => {
    expect(companyObservedFromResponse({ ...base, tabCompanyId: null, responseCompanyId: 'company-2' })).toBeNull()
  })
})

describe('shouldRefuseForTabCompany', () => {
  const base = {
    method: 'POST',
    pathname: '/api/invoices',
    tabCompanyHeader: 'company-2',
    activeCompanyId: 'company-1',
  }

  it('refuses a write naming another company than the active one', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(shouldRefuseForTabCompany({ ...base, method })).toBe(true)
    }
  })

  it('allows a write naming the active company', () => {
    expect(shouldRefuseForTabCompany({ ...base, tabCompanyHeader: 'company-1' })).toBe(false)
  })

  it('allows a write without the header', () => {
    expect(shouldRefuseForTabCompany({ ...base, tabCompanyHeader: null })).toBe(false)
    expect(shouldRefuseForTabCompany({ ...base, tabCompanyHeader: undefined })).toBe(false)
    expect(shouldRefuseForTabCompany({ ...base, tabCompanyHeader: '  ' })).toBe(false)
  })

  it('never refuses reads', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(shouldRefuseForTabCompany({ ...base, method })).toBe(false)
    }
  })

  it('never refuses the company switch', () => {
    expect(shouldRefuseForTabCompany({ ...base, pathname: COMPANY_SWITCH_PATH })).toBe(false)
  })
})
