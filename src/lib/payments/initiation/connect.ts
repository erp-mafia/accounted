/**
 * The Connect adapter for bank payments: the one PaymentInitiationProvider
 * (./provider.ts) this installation registers, and the only route to the
 * payment initiation provider for hosted and self-hosted alike. Accounted
 * Connect holds the provider's credentials and client certificate and serves
 * the payments family of the contract (PAYMENTS_OPERATIONS under
 * PAYMENTS_BASE_PATH); this adapter speaks those operations and nothing else.
 *
 *   - Availability: a connector key (paymentsConnectorMode()) registers the
 *     adapter for every company of the installation. Which company may pay
 *     (paid plan, pilot list) is the orders domain's question, answered in
 *     lib/payments/orders/switched-on.ts, never at the service.
 *   - Idempotency keys are derived here from the order's own identifiers (the
 *     end-to-end id, a basket's signing and payment ids), so the reviewed
 *     orders domain keeps calling the port exactly once per write and a retry
 *     at the service answers with the first result. A signing start and a
 *     cancel are the writes without replay, one key per call: a restarted
 *     signing must create a new authorisation at the bank (an unused one
 *     costs nothing), and a cancel's answer (too late, needs signing) holds
 *     only for the moment it was given, so a later cancel must ask the bank
 *     again (cancelIdempotencyKey).
 *   - Every failure becomes a PaymentProviderError that says what the bank
 *     may hold (toPaymentProviderError): the service's OUTCOME_UNKNOWN, an
 *     unreachable service on a write and an in-flight idempotency row all
 *     hold the order; a refusal carries the provider's own code.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PAYMENTS_OPERATIONS, PAYMENTS_WRITE_OPERATIONS, type PaymentsOperation, type PaymentsParty } from '@accounted/connect-contract'
import { CONNECTOR_UNREACHABLE_CODE, ConnectorCallError, callConnectorOperation } from '@/lib/connect/instance/connector-fetch'
import { paymentsConnectorMode, type ConnectorUpstream } from '@/lib/connect/instance/upstreams'
import { createLogger } from '@/lib/logger'
import {
  PAYMENT_NOT_FOUND,
  PaymentProviderError,
  registerPaymentInitiationProviderIfAbsent,
  type PaymentInitiationProvider,
  type PaymentInstruction,
  type PaymentPartyContext,
  type ProviderPaymentState,
  type SigningChallenge,
  type SigningTarget, type SigningStep } from './provider'

/** Connect's own client timeout is 20 s; wait long enough to hear its answer, its timeout included. */
export const PAYMENTS_CONNECT_TIMEOUT_MS = 30_000

/** The code of the PaymentProviderError for a refusal the service relayed without a provider code. */
export const PAYMENT_REFUSED = 'PAYMENT_REFUSED'

const WRITE_OPERATIONS: ReadonlySet<PaymentsOperation> = new Set(PAYMENTS_WRITE_OPERATIONS)

/**
 * The provider code a refused createPayment is known by. Open Payments may answer
 * with the generic FORMAT_ERROR first and the bank's reason after it
 * ("FORMAT_ERROR: Invalid ocrRef; OCR_REF_INVALID: ..."); Connect relays the
 * first code as providerCode and every message as detail, "CODE: text"
 * joined by "; ". For a create the specific code wins, so the person is told
 * what to fix. Every other operation keeps FORMAT_ERROR: the signing restart
 * reads it (isStaleAuthorisationRefusal in orders/signing.ts).
 */
export function refusalProviderCode(providerCode: string | null, detail: string | null, operation: PaymentsOperation): string | null {
  if (providerCode !== 'FORMAT_ERROR' || !detail || operation !== 'createPayment') return providerCode
  for (const part of detail.split(';')) {
    const code = /^\s*([A-Z][A-Z0-9_]{2,}):/.exec(part)?.[1]
    if (code && code !== providerCode) return code
  }
  return providerCode
}

