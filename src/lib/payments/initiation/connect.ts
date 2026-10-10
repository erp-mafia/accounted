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
 *     end-to-end id, the provider's payment id, the sorted payment ids of a
 *     basket), so the reviewed orders domain keeps calling the port exactly
 *     once per write and a retry at the service answers with the first
 *     result. A signing start is the one write without replay: a restarted
 *     signing must create a new authorisation at the bank, and an unused
 *     authorisation costs nothing.
 *   - Every failure becomes a PaymentProviderError that says what the bank
 *     may hold (toPaymentProviderError): the service's OUTCOME_UNKNOWN, an
 *     unreachable service on a write and an in-flight idempotency row all
 *     hold the order; a refusal carries the provider's own code.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PAYMENTS_OPERATIONS, PAYMENTS_WRITE_OPERATIONS, type PaymentsOperation, type PaymentsParty } from '@accounted/connect-contract'
import { CONNECTOR_UNREACHABLE_CODE, ConnectorCallError, callConnectorOperation } from '@/lib/connect/instance/connector-fetch'
import { paymentsConnectorMode, type ConnectorUpstream } from '@/lib/connect/instance/upstreams'
import {
  PAYMENT_NOT_FOUND,
  PaymentProviderError,
  getPaymentInitiationProviderById,
  registerPaymentInitiationProvider,
  type PaymentInitiationProvider,
  type PaymentPartyContext,
  type SigningChallenge,
  type SigningTarget,
} from './provider'

/** Connect's own client timeout is 20 s; wait long enough to hear its answer, its timeout included. */
export const PAYMENTS_CONNECT_TIMEOUT_MS = 30_000

/** The code of the PaymentProviderError for a refusal the service relayed without a provider code. */
export const PAYMENT_REFUSED = 'PAYMENT_REFUSED'

const WRITE_OPERATIONS: ReadonlySet<PaymentsOperation> = new Set(PAYMENTS_WRITE_OPERATIONS)

export interface ConnectPaymentsProviderDeps {
  fetch?: typeof fetch
  timeoutMs?: number
}

/** The port's party as the contract carries it: digits only for the organisationsnummer and the personnummer. */
export function toConnectorParty(ctx: PaymentPartyContext): PaymentsParty {
  return {
    orgNumber: ctx.companyOrgNumber.replace(/\D/g, ''),
    accountContext: ctx.accountContext,
    debtorBic: ctx.debtorBic,
    signerPersonalNumber: ctx.signerPersonalNumber ? ctx.signerPersonalNumber.replace(/\D/g, '') : null,
    psuIpAddress: ctx.psuIpAddress,
    psuUserAgent: ctx.psuUserAgent,
  }
}

/** The idempotency key of a basket: the sorted payment ids, hashed, so the same set always names the same basket. */
export function basketIdempotencyKey(providerPaymentIds: readonly string[]): string {
  const digest = createHash('sha256').update([...providerPaymentIds].sort().join(',')).digest('hex')
  return `basket:${digest.slice(0, 64)}`
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
      return new PaymentProviderError(error.message, error.providerCode ?? PAYMENT_REFUSED, false, status, false)
    case 'CONNECTOR_PAYMENTS_PROVIDER_FAILED':
    case 'CONNECTOR_RATE_LIMITED':
      return new PaymentProviderError(error.message, error.code, true, status, false)
    default:
      break
  }
  if (/^HTTP_(5\d\d|429)$/.test(error.code)) return new PaymentProviderError(error.message, error.code, true, status, false)
  // Configuration, scope, key, contract and request errors: a person or an operator must act.
  return new PaymentProviderError(error.message, error.code, false, status, false)
}

function toChallenge(challenge: {
  approach: 'decoupled' | 'redirect'
  autostartToken: string | null
  qrData: string | null
  redirectUrl: string | null
} | null): SigningChallenge | null {
  if (!challenge) return null
  return {
    approach: challenge.approach,
    autostartToken: challenge.autostartToken,
    qrData: challenge.qrData,
    redirectUrl: challenge.redirectUrl,
  }
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
      throw toPaymentProviderError(error, operation)
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
      const created = await call('createPayment', ctx.companyId, {
        idempotencyKey: `pay:${instruction.endToEndId}`,
        party: toConnectorParty(ctx),
        instruction,
      })
      return {
        providerPaymentId: created.providerPaymentId,
        product: created.product,
        providerStatus: created.providerStatus,
        status: created.status,
        messages: created.messages,
      }
    },

    async getPaymentState(ctx, providerPaymentId, product) {
      const state = await call('paymentStatus', ctx.companyId, { party: toConnectorParty(ctx), providerPaymentId, product })
      return { providerStatus: state.providerStatus, status: state.status, messages: state.messages }
    },

    async createSigningBasket(ctx, providerPaymentIds) {
      const basket = await call('createBasket', ctx.companyId, {
        idempotencyKey: basketIdempotencyKey(providerPaymentIds),
        party: toConnectorParty(ctx),
        providerPaymentIds,
      })
      return { providerBasketId: basket.providerBasketId }
    },

    async startSigning(ctx, target, method) {
      const started = await call('startSigning', ctx.companyId, {
        idempotencyKey: `sign:${signingTargetId(target)}:${method}:${randomUUID()}`,
        party: toConnectorParty(ctx),
        target,
        method,
      })
      return {
        providerAuthorisationId: started.providerAuthorisationId,
        method: started.method,
        state: started.state,
        challenge: toChallenge(started.challenge),
        failureCode: started.failureCode,
      }
    },

    async pollSigning(ctx, target, providerAuthorisationId, method) {
      const progress = await call('pollSigning', ctx.companyId, {
        party: toConnectorParty(ctx),
        target,
        providerAuthorisationId,
        method,
      })
      return { state: progress.state, challenge: toChallenge(progress.challenge), failureCode: progress.failureCode }
    },

    async cancelPayment(ctx, providerPaymentId, product) {
      const result = await call('cancelPayment', ctx.companyId, {
        idempotencyKey: `cancel:${providerPaymentId}`,
        party: toConnectorParty(ctx),
        providerPaymentId,
        product,
      })
      return { outcome: result.outcome, providerStatus: result.providerStatus }
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
  if (getPaymentInitiationProviderById('open_payments')) return false
  const upstream = deps.upstream === undefined ? paymentsConnectorMode() : deps.upstream
  if (!upstream) return false
  registerPaymentInitiationProvider(createConnectPaymentsProvider(upstream, deps))
  return true
}
