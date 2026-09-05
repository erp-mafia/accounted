import { describe, expect, it } from 'vitest'
import {
  BjornLundenApiError,
  isBjornLundenScopeError,
  isBjornLundenUnknownKeyError,
} from '@/lib/providers/bjornlunden/client'

// Verbatim bodies captured from apigateway.blinfo.se on 2026-09-05: a real
// customer User-Key whose company never activated the integration (403), and
// a made-up key (500). The helpers must keep matching these exact shapes.
const SCOPE_BODY =
  '{"headers":{},"body":{"status":"FORBIDDEN","timestamp":"2026-09-05 03:48:38","message":"Calls to details:READ is out of allowed scope for service provider Arcim ","debugMessage":"Calls to details:READ is out of allowed scope for service provider Arcim ","causeChain":[{"name":"ChainBreakingAuthException","message":"Calls to details:READ is out of allowed scope for service provider Arcim "}]},"statusCode":"FORBIDDEN","statusCodeValue":403}'

const UNKNOWN_KEY_BODY =
  '{"status":"INTERNAL_SERVER_ERROR","timestamp":"2026-09-05 03:49:10","message":"Cannot invoke \\"blaapi.local.domain.User.getCountryCode()\\" because the return value of \\"blaapi.jpa.service.common.ServiceInfo.getCurrentUser()\\" is null"}'

describe('isBjornLundenScopeError', () => {
  it('recognises the live 403 "out of allowed scope" body', () => {
    const err = new BjornLundenApiError('Björn Lunden API error: 403 Forbidden', 403, SCOPE_BODY)
    expect(isBjornLundenScopeError(err)).toBe(true)
  })

  it('is false for a 403 without the scope wording, for other statuses, and for foreign errors', () => {
    expect(isBjornLundenScopeError(new BjornLundenApiError('403', 403, '{"message":"Forbidden"}'))).toBe(false)
    expect(isBjornLundenScopeError(new BjornLundenApiError('403', 403))).toBe(false)
    expect(isBjornLundenScopeError(new BjornLundenApiError('500', 500, SCOPE_BODY))).toBe(false)
    expect(isBjornLundenScopeError(new Error('out of allowed scope'))).toBe(false)
  })
})

describe('isBjornLundenUnknownKeyError', () => {
  it('recognises the live 500 null-current-user body', () => {
    const err = new BjornLundenApiError('Björn Lunden API error: 500', 500, UNKNOWN_KEY_BODY)
    expect(isBjornLundenUnknownKeyError(err)).toBe(true)
  })

  it('is false for a plain 500 outage body and for other statuses', () => {
    expect(isBjornLundenUnknownKeyError(new BjornLundenApiError('500', 500, '{"message":"boom"}'))).toBe(false)
    expect(isBjornLundenUnknownKeyError(new BjornLundenApiError('403', 403, UNKNOWN_KEY_BODY))).toBe(false)
  })
})
