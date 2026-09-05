import { describe, it, expect, beforeEach } from 'vitest'
import {
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

  it('lets the sanctioned company-switch action through while in flight', () => {
    expect(
      shouldBlockMutation({
        ...mismatch,
        method: 'POST',
        url: '/clients',
        isServerAction: true,
        companySwitchInFlight: true,
      }),
    ).toBe(false)
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
