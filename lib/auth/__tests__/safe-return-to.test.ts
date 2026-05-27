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

  it('rejects data: URIs', () => {
    expect(safeReturnTo('data:text/html,<script>alert(1)</script>', '/')).toBe('/')
    expect(safeReturnTo('data:,', '/')).toBe('/')
  })
})
