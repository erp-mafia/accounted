/**
 * The door of the token routes under /api/betala/[token]: the payment
 * signing link (signing-links.ts) is the authentication, so every route
 * resolves the token first and then runs the SAME signing functions as the
 * session routes under /api/payments/signing (signing.ts), as the person who
 * sent the link, for the company the link names.
 *
 * The posture of withInviteToken (lib/bank-feed/invite-route.ts) for the bank
 * consent's signatory link, kept beside it rather than generalised so neither
 * link's door changes under the other: no session, no supabase.auth; the
 * service-role client reads the row; a general per-token budget and a poll
 * budget of its own bound a leaked link; the clear token is never logged (the
 * logger gets the link id). The signer is the firmatecknare's typed
 * personnummer and never the sender's number on file (lookupOnFile false).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { typedPersonalNumber } from '@/lib/bank-feed/invite-route'
import { isValidInviteTokenFormat } from '@/lib/bank-feed/invites'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger, type Logger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import type { SignerInput } from './party'
import { signerFromRequest } from './request-signer'
import { CONSUMED_SIGNING_LINK_GRACE_MS, resolvePaymentSigningLink, signingLinkPath, type PaymentSigningLinkRow } from './signing-links'

export { typedPersonalNumber }

// 60 requests per token per 10 minutes for everything a sitting does by hand
// (the basket, one start, a few restarts). The signing poll is the one call
// the flow itself makes once a second while BankID is open, so it has a
// budget of its own. Process-local, like the signatory link's limiter.
const generalLimiter = createTokenRateLimiter({ max: 60, windowMs: 10 * 60_000 })
const pollLimiter = createTokenRateLimiter({ max: 900, windowMs: 10 * 60_000 })

export interface SigningLinkRouteContext {
  link: PaymentSigningLinkRow
  service: SupabaseClient
  /** The operation context the signing service takes: the company of the link, acting as its sender. */
  op: OperationContext
  log: Logger
  requestId: string
  /** The firmatecknare's typed personnummer with the request's IP and user agent; never the sender's number on file. */
  signer: (personalNumber: string | null | undefined) => SignerInput
  /** 400 PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED: a signing call without a typed personnummer. */
  signerRequired: () => NextResponse
  /** This link's page: where a signing on the bank's own page comes back. */
  returnPath: string
}

export interface SigningLinkRouteOptions {
  /**
   * 'open': the link must be unconsumed (start, restart). 'follow_up': the
   * calls the sitting that consumed the link still makes (the basket, the
   * last poll) keep answering for CONSUMED_SIGNING_LINK_GRACE_MS.
   */
  stage: 'open' | 'follow_up'
  /** The signing poll's own budget; everything else shares the general one. */
  limiter?: 'general' | 'poll'
}

type Params<P> = { params: Promise<P> }

export type SigningLinkRouteHandler<P> = (request: Request, ctx: SigningLinkRouteContext, params: P) => Promise<NextResponse>

/**
 * Wrap a token route. `operation` names the route in the logs the way the
 * session routes name theirs ('payment_signing.start'); the token itself
 * never reaches a log line. Every way a token fails (malformed, unknown,
 * expired, consumed, cancelled) answers the same 404.
 */
export function withSigningLinkToken<P extends { token: string }>(operation: string, options: SigningLinkRouteOptions, handler: SigningLinkRouteHandler<P>) {
  return async (request: Request, { params }: Params<P>): Promise<NextResponse> => {
    const requestId = randomUUID()
    const log = createLogger('betala', { requestId, operation })
    const resolvedParams = await params
    const token = resolvedParams.token
    if (!isValidInviteTokenFormat(token)) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'malformed signing link token' })
    const limiter = options.limiter === 'poll' ? pollLimiter : generalLimiter
    if (!limiter.allow(token)) return errorResponseFromCode('RATE_LIMITED', log, { requestId, reason: 'signing link token over its budget' })

    const service = createServiceClientNoCookies()
    const resolved = await resolvePaymentSigningLink(service, token, { allowConsumedWithinMs: options.stage === 'follow_up' ? CONSUMED_SIGNING_LINK_GRACE_MS : 0 })
    if (!resolved.ok) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: `signing link ${resolved.reason}` })
    const { link } = resolved
    const linkLog = log.child({ companyId: link.company_id, signingLinkId: link.id })
    const ctx: SigningLinkRouteContext = {
      link,
      service,
      op: { supabase: service, companyId: link.company_id, userId: link.created_by, log: linkLog },
      log: linkLog,
      requestId,
      signer: (personalNumber) => ({ ...signerFromRequest(request, typedPersonalNumber(personalNumber)), lookupOnFile: false }),
      signerRequired: () => errorResponseFromCode('PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED', linkLog, { requestId, reason: 'signing link call without a typed personnummer' }),
      returnPath: signingLinkPath(token),
    }
    try {
      return await handler(request, ctx, resolvedParams)
    } catch (error) {
      return errorResponse(error, linkLog, { requestId })
    }
  }
}
