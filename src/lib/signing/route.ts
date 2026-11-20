/**
 * The two doors of the signer's side (./ceremony.ts):
 *
 *   - withSignerToken: /api/signera/[token]. The link is the authentication,
 *     so every route resolves the token first. No session, no supabase.auth;
 *     the service role reads the rows; a general per-token budget and a poll
 *     budget of its own bound a leaked link; the clear token is never logged
 *     (the logger gets the signer id). Every way a token fails answers the
 *     same 404. The posture of the payment signing link
 *     (lib/payments/orders/signing-link-route.ts), kept here because the
 *     ledger kernel imports no block.
 *   - withMemberSigner: /api/signing/me/[signerId]. A logged-in member signs a
 *     request addressed to them without the mailed link (re-minting a link
 *     would stop the mailed one and any signing in progress). withRouteContext
 *     (MFA, the session) without requireWrite: a board member who is a viewer
 *     still signs. The signer row names the company, not the active company.
 */
import { randomUUID } from 'node:crypto'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isUuid } from '@/lib/invariants/uuid'
import { createLogger, type Logger } from '@/lib/logger'
import { resolveMemberSigner, resolveSignerByToken, type SignerScope } from './ceremony'

// 60 requests per signer per 10 minutes for what a sitting does by hand (the
// page, the document, a few starts); the poll the flow makes once a second
// while BankID is open has its own budget. Process-local, like the payment
// signing link's limiters.
const generalLimiter = createTokenRateLimiter({ max: 60, windowMs: 10 * 60_000 })
const pollLimiter = createTokenRateLimiter({ max: 900, windowMs: 10 * 60_000 })

export interface SignerRouteContext {
  scope: SignerScope
  log: Logger
  requestId: string
}

export interface SignerRouteOptions {
  limiter?: 'general' | 'poll'
}

export type SignerRouteHandler<P> = (request: Request, ctx: SignerRouteContext, params: P) => Promise<Response>

function limiterFor(options: SignerRouteOptions) {
  return options.limiter === 'poll' ? pollLimiter : generalLimiter
}

export function withSignerToken<P extends { token: string }>(operation: string, options: SignerRouteOptions, handler: SignerRouteHandler<P>) {
  return async (request: Request, { params }: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID()
    const log = createLogger('signera', { requestId, operation })
    const resolvedParams = await params
    const token = resolvedParams.token
    try {
      if (!limiterFor(options).allow(`token:${token}`)) return errorResponseFromCode('RATE_LIMITED', log, { requestId, reason: 'signing token over its budget' })
      const service = createServiceClientNoCookies()
      const resolved = await resolveSignerByToken(service, token)
      if (!resolved.ok) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: `signing token ${resolved.reason}` })
      const signerLog = log.child({ companyId: resolved.request.company_id, signingRequestId: resolved.request.id, signerId: resolved.signer.id })
      return await handler(request, { scope: { service, request: resolved.request, signer: resolved.signer, log: signerLog }, log: signerLog, requestId }, resolvedParams)
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  }
}

export function withMemberSigner<P extends { signerId: string }>(operation: string, options: SignerRouteOptions, handler: SignerRouteHandler<P>) {
  return withRouteContext<{ params: Promise<P> }>(operation, async (request, { user, log, requestId }, { params }) => {
    const resolvedParams = await params
    if (!isUuid(resolvedParams.signerId)) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'malformed signer id' })
    if (!limiterFor(options).allow(`member:${user.id}:${resolvedParams.signerId}`)) {
      return errorResponseFromCode('RATE_LIMITED', log, { requestId, reason: 'member signer over its budget' })
    }
    const service = createServiceClientNoCookies()
    const resolved = await resolveMemberSigner(service, resolvedParams.signerId, user.id)
    if (!resolved.ok) {
      return resolved.reason === 'not_signer'
        ? errorResponseFromCode('SIGNING_NOT_SIGNER', log, { requestId })
        : errorResponseFromCode('NOT_FOUND', log, { requestId, reason: `member signer ${resolved.reason}` })
    }
    const signerLog = log.child({ signingRequestId: resolved.request.id, signerId: resolved.signer.id })
    return handler(request, { scope: { service, request: resolved.request, signer: resolved.signer, log: signerLog }, log: signerLog, requestId }, resolvedParams)
  })
}
