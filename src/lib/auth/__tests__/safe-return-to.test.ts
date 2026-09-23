import { describe, it, expect } from 'vitest'
import { safeReturnTo } from '../safe-return-to'

describe('safeReturnTo', () => {
  it('returns the value when it is a same-origin relative path', () => {
    expect(safeReturnTo('/settings/account', '/')).toBe('/settings/account')
    expect(safeReturnTo('/invoices/new', '/')).toBe('/invoices/new')
  })

  it('preserves search and hash', () => {
    expect(safeReturnTo('/invoices?status=overdue', '/')).toBe('/invoices?status=overdue')
    expect(safeReturnTo('/settings/account#mfa', '/')).toBe('/settings/account#mfa')
  })

  it('returns the fallback for missing or empty values', () => {
    expect(safeReturnTo(null, '/home')).toBe('/home')
    expect(safeReturnTo(undefined, '/home')).toBe('/home')
    expect(safeReturnTo('', '/home')).toBe('/home')
  })

  it('rejects absolute URLs', () => {
    expect(safeReturnTo('https://evil.com/path', '/')).toBe('/')
    expect(safeReturnTo('http://evil.com', '/')).toBe('/')
  })

  it('rejects protocol-relative URLs', () => {
    expect(safeReturnTo('//evil.com/path', '/')).toBe('/')
  })

  it('rejects the /\\evil.com browser-quirk form', () => {
    expect(safeReturnTo('/\\evil.com', '/')).toBe('/')
  })

  it('rejects the /@user@host form some clients resolve off-origin', () => {
    expect(safeReturnTo('/@evil.com', '/')).toBe('/')
  })

  it('rejects values that do not start with /', () => {
    expect(safeReturnTo('settings', '/')).toBe('/')
    expect(safeReturnTo('javascript:alert(1)', '/')).toBe('/')
  })

  it('rejects dot segments that normalise into a protocol-relative URL', () => {
    // The raw input starts with a single '/', so the prefix guards let it
    // through, and it resolves against the sentinel origin, so the origin
    // check lets it through too. But URL normalisation collapses it to
    // '//evil.com', which navigates off-origin the moment a caller uses it
    // as a bare href (window.location.assign / router.push).
    expect(safeReturnTo('/..//evil.com', '/')).toBe('/')
    expect(safeReturnTo('/.//evil.com', '/')).toBe('/')
    expect(safeReturnTo('/a/../..//evil.com', '/')).toBe('/')
    expect(safeReturnTo('/../\\evil.com', '/')).toBe('/')
    expect(safeReturnTo('/..//evil.com?x=1', '/')).toBe('/')
  })

  it('rejects the percent-encoded spelling of those dot segments', () => {
    expect(safeReturnTo('/%2e%2e//evil.com', '/')).toBe('/')
    expect(safeReturnTo('/%2E%2E//evil.com', '/')).toBe('/')
  })

  it('rejects dot segments that normalise into the /@ form', () => {
    // The raw-input rule rejects '/@evil.com' outright, but dot-segment
    // resolution can smuggle it past that guard: '/a/../@evil.com' starts
    // with an innocent '/a' yet normalises to '/@evil.com'. The
    // post-normalisation check must reject every prefix the raw check does.
    expect(safeReturnTo('/a/../@evil.com', '/')).toBe('/')
    expect(safeReturnTo('/.//@evil.com', '/')).toBe('/')
    expect(safeReturnTo('/%2e%2e/@evil.com', '/')).toBe('/')
    expect(safeReturnTo('/a/../@evil.com?x=1', '/')).toBe('/')
  })

  it('still allows ordinary dot segments that stay on-origin', () => {
    expect(safeReturnTo('/settings/../invoices', '/')).toBe('/invoices')
    expect(safeReturnTo('/./settings/tax', '/')).toBe('/settings/tax')
  })

  it('keeps percent-encoded slashes, which are path data and stay on-origin', () => {
    expect(safeReturnTo('/%2F%2Fevil.com', '/')).toBe('/%2F%2Fevil.com')
  })

  it('rejects data: URIs', () => {
    expect(safeReturnTo('data:text/html,<script>alert(1)</script>', '/')).toBe('/')
    expect(safeReturnTo('data:,', '/')).toBe('/')
  })
})
