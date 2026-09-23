import { describe, expect, it } from 'vitest'
import { decideBooksGate, BOOKS_PATH } from '../books-gate'

const base = { cookieCompanyId: 'c1', activeCompanyId: 'c1', enabled: true, search: '' }

describe('decideBooksGate', () => {
  it('redirects the dashboard root to the books act while the cookie matches', () => {
    expect(decideBooksGate({ ...base, pathname: '/' })).toEqual({ action: 'redirect', to: BOOKS_PATH })
    expect(decideBooksGate({ ...base, pathname: '/transactions' })).toEqual({ action: 'redirect', to: BOOKS_PATH })
  })

  it('passes when the cookie is missing, stale, or names another company', () => {
    expect(decideBooksGate({ ...base, pathname: '/', cookieCompanyId: null })).toEqual({ action: 'pass' })
    expect(decideBooksGate({ ...base, pathname: '/', cookieCompanyId: 'other' })).toEqual({ action: 'pass' })
    expect(decideBooksGate({ ...base, pathname: '/', activeCompanyId: null })).toEqual({ action: 'pass' })
  })

  it('passes when the feature is switched off', () => {
    expect(decideBooksGate({ ...base, pathname: '/', enabled: false })).toEqual({ action: 'pass' })
  })

  it('never intercepts the act itself, the API, or the account escape hatches', () => {
    for (const p of [BOOKS_PATH, '/onboarding', '/api/import/sie/execute', '/settings/account', '/select-company', '/login', '/auth/callback']) {
      expect(decideBooksGate({ ...base, pathname: p })).toEqual({ action: 'pass' })
    }
  })

  it('rewrites the bank OAuth landing page onto the bank station with its query intact', () => {
    expect(
      decideBooksGate({ ...base, pathname: '/settings/banking', search: '?select_accounts=abc&bank=SEB' }),
    ).toEqual({ action: 'redirect', to: `${BOOKS_PATH}?select_accounts=abc&bank=SEB&station=bank` })
  })

  it('rewrites the import page onto the books station', () => {
    expect(decideBooksGate({ ...base, pathname: '/import', search: '?migration=error&reason=x' })).toEqual({
      action: 'redirect',
      to: `${BOOKS_PATH}?migration=error&reason=x&station=books`,
    })
  })
})
