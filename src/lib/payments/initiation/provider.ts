/**
 * Payment initiation: the port between Accounted's payment orders
 * (payment_orders, migration 20261004010200) and a bank-API provider.
 *
 * Core owns the orders, their lifecycle and every accounting consequence. A
 * provider only moves the instruction to the bank and reports back in these
 * domain terms. A payments adapter registers itself at module load (the same
 * pattern as registerEmailService); the first one is the Connect adapter for
 * Open Payments. Core never imports an adapter, and with no provider
 * registered paying through the bank is simply unavailable.
 *
 * Things every provider must respect:
 *   - No provider call is repeated to "make sure": a payment API may have no
 *     idempotency (Open Payments creates a second payment for a repeated
 *     request), so callers claim the order in the database first and call once.
 *   - Amounts are passed as numbers in the order's currency and formatted by
 *     the provider for its wire format.
 *   - A signing that reports failure is authoritative over a payment status
 *     that looks accepted.
 */

import type { PaymentOrderStatus } from '@/lib/payments/orders/status'

export type PaymentProviderId = 'open_payments'

/** Who is paying, from where, and the person who will sign. */
export interface PaymentPartyContext {
  companyId: string
  /** The company's organisationsnummer (10 digits). */
  companyOrgNumber: string
  /** Business account (corporate) or personal account (private) at the bank. */
  accountContext: 'corporate' | 'private'
  /** BIC of the bank the money leaves from. */
  debtorBic: string
  /** The signer's personnummer (12 digits), when known. Banks use it to address the BankID. */
  signerPersonalNumber: string | null
  /** The signer's IP address and user agent, forwarded to the bank for its fraud checks. */
  psuIpAddress: string | null
  psuUserAgent: string | null
}

export type PayeeInstruction =
  | { type: 'bankgiro'; bankgiro: string; name: string }
  | { type: 'plusgiro'; plusgiro: string; name: string }
  | { type: 'bank_account'; clearing: string; account: string; name: string }
  | { type: 'iban'; iban: string; bic: string | null; name: string }

export interface PaymentInstruction {
  /** Our id for the payment at the bank; the debit on the statement carries it. */
  endToEndId: string
  amount: number
  currency: string
  /** YYYY-MM-DD. */
  requestedExecutionDate: string
  debtor: { iban: string | null; bban: string | null; currency: string }
  payee: PayeeInstruction
  reference: { type: 'ocr' | 'message'; value: string }
}

export interface ProviderPaymentState {
  /** The provider's own status code, kept verbatim on the order. */
  providerStatus: string
  /** Mapped to Accounted's lifecycle. */
  status: PaymentOrderStatus
  /** Provider messages worth showing or logging (codes, not prose). */
  messages: string[]
}

export interface CreatedPayment extends ProviderPaymentState {
  providerPaymentId: string
  /** The provider's payment product the instruction was sent as (e.g. swedish-giro). */
  product: string
}

/** What a person needs to sign with BankID right now. */
export interface SigningChallenge {
  /** The bank decides: signing in the app on this device / from a QR (decoupled), or on the bank's page (redirect). */
  approach: 'decoupled' | 'redirect'
  /** Open the BankID app on this device. */
  autostartToken: string | null
  /** Animated QR: the data changes on every poll and must be re-rendered. */
  qrData: string | null
  /** The bank's page, for the redirect approach. */
  redirectUrl: string | null
}

export type SigningState = 'pending' | 'finalised' | 'failed'

export interface SigningProgress {
  state: SigningState
  challenge: SigningChallenge | null
  /** Provider code when the signing failed (e.g. a cancelled or expired BankID). */
  failureCode: string | null
}

export type SigningTarget =
  | { kind: 'payment'; providerPaymentId: string; product: string }
  | { kind: 'basket'; providerBasketId: string }

export interface StartedSigning extends SigningProgress {
  providerAuthorisationId: string
  method: 'same_device' | 'qr' | 'redirect'
}

export interface CompanyVerification {
  status: 'valid' | 'invalid' | 'unknown'
  validUntil: string | null
}

export interface PaymentInitiationProvider {
  readonly id: PaymentProviderId
  /** Credentials present and the company allowed to use this provider. */
  isAvailableFor(companyId: string): boolean
  createPayment(ctx: PaymentPartyContext, instruction: PaymentInstruction): Promise<CreatedPayment>
  getPaymentState(ctx: PaymentPartyContext, providerPaymentId: string, product: string): Promise<ProviderPaymentState>
  /** One BankID for several payments. Only for providers/banks that support baskets. */
  createSigningBasket(ctx: PaymentPartyContext, providerPaymentIds: string[]): Promise<{ providerBasketId: string }>
  startSigning(ctx: PaymentPartyContext, target: SigningTarget, method: 'same_device' | 'qr'): Promise<StartedSigning>
  pollSigning(
    ctx: PaymentPartyContext,
    target: SigningTarget,
    providerAuthorisationId: string,
    method: 'same_device' | 'qr' | 'redirect',
  ): Promise<SigningProgress>
  /** Ask the bank to cancel a payment it has not executed. */
  cancelPayment(ctx: PaymentPartyContext, providerPaymentId: string, product: string): Promise<{ cancelled: boolean; providerStatus: string | null }>
  /** Know-your-customer status of the company at the provider; payments are refused until valid. */
  getCompanyVerification(ctx: PaymentPartyContext): Promise<CompanyVerification>
  /** A link where the company completes the provider's verification. */
  startCompanyVerification(ctx: PaymentPartyContext): Promise<{ url: string }>
}

/**
 * Provider failures carry whether trying again later can help. A permanent
 * failure (the bank rejected the instruction) must not be retried with the
 * same instruction; a retryable one (timeout, 5xx, rate limit) may, but only
 * for calls that do not create anything at the bank.
 */
export class PaymentProviderError extends Error {
  readonly name = 'PaymentProviderError'
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message)
  }
}

const providers = new Map<PaymentProviderId, PaymentInitiationProvider>()

export function registerPaymentInitiationProvider(provider: PaymentInitiationProvider): void {
  providers.set(provider.id, provider)
}

/** The provider for a company, or null when paying through the bank is unavailable. */
export function getPaymentInitiationProvider(companyId: string): PaymentInitiationProvider | null {
  for (const provider of providers.values()) {
    if (provider.isAvailableFor(companyId)) return provider
  }
  return null
}

export function getPaymentInitiationProviderById(id: PaymentProviderId): PaymentInitiationProvider | null {
  return providers.get(id) ?? null
}

/** Whether this installation has any payments provider at all; false means every payments door is dark. */
export function hasPaymentInitiationProviders(): boolean {
  return providers.size > 0
}

/** Tests only. */
export function resetPaymentInitiationProviders(): void {
  providers.clear()
}