export interface ConnectPaymentsProviderDeps {
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * The port's party as the contract carries it: digits only for the
 * organisationsnummer and the personnummer. Every operation sends it, so the
 * affiliated bank reaches every payment, basket, status, cancel and signing
 * call (X-AffiliatedASPSP-ID at the provider) from this one place.
 */
export function toConnectorParty(ctx: PaymentPartyContext): PaymentsParty {
  return {
    orgNumber: ctx.companyOrgNumber.replace(/\D/g, ''),
    accountContext: ctx.accountContext,
    debtorBic: ctx.debtorBic,
    signerPersonalNumber: ctx.signerPersonalNumber ? ctx.signerPersonalNumber.replace(/\D/g, '') : null,
    psuIpAddress: ctx.psuIpAddress,
    psuUserAgent: ctx.psuUserAgent,
    affiliatedAspspId: ctx.affiliatedAspspId ?? null,
    ...(ctx.redirectPreferred ? { redirectPreferred: true } : {}),
    ...(ctx.psuAuthoriserId ? { psuAuthoriserId: ctx.psuAuthoriserId } : {}),
  }
}

/**
 * The idempotency key of a create: the end-to-end id, and the attempt number
 * once a payment created for the order was cancelled at the bank (a replay of
 * the first key would answer the cancelled payment, not make a new one).
 */
export function paymentIdempotencyKey(instruction: Pick<PaymentInstruction, 'endToEndId' | 'attempt'>): string {
  const attempt = instruction.attempt ?? 1
  return attempt > 1 ? `pay:${instruction.endToEndId}:${attempt}` : `pay:${instruction.endToEndId}`
}

/**
 * The idempotency key of a basket: the sorted payment ids, hashed, under the
 * signing it is made for. A signing makes its basket once, so a retry of that
 * signing names the same basket; a new signing over the same payments (a
 * restart after a signing that failed while the bank kept its payments) makes
 * a new one. Keyed by the payments alone, that restart got the dead basket of
 * the earlier signing replayed, or a CONNECTOR_IDEMPOTENCY_MISMATCH when the
 * party differed (crm#1282).
 */
export function basketIdempotencyKey(providerPaymentIds: readonly string[], signingId?: string | null): string {
  const digest = createHash('sha256').update([...providerPaymentIds].sort().join(',')).digest('hex')
  return signingId ? `basket:${signingId}:${digest.slice(0, 64)}` : `basket:${digest.slice(0, 64)}`
}

/**
 * The idempotency key of one cancel: the payment id and a fresh suffix, so
 * every cancel asks the bank. A key made of the payment id alone named every
 * cancel of the payment one request (crm#1282): the service replayed the
 * first answer to a later cancel with the same body, and refused one from
 * another caller (another party: the browser, an agent, the status sync) as
 * CONNECTOR_IDEMPOTENCY_MISMATCH, without asking the bank, for the 30 days it
 * keeps the key. Asking the bank to cancel twice cannot pay anything; the
 * adapter calls the service once per cancel, so one call is one attempt.
 */
export function cancelIdempotencyKey(providerPaymentId: string): string {
  return `cancel:${providerPaymentId}:${randomUUID()}`
}

/**
 * Open Payments statuses of a payment the bank holds unsigned: received
 * (RCVD) or pending (PDNG), the two the service maps to 'submitted'. Every
 * other status is signed, final or not known to be unsigned.
 */
const UNSIGNED_PROVIDER_STATUSES: ReadonlySet<string> = new Set(['RCVD', 'PDNG'])

/**
 * Open Payments' message, with PATC, that the bank takes the second signature
 * through the API (a new authorisation under the other signatory's PSU-ID)
 * rather than in its online bank: SEB (written answer, 2026-10-28).
 */
const SECOND_SIGNATURE_VIA_API = 'AUTHORISATION_PENDING_API'

/**
 * The port's state of a payment: the provider's messages, what they say
 * about a second signature, and, for a refused payment, the first of them as
 * the reason (Open Payments answers RJCT with the reason code as its message).
 */
function paymentState(state: { providerStatus: string; status: ProviderPaymentState['status']; messages: string[] }): ProviderPaymentState {
  const refused = state.status === 'rejected' || state.status === 'failed'
  return {
    providerStatus: state.providerStatus,
    status: state.status,
    messages: state.messages,
    ...(state.messages.includes(SECOND_SIGNATURE_VIA_API) ? { secondSignatureViaApi: true } : {}),
    ...(refused && state.messages[0] ? { refusalCode: state.messages[0] } : {}),
  }
}

/** Whether the bank's status for a payment says it is not signed (UNSIGNED_PROVIDER_STATUSES). */
export function isUnsignedProviderStatus(providerStatus: string | null | undefined): boolean {
  return typeof providerStatus === 'string' && UNSIGNED_PROVIDER_STATUSES.has(providerStatus.toUpperCase())
}

function signingTargetId(target: SigningTarget): string {
  return target.kind === 'payment' ? target.providerPaymentId : target.providerBasketId
}

/**
 * What a failed Connect call leaves at the bank, in the port's terms. The
 * operation decides for the codes that do not say it themselves: an
 * unreachable service after a write may have forwarded it (held), after a
 * read nothing happened (retry later).
 */
export function toPaymentProviderError(error: unknown, operation: PaymentsOperation): PaymentProviderError {
  if (error instanceof PaymentProviderError) return error
  const write = WRITE_OPERATIONS.has(operation)
  if (!(error instanceof ConnectorCallError)) {
    const message = error instanceof Error ? error.message : String(error)
    return new PaymentProviderError(`Connect payments.${operation}: ${message}`, 'CONNECTOR_FAILED', false, null, write)
  }
  const status = error.status
  switch (error.code) {
    case 'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN':
      return new PaymentProviderError(error.message, error.code, false, status, true)
    case CONNECTOR_UNREACHABLE_CODE:
      return write
        ? new PaymentProviderError(error.message, error.code, false, status, true)
        : new PaymentProviderError(error.message, error.code, true, status, false)
    case 'CONNECTOR_IDEMPOTENCY_IN_FLIGHT':
      // Another attempt holds the lease: whatever it did is at the bank, or will be. Never send again.
      return new PaymentProviderError(error.message, error.code, false, status, true)
    case 'CONNECTOR_PAYMENTS_NOT_FOUND':
      return new PaymentProviderError(error.message, PAYMENT_NOT_FOUND, false, status, false)
    case 'CONNECTOR_PAYMENTS_REFUSED':
      return new PaymentProviderError(error.message, refusalProviderCode(error.providerCode, error.detail, operation) ?? PAYMENT_REFUSED, false, status, false)
    case 'CONNECTOR_PAYMENTS_PROVIDER_FAILED':
    case 'CONNECTOR_RATE_LIMITED':
      return new PaymentProviderError(error.message, error.code, true, status, false)
    case 'CONNECTOR_BANK_THROTTLED':
      // The bank's own 429 (BANK_REQUEST_LIMIT_EXCEEDED): it refused the
      // request before doing anything with it, write or read, and asks for a
      // short wait. Retried on the next status run; the person is told the
      // bank is busy.
      return new PaymentProviderError(error.message, error.code, true, status, false)
    default:
      break
  }
  if (/^HTTP_(5\d\d|429)$/.test(error.code)) return new PaymentProviderError(error.message, error.code, true, status, false)
  // Configuration, scope, key, contract and request errors: a person or an operator must act.
  return new PaymentProviderError(error.message, error.code, false, status, false)
}

/** The bank's SCA status (Open Payments' scaStatus) as the step the person is at. */
export function signingStepFrom(scaStatus: string | null | undefined): SigningStep | null {
  switch (scaStatus) {
    case 'authenticationStarted':
    case 'psuIdentified':
    case 'psuAuthenticated':
      return 'identify'
    case 'authoriseCreditorAccountStarted':
      return 'approve_payee'
    case 'scaMethodSelected':
    case 'started':
      return 'sign'
    default:
      return null
  }
}

function toChallenge(challenge: {
  approach: 'decoupled' | 'redirect'
  autostartToken: string | null
  qrData: string | null
  qrImage?: string | null
  redirectUrl: string | null
} | null): SigningChallenge | null {
  if (!challenge) return null
  return {
    approach: challenge.approach,
    autostartToken: challenge.autostartToken,
    qrData: challenge.qrData,
    qrImage: challenge.qrImage ?? null,
    redirectUrl: challenge.redirectUrl,
  }
}

const log = createLogger('payments/connect')

/**
 * A failed call no retry fixes that is not the bank's answer: a
 * configuration, scope, key, contract or request error, or an exception on
 * our side of the service. A person or an operator must act, so it is logged
 * at error here, whatever the door answers: a door answers a final failure
 * as PAYMENT_PROVIDER_REFUSED, a 4xx, which is right for the bank's own
 * refusal (CONNECTOR_PAYMENTS_REFUSED) and its not-found, and would leave an
 * outage of the integration at warn.
 */
function operatorMustAct(error: unknown, failure: PaymentProviderError): boolean {
  if (failure.retryable || failure.outcomeUnknown) return false
  return !(error instanceof ConnectorCallError
    && (error.code === 'CONNECTOR_PAYMENTS_REFUSED' || error.code === 'CONNECTOR_PAYMENTS_NOT_FOUND'))
}

export function createConnectPaymentsProvider(upstream: ConnectorUpstream, deps: ConnectPaymentsProviderDeps = {}): PaymentInitiationProvider {
  const timeoutMs = deps.timeoutMs ?? PAYMENTS_CONNECT_TIMEOUT_MS

  async function call<O extends PaymentsOperation>(operation: O, companyId: string, body: unknown) {
    try {
      return await callConnectorOperation({
        upstream,
        operation: `payments.${operation}`,
        def: PAYMENTS_OPERATIONS[operation],
        body,
        companyId,
        timeoutMs,
        fetch: deps.fetch,
      })
    } catch (error) {
      const failure = toPaymentProviderError(error, operation)
      if (operatorMustAct(error, failure)) {
        log.error('payments connector call failed; a person or an operator must act',
          { alert: true, companyId, operation, code: failure.code, status: failure.httpStatus })
      }
      throw failure
    }
  }

  return {
    id: 'open_payments',

    // One adapter for the whole installation: the paid plan and the pilot list
    // are checked by the orders domain (switched-on.ts), and an order that
    // already exists must stay pollable and cancellable whatever the plan.
    isAvailableFor() {
      return true
    },

    async createPayment(ctx, instruction) {
      // The attempt number keys the create; the wire instruction is the contract's alone.
      const { attempt: _attempt, ...wire } = instruction
      const created = await call('createPayment', ctx.companyId, {
        idempotencyKey: paymentIdempotencyKey(instruction),
        party: toConnectorParty(ctx),
        instruction: wire,
      })
      return { providerPaymentId: created.providerPaymentId, product: created.product, ...paymentState(created) }
    },

    async getPaymentState(ctx, providerPaymentId, product) {
      return paymentState(await call('paymentStatus', ctx.companyId, { party: toConnectorParty(ctx), providerPaymentId, product }))
    },

    async createSigningBasket(ctx, providerPaymentIds, signingId) {
      const basket = await call('createBasket', ctx.companyId, {
        idempotencyKey: basketIdempotencyKey(providerPaymentIds, signingId),
        party: toConnectorParty(ctx),
        providerPaymentIds,
      })
      return { providerBasketId: basket.providerBasketId }
    },

    async startSigning(ctx, target, method, redirect = null) {
      const started = await call('startSigning', ctx.companyId, {
        idempotencyKey: `sign:${signingTargetId(target)}:${method}:${randomUUID()}`,
        party: toConnectorParty(ctx),
        target,
        method,
        // Required by the contract with method 'redirect', absent otherwise.
        ...(method === 'redirect' && redirect ? { returnUrl: redirect.returnUrl, returnState: redirect.returnState } : {}),
      })
      return {
        providerAuthorisationId: started.providerAuthorisationId,
        method: started.method,
        state: started.state,
        challenge: toChallenge(started.challenge),
        failureCode: started.failureCode,
        step: signingStepFrom(started.scaStatus),
      }
    },

    async pollSigning(ctx, target, providerAuthorisationId, method) {
      const progress = await call('pollSigning', ctx.companyId, {
        party: toConnectorParty(ctx),
        target,
        providerAuthorisationId,
        method,
      })
      return { state: progress.state, challenge: toChallenge(progress.challenge), failureCode: progress.failureCode, step: signingStepFrom(progress.scaStatus) }
    },

    async cancelPayment(ctx, providerPaymentId, product) {
      const result = await call('cancelPayment', ctx.companyId, {
        idempotencyKey: cancelIdempotencyKey(providerPaymentId),
        party: toConnectorParty(ctx),
        providerPaymentId,
        product,
      })
      return { outcome: result.outcome, providerStatus: result.providerStatus, unsigned: isUnsignedProviderStatus(result.providerStatus) }
    },

    async getBankCapabilities(ctx) {
      const bank = await call('bank', ctx.companyId, { bic: ctx.debtorBic })
      return {
        decoupled: bank.decoupled,
        redirect: bank.redirect,
        basket: { supported: bank.basket.supported, maxPayments: bank.basket.maxPayments },
      }
    },

    async getCompanyVerification(ctx) {
      const verification = await call('verification', ctx.companyId, { orgNumber: toConnectorParty(ctx).orgNumber })
      return { status: verification.status, validUntil: verification.validUntil }
    },

    async startCompanyVerification(ctx) {
      const started = await call('startVerification', ctx.companyId, { orgNumber: toConnectorParty(ctx).orgNumber, countryCode: 'SE' })
      return { url: started.url }
    },
  }
}

/**
 * Register the Connect adapter when this installation has a connector key.
 * Idempotent: an adapter registered earlier (a test's fake, say) is kept.
 * Returns whether this call registered one.
 */
export function registerConnectPaymentsProvider(deps: ConnectPaymentsProviderDeps & { upstream?: ConnectorUpstream | null } = {}): boolean {
  return registerPaymentInitiationProviderIfAbsent('open_payments', () => {
    const upstream = deps.upstream === undefined ? paymentsConnectorMode() : deps.upstream
    return upstream ? createConnectPaymentsProvider(upstream, deps) : null
  })
}
