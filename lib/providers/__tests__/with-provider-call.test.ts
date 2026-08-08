import { describe, it, expect } from 'vitest'
import {
  classifyProviderError,
  isApiModuleInactiveError,
  ProviderCallError,
} from '../with-provider-call'
import { getErrorEntry } from '@/lib/errors/structured-errors'

/**
 * Locks the classification of provider-client failures into structured codes.
 *
 * The load-bearing case is Visma's 403 `ForbiddenRequestException - No access
 * to module: api_standard` (ErrorCode 4002): the customer's plan lacks the API
 * module, OAuth still succeeds, and re-authorizing loops forever. Before this
 * classification it mapped to PROVIDER_AUTH_EXPIRED ("återanslut"), which sent
 * a real user into exactly that loop and their report into the bug tracker.
 */

const VISMA_MODULE_BODY =
  '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'

/** Mirror of VismaApiError's shape: statusCode + body on a plain Error. */
function vismaError(statusCode: number, body?: string): Error {
  const e = new Error(`Visma API error: ${statusCode}`) as Error & {
    statusCode: number
    body?: string
  }
  e.statusCode = statusCode
  e.body = body
  return e
}

describe('classifyProviderError', () => {
  it('maps a Visma 403 with a "No access to module" body to PROVIDER_API_MODULE_INACTIVE, not AUTH_EXPIRED', () => {
    expect(classifyProviderError(vismaError(403, VISMA_MODULE_BODY))).toBe(
      'PROVIDER_API_MODULE_INACTIVE',
    )
  })

  it('keeps a bare 403 (no module body) as PROVIDER_AUTH_EXPIRED', () => {
    expect(classifyProviderError(vismaError(403))).toBe('PROVIDER_AUTH_EXPIRED')
  })

  it('maps a Fortnox missing-license message to PROVIDER_LICENSE_MISSING', () => {
    expect(classifyProviderError(new Error('token refresh failed: error_missing_license'))).toBe(
      'PROVIDER_LICENSE_MISSING',
    )
  })

  it('maps 429 and 5xx as before', () => {
    expect(classifyProviderError(vismaError(429))).toBe('PROVIDER_RATE_LIMITED')
    expect(classifyProviderError(vismaError(500))).toBe('PROVIDER_UPSTREAM_ERROR')
  })

  it('passes ProviderCallError codes through unchanged', () => {
    const err = new ProviderCallError('PROVIDER_API_MODULE_INACTIVE', 'visma', 'module inactive')
    expect(classifyProviderError(err)).toBe('PROVIDER_API_MODULE_INACTIVE')
  })

  it('returns null for an unclassifiable error', () => {
    expect(classifyProviderError(new Error('boom'))).toBeNull()
    expect(classifyProviderError('not an error')).toBeNull()
  })
})

describe('isApiModuleInactiveError', () => {
  it('matches the Visma module string case-insensitively', () => {
    expect(isApiModuleInactiveError(VISMA_MODULE_BODY)).toBe(true)
    expect(isApiModuleInactiveError('NO ACCESS TO MODULE: api_standard')).toBe(true)
  })

  it('does not match unrelated 403 bodies', () => {
    expect(isApiModuleInactiveError('Forbidden: invalid token')).toBe(false)
  })
})

describe('structured error registry wiring', () => {
  it('PROVIDER_API_MODULE_INACTIVE has a 403 entry with Swedish remediation', () => {
    const entry = getErrorEntry('PROVIDER_API_MODULE_INACTIVE')
    expect(entry).toBeDefined()
    expect(entry!.httpStatus).toBe(403)
    expect(entry!.message_sv).toContain('Appar och tillägg')
    expect(entry!.message_en).toBeTruthy()
  })
})
