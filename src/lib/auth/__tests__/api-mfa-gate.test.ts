import { describe, it, expect } from 'vitest'
import { apiPathSkipsMfaGate } from '@/lib/auth/api-mfa-gate'

describe('apiPathSkipsMfaGate', () => {
  it('skips the gate only on Bearer-auth surfaces when an Authorization header is present', () => {
    expect(apiPathSkipsMfaGate('/api/v1/companies/abc/invoices', true)).toBe(true)
    expect(apiPathSkipsMfaGate('/api/extensions/ext/mcp-server/mcp', true)).toBe(true)
  })

  it('never lets an Authorization header disable the gate on cookie-authenticated routes', () => {
    // A stolen-password AAL1 cookie session must not bypass MFA by attaching
    // a garbage Authorization header the route ignores (Superagent P2, #878).
    expect(apiPathSkipsMfaGate('/api/bookkeeping/journal-entries/123', true)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/reports/full-archive', true)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/salary/employees/1', true)).toBe(false)
    // Non-MCP extension routes authenticate via cookies in the dispatcher.
    expect(apiPathSkipsMfaGate('/api/extensions/ext/invoice-inbox/custom-domain', true)).toBe(false)
  })

  it('does not skip Bearer-auth surfaces without an Authorization header', () => {
    expect(apiPathSkipsMfaGate('/api/v1/companies/abc/invoices', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/extensions/ext/mcp-server/mcp', false)).toBe(false)
  })

  it('skips the gate for the AAL1 escape-hatch and OAuth routes', () => {
    expect(apiPathSkipsMfaGate('/api/account/password', false)).toBe(true)
    expect(apiPathSkipsMfaGate('/api/account/set-password', false)).toBe(true)
    expect(apiPathSkipsMfaGate('/api/company', false)).toBe(true)
    expect(apiPathSkipsMfaGate('/api/company/members', false)).toBe(true)
    expect(apiPathSkipsMfaGate('/api/mcp-oauth/authorize', false)).toBe(true)
    expect(apiPathSkipsMfaGate('/api/mcp-oauth/token', false)).toBe(true)
  })

  it('gates cookie-authenticated calls to sensitive dashboard routes', () => {
    expect(apiPathSkipsMfaGate('/api/bookkeeping/journal-entries/123', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/salary/employees/1', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/reports/full-archive', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/documents/1', false)).toBe(false)
  })

  it('does not let a lookalike prefix bypass the account/company allowlist', () => {
    // "/api/accounts" (plural, a different resource) must NOT match the
    // "/api/account/" escape hatch.
    expect(apiPathSkipsMfaGate('/api/accounts', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/account', false)).toBe(false)
  })

  it('lets the AAL1 session routes through (sign-in, MFA step-up, /me, logout)', () => {
    for (const path of [
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/otp',
      '/api/auth/sso',
      '/api/auth/oauth',
      '/api/auth/anonymous',
      '/api/auth/me',
      '/api/auth/mfa',
      '/api/auth/mfa/verify',
      '/api/auth/mfa/enroll',
      '/api/auth/mfa/unenroll',
    ]) {
      expect(apiPathSkipsMfaGate(path, false)).toBe(true)
    }
  })

  it('keeps the session-token route behind the gate like any data route', () => {
    expect(apiPathSkipsMfaGate('/api/auth/session-token', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/auth/heartbeat', false)).toBe(false)
    // Lookalikes of the exact routes do not match.
    expect(apiPathSkipsMfaGate('/api/auth/login-history', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/auth/me/extra', false)).toBe(false)
    expect(apiPathSkipsMfaGate('/api/auth/mfa-bypass', false)).toBe(false)
  })
})
