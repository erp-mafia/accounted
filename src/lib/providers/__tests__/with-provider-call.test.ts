import { describe, it, expect } from 'vitest'
import {
  classifyProviderError,
  fortnoxLoginLicenceRefusal,
  isApiModuleInactiveError,
  isProviderRefusal,
  subscriptionRefusal,
  providerRefusalReason,
  ProviderCallError,
  type ProviderCallErrorCode,
} from '../with-provider-call'
import { FortnoxApiError, fortnoxApiErrorCode } from '../fortnox/client'
import { BokioApiError } from '../bokio/client'
import { VismaApiError } from '../visma/client'
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

/** The live Fortnox answer for a supplier read the account may not make. */
const FORTNOX_SUPPLIER_BODY =
  '{"ErrorInformation":{"Error":1,"Message":"Saknar beh\u00f6righet f\u00f6r leverant\u00f6rsregister.","Code":2003275}}'

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

  it('keeps a bare 403 on the first call of a run as PROVIDER_AUTH_EXPIRED', () => {
    // Nothing has proven the grant yet and the body says nothing: a revoked
    // grant and a closed register look identical, so "reconnect" stays.
    expect(classifyProviderError(vismaError(403))).toBe('PROVIDER_AUTH_EXPIRED')
    expect(classifyProviderError(vismaError(403), { grantProven: false })).toBe(
      'PROVIDER_AUTH_EXPIRED',
    )
  })

  it('reads a bare 403 as PROVIDER_RESOURCE_FORBIDDEN once the run has proven the grant', () => {
    // Bokio sends an empty 403 body. The same token answered an earlier step
    // in this run, so the grant is alive and one register is closed: aborting
    // the run and telling the user to reconnect can never help.
    expect(classifyProviderError(vismaError(403), { grantProven: true })).toBe(
      'PROVIDER_RESOURCE_FORBIDDEN',
    )
  })

  it('reads the Fortnox per-register 403 as PROVIDER_RESOURCE_FORBIDDEN even on the first call', () => {
    // Fortnox answers 401 for a dead token and 403 only for a resource the
    // account may not read, so its own 403 is proof enough. Classified off the
    // typed error, not off the Swedish sentence in the body: the same denial
    // in another locale, or reworded, must classify identically.
    const err = new FortnoxApiError('Fortnox API error: 403', 403, FORTNOX_SUPPLIER_BODY)
    expect(classifyProviderError(err)).toBe('PROVIDER_RESOURCE_FORBIDDEN')

    const localised = new FortnoxApiError(
      'Fortnox API error: 403',
      403,
      '{"ErrorInformation":{"Error":1,"Message":"No permission for the supplier register.","Code":2003275}}',
    )
    expect(classifyProviderError(localised)).toBe('PROVIDER_RESOURCE_FORBIDDEN')

    // Fortnox sometimes answers with no body at all; still a per-resource 403.
    expect(classifyProviderError(new FortnoxApiError('Fortnox API error: 403', 403))).toBe(
      'PROVIDER_RESOURCE_FORBIDDEN',
    )
  })

  it('does not read a Fortnox 401 as a per-resource denial', () => {
    // 401 IS the dead token: the migration must keep aborting on it.
    expect(classifyProviderError(new FortnoxApiError('Fortnox API error: 401', 401))).toBe(
      'PROVIDER_AUTH_EXPIRED',
    )
  })

  it('does not read another provider\'s "saknar behörighet" body as a per-resource denial', () => {
    // The Swedish sentence alone proves nothing: only Fortnox is known to
    // reserve 403 for the resource, and the run's own history covers the rest.
    expect(classifyProviderError(vismaError(403, FORTNOX_SUPPLIER_BODY))).toBe(
      'PROVIDER_AUTH_EXPIRED',
    )
  })

  it('never downgrades a 401: a dead token is a dead token, proven grant or not', () => {
    expect(classifyProviderError(vismaError(401))).toBe('PROVIDER_AUTH_EXPIRED')
    expect(classifyProviderError(vismaError(401), { grantProven: true })).toBe(
      'PROVIDER_AUTH_EXPIRED',
    )
  })

  it('keeps a module/licence 403 fatal even after the grant is proven', () => {
    expect(classifyProviderError(vismaError(403, VISMA_MODULE_BODY), { grantProven: true })).toBe(
      'PROVIDER_API_MODULE_INACTIVE',
    )
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

  it('re-reads a ProviderCallError 403 with the run context mapResponseError lacked', () => {
    const err = new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'bokio', 'Forbidden', {
      status: 403,
    })
    expect(classifyProviderError(err)).toBe('PROVIDER_AUTH_EXPIRED')
    expect(classifyProviderError(err, { grantProven: true })).toBe('PROVIDER_RESOURCE_FORBIDDEN')

    const unauthorized = new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'bokio', 'Unauthorized', {
      status: 401,
    })
    expect(classifyProviderError(unauthorized, { grantProven: true })).toBe('PROVIDER_AUTH_EXPIRED')
  })

  it('returns null for an unclassifiable error', () => {
    expect(classifyProviderError(new Error('boom'))).toBeNull()
    expect(classifyProviderError('not an error')).toBeNull()
  })
})

