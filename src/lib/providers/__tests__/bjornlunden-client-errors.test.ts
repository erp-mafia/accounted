import { describe, expect, it } from 'vitest'
import { BjornLundenApiError, isBjornLundenScopeError } from '@/lib/providers/bjornlunden/client'

// Verbatim body captured from apigateway.blinfo.se on 2026-09-05 for a real
// customer User-Key whose company never activated the integration. The helper
// must keep matching this exact shape.
const SCOPE_BODY =
  '{"headers":{},"body":{"status":"FORBIDDEN","timestamp":"2026-09-05 03:48:38","message":"Calls to details:READ is out of allowed scope for service provider Arcim ","debugMessage":"Calls to details:READ is out of allowed scope for service provider Arcim ","causeChain":[{"name":"ChainBreakingAuthException","message":"Calls to details:READ is out of allowed scope for service provider Arcim "}]},"statusCode":"FORBIDDEN","statusCodeValue":403}'

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
