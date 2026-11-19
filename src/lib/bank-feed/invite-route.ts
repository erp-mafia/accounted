/**
 * The door of the token routes under /api/koppla/[token]: the signatory link
 * (lib/bank-feed/invites.ts) is the authentication, so every route resolves
 * the token first and then runs the same bank-feed service functions as the
 * session routes under /api/bank/open-payments, as the person who sent the
 * link, for the company the link names.
 *
 * No session, no supabase.auth: the posture of /api/payslip/[token]. The
 * service-role client reads the row; the per-token limiter bounds abuse of a
 * leaked link; the clear token is never logged (the logger gets the invite id).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger, type Logger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'
import { CONSUMED_INVITE_GRACE_MS, isValidInviteTokenFormat, resolveInviteToken, type BankConnectInviteRow } from './invites'
import type { BankFeedSignerInput } from './party'

// 60 requests per token per 10 minutes for everything a sitting does by hand
// (one start, a few restarts, one selection, one sync, the verification).
// The consent poll is the one call the flow itself makes once a second while
// the bank's BankID is open (two steps of up to 90 s each, Svea twice), so it
// has a budget of its own. Process-local, like the payslip limiter.
const generalLimiter = createTokenRateLimiter({ max: 60, windowMs: 10 * 60_000 })
const pollLimiter = createTokenRateLimiter({ max: 900, windowMs: 10 * 60_000 })

export interface InviteRouteContext {
  invite: BankConnectInviteRow
  service: SupabaseClient
  /** The operation context the bank-feed service takes: the company of the link, acting as its sender. */
  op: OperationContext
  log: Logger
  requestId: string
  /**
   * The signer for a bank call: the firmatecknare's typed personnummer with
   * the request's IP and user agent, and never the sender's number on file
   * (lookupOnFile false). Null when nothing was typed: the service then
   * refuses the calls that need a PSU, and routes that always need one answer
   * signerRequired() first. A Nordea Corporate Netbank logon id the
   * firmatecknare typed comes along.
   */
  signer: (personalNumber: string | null | undefined, psuAuthoriserId?: string | null) => BankFeedSignerInput
  /** 400 BANK_CONSENT_PERSONAL_NUMBER_REQUIRED: a signatory call without a typed personnummer. */
  signerRequired: () => NextResponse
}

/** The typed personnummer as the routes read it: trimmed, or null when nothing was typed. */
export function typedPersonalNumber(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface InviteRouteOptions {
  /**
   * 'open': the link must be unconsumed (banks, start, select, the abandon
   * delete). 'follow_up': the calls the sitting that consumed the link still
   * makes (poll, restart, sync, the connection read, the verification) keep
   * answering for CONSUMED_INVITE_GRACE_MS after consumption.
   */
  stage: 'open' | 'follow_up'
  /** The consent poll's own budget; everything else shares the general one. */
  limiter?: 'general' | 'poll'
}

type Params<P> = { params: Promise<P> }

export type InviteRouteHandler<P> = (request: Request, ctx: InviteRouteContext, params: P) => Promise<NextResponse>

/**
 * Wrap a token route. `operation` names the route in the logs the way the
 * session routes name theirs ('bank_feed.start'); the token itself never
 * reaches a log line.
 */
export function withInviteToken<P extends { token: string }>(operation: string, options: InviteRouteOptions, handler: InviteRouteHandler<P>) {
  return async (request: Request, { params }: Params<P>): Promise<NextResponse> => {
    const requestId = randomUUID()
    const log = createLogger('koppla', { requestId, operation })
    const resolvedParams = await params
    const token = resolvedParams.token
    if (!isValidInviteTokenFormat(token)) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'malformed signatory token' })
    const limiter = options.limiter === 'poll' ? pollLimiter : generalLimiter
    if (!limiter.allow(token)) return errorResponseFromCode('RATE_LIMITED', log, { requestId, reason: 'signatory token over its budget' })

    const service = createServiceClientNoCookies()
    const resolved = await resolveInviteToken(service, token, { allowConsumedWithinMs: options.stage === 'follow_up' ? CONSUMED_INVITE_GRACE_MS : 0 })
    if (!resolved.ok) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: `signatory link ${resolved.reason}` })
    const { invite } = resolved
    const inviteLog = log.child({ companyId: invite.company_id, inviteId: invite.id })
    const ctx: InviteRouteContext = {
      invite,
      service,
      op: { supabase: service, companyId: invite.company_id, userId: invite.created_by, log: inviteLog },
      log: inviteLog,
      requestId,
      signer: (personalNumber, psuAuthoriserId) => ({ ...signerFromRequest(request, typedPersonalNumber(personalNumber), psuAuthoriserId), lookupOnFile: false }),
      signerRequired: () => errorResponseFromCode('BANK_CONSENT_PERSONAL_NUMBER_REQUIRED', inviteLog, { requestId, reason: 'signatory call without a typed personnummer' }),
    }
    try {
      return await handler(request, ctx, resolvedParams)
    } catch (error) {
      return errorResponse(error, inviteLog, { requestId })
    }
  }
}