/**
 * PH 149: GET /3/customers answered HTTP 400 with the lowercase body below on
 * a Fortnox company without Kundfaktura or Order. PH 145: GET /3/suppliers
 * answered 403. Both are a refusal of one register; only their remedy differs.
 */
describe('a Fortnox register refusal', () => {
  const unlicensed = new FortnoxApiError('Fortnox API error: 400 Bad Request', 400,
    '{"ErrorInformation":{"error":1,"message":"Det finns ingen aktiv licens för önskat scope.","code":2001101}}')

  it('reads the error code whichever way Fortnox spells the key', () => {
    expect(fortnoxApiErrorCode(unlicensed)).toBe('2001101')
    expect(fortnoxApiErrorCode(new FortnoxApiError('Fortnox API error: 403', 403, FORTNOX_SUPPLIER_BODY))).toBe('2003275')
    expect(fortnoxApiErrorCode(new FortnoxApiError('Fortnox API error: 400', 400,
      '{"ErrorInformation":{"Error":1,"Message":"Det finns ingen aktiv licens för önskat scope.","Code":2001101}}'))).toBe('2001101')
    expect(fortnoxApiErrorCode(new FortnoxApiError('Fortnox API error: 403', 403))).toBeUndefined()
  })

  it('classifies a missing module licence as a refused register, not as a transient failure', () => {
    expect(classifyProviderError(unlicensed)).toBe('PROVIDER_RESOURCE_FORBIDDEN')
  })

  it('names a missing module licence apart from a missing permission', () => {
    expect(providerRefusalReason(unlicensed)).toBe('license')
    expect(providerRefusalReason(new FortnoxApiError('Fortnox API error: 400', 400,
      '{"ErrorInformation":{"error":1,"message":"Har inte behörighet för scope.","code":2000663}}'))).toBe('permission')
    expect(providerRefusalReason(new FortnoxApiError('Fortnox API error: 403', 403, FORTNOX_SUPPLIER_BODY))).toBe('permission')
    expect(providerRefusalReason(new FortnoxApiError('Fortnox API error: 403', 403))).toBe('permission')
    expect(providerRefusalReason(vismaError(403))).toBe('permission')
  })

  it('reads a register the connecting user may not see as refused under HTTP 400 too (crm#1014)', () => {
    // Fortnox answers some per-register user rights with 400, not 403. The
    // migration job used to read these as unclassified and retry for ever,
    // while the underlag import already called them refusals.
    for (const err of [
      new FortnoxApiError('Fortnox API error: 400', 400,
        '{"ErrorInformation":{"error":1,"message":"Saknar behörighet för leverantörsfaktura.","code":2002182}}'),
      new FortnoxApiError('Fortnox API error: 400', 400,
        '{"ErrorInformation":{"error":1,"message":"Saknar behörighet för kundregister.","code":2001538}}'),
    ]) {
      expect(classifyProviderError(err)).toBe('PROVIDER_RESOURCE_FORBIDDEN')
      expect(providerRefusalReason(err)).toBe('permission')
    }
    // An ordinary 400 stays unclassified.
    expect(classifyProviderError(new FortnoxApiError('Fortnox API error: 400', 400,
      '{"ErrorInformation":{"error":1,"message":"Kan inte hitta kontot.","code":2000423}}'))).toBeNull()
  })

  it('keeps the whole-account API licence apart from a refused register', () => {
    const noApi = new FortnoxApiError('Fortnox API error: 400', 400,
      '{"ErrorInformation":{"error":1,"message":"Api-licens saknas.","code":2001103}}')
    expect(classifyProviderError(noApi)).toBe('PROVIDER_LICENSE_MISSING')
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

  it('every code classifyProviderError can return has a registry entry', () => {
    // A code with no entry falls through entryFor() to INTERNAL_ERROR and the
    // route answers 500 with "Något gick fel", which is how
    // PROVIDER_RESOURCE_FORBIDDEN shipped the first time. Keyed by the union
    // rather than listed in an array, so the next code added to
    // ProviderCallErrorCode fails to compile until it is checked here too.
    const codes: Record<ProviderCallErrorCode, true> = {
      PROVIDER_AUTH_EXPIRED: true,
      PROVIDER_RESOURCE_FORBIDDEN: true,
      PROVIDER_LICENSE_MISSING: true,
      PROVIDER_API_MODULE_INACTIVE: true,
      BOKIO_PLAN_NO_API: true,
      PROVIDER_RATE_LIMITED: true,
      PROVIDER_UNREACHABLE: true,
      PROVIDER_UPSTREAM_ERROR: true,
      PROVIDER_CONFIGURATION_ERROR: true,
    }
    for (const code of Object.keys(codes) as ProviderCallErrorCode[]) {
      const entry = getErrorEntry(code)
      expect(entry, `missing registry entry for ${code}`).toBeDefined()
      expect(entry!.message_sv).toBeTruthy()
      expect(entry!.message_en).toBeTruthy()
    }
  })
})

describe('one reading of a Bokio plan without API access', () => {
  const plan = () => new BokioApiError('Bokio API error: 403 Forbidden', 403, JSON.stringify({ error: 'price_plan_feature_required' }))

  it('is the plan, not a dead token or a closed register: reconnecting cannot change it', () => {
    expect(classifyProviderError(plan())).toBe('BOKIO_PLAN_NO_API')
    expect(classifyProviderError(plan(), { grantProven: true })).toBe('BOKIO_PLAN_NO_API')
  })

  it('leaves another Bokio 403 an ordinary refusal', () => {
    expect(classifyProviderError(new BokioApiError('x', 403, '{"error":"forbidden"}'))).toBe('PROVIDER_AUTH_EXPIRED')
  })
})

describe('isProviderRefusal', () => {
  const fortnox400 = new FortnoxApiError('x', 400, JSON.stringify({ ErrorInformation: { error: 1, message: 'Saknar behörighet för kundregister.', code: 2001538 } }))

  it.each([
    ['a dead token', new VismaApiError('x', 401)],
    ['an opaque 403', new VismaApiError('x', 403)],
    ['a Fortnox refusal under a 400', fortnox400],
    ['an inactive API module', new VismaApiError('x', 403, 'ForbiddenRequestException - No access to module: api_standard')],
    ['a Bokio plan without API access', new BokioApiError('x', 403, '{"error":"price_plan_feature_required"}')],
    ['a connection refused for good', new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'visma', 'refresh refused')],
  ])('%s is a refusal', (_name, error) => {
    expect(isProviderRefusal(error)).toBe(true)
  })

  it.each([
    ['a rate limit', new VismaApiError('x', 429)],
    ['a provider outage', new VismaApiError('x', 503)],
    ['one missing invoice', new VismaApiError('x', 404)],
    ['a Fortnox 400 that refuses nothing', new FortnoxApiError('x', 400, '{"ErrorInformation":{"message":"Ogiltigt datum"}}')],
    ['anything else', new Error('boom')],
  ])('%s is not', (_name, error) => {
    expect(isProviderRefusal(error)).toBe(false)
  })
})

// Fortnox's authorize redirect, as its Errors page documents the two licence
// refusals. The scope one reached two customers as Fortnox's English on
// 2026-11-12: the callback looked for "missing license" with a space.
describe('fortnoxLoginLicenceRefusal', () => {
  it('reads the documented codes exactly', () => {
    expect(fortnoxLoginLicenceRefusal('error_missing_license')).toBe('scope')
    expect(fortnoxLoginLicenceRefusal('error_missing_app_license')).toBe('app')
  })

  it.each(['access_denied', 'invalid_scope', 'missing license', 'ERROR_MISSING_LICENSE', ''])('is null for %j', (error) => {
    expect(fortnoxLoginLicenceRefusal(error)).toBeNull()
  })
})

// A preliminary read (company information) that meets one of these stops the
// door with its sentence: the preview did, and now the register fetch does.
describe('subscriptionRefusal', () => {
  it.each([
    ['an inactive Visma API module', new VismaApiError('x', 403, 'ForbiddenRequestException - No access to module: api_standard'), 'PROVIDER_API_MODULE_INACTIVE'],
    ['a missing Fortnox licence', new Error('token refresh failed: error_missing_license'), 'PROVIDER_LICENSE_MISSING'],
    ['a Bokio plan without API access', new BokioApiError('x', 403, '{"error":"price_plan_feature_required"}'), 'BOKIO_PLAN_NO_API'],
  ] as const)('names %s', (_label, error, code) => {
    expect(subscriptionRefusal(error)).toBe(code)
  })

  it.each([
    ['an opaque 403', new VismaApiError('x', 403)],
    ['a dead token', new VismaApiError('x', 401)],
    ['a network failure', new Error('fetch failed')],
    ['not an error', 'nope'],
  ])('is null for %s: the door carries on as before', (_label, error) => {
    expect(subscriptionRefusal(error)).toBeNull()
  })
})
