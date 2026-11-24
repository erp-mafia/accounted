/**
 * Payment initiation: the port between Accounted's payment orders
 * (payment_orders, migration 20261010090000) and a bank-API provider.
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
 *   - A failed write says what the bank may hold (PaymentProviderError): a
 *     definitive refusal, a failure before the request reached the bank, or
 *     an unknown outcome (outcomeUnknown), after which the caller holds the
 *     order until the bank's debit or a person resolves it.
 *   - Amounts are passed as numbers in the order's currency and formatted by
 *     the provider for its wire format.
 *   - A signing that reports failure is authoritative over a payment status
 *     that looks accepted.
 *   - A cancel counts only when the bank confirmed it (PaymentCancelResult).
 *   - A payment the bank does not know is reported as a PaymentProviderError
 *     with code PAYMENT_NOT_FOUND, never as any other failure.
 */

import type { PaymentOrderStatus } from '@/lib/payments/orders/status'
import { whenInitialized } from '@/lib/initialized'
import { globalSingleton } from '@/lib/global-singleton'
import { brandError, isBrandedInstance } from '@/lib/errors/brand'

export type PaymentProviderId = 'open_payments'

/** Who is paying, from where, and the person who will sign. */
export interface PaymentPartyContext {
  companyId: string
  /** The company's organisationsnummer (10 digits). */
  companyOrgNumber: string
  /** Business account (corporate) or personal account (private) at the bank: from the connection's psu_type. */
  accountContext: 'corporate' | 'private'
  /** BIC of the bank the money leaves from. */
  debtorBic: string
  /** The sparbank (or Ölands Bank) behind a shared BIC, from the paying account's connection; null for every other bank. */
  affiliatedAspspId: string | null
  /** Ask the bank for its own page over decoupled BankID when it offers both; set when the bank signs only there. */
  redirectPreferred?: boolean
  /** The signer's personnummer (12 digits), when known. Banks use it to address the BankID. */
  signerPersonalNumber: string | null
  /** The signer's IP address and user agent, forwarded to the bank for its fraud checks. */
  psuIpAddress: string | null
  psuUserAgent: string | null
  /** The signer's Nordea Corporate Netbank logon id, when typed: the provider sends it on the signing calls only. Never stored. */
  psuAuthoriserId?: string | null
}

export type PayeeInstruction =
  | { type: 'bankgiro'; bankgiro: string; name: string }
  | { type: 'plusgiro'; plusgiro: string; name: string }
  | { type: 'bank_account'; clearing: string; account: string; name: string }
  | { type: 'iban'; iban: string; bic: string | null; name: string }

export interface PaymentInstruction {
  /** Our id for the payment at the bank; the debit on the statement carries it. */
  endToEndId: string
  /**
   * Which create of this order this is: 1 (or absent) for the first, one more
   * after every confirmed cancel of a payment created for it. The adapter
   * keys the create by the end-to-end id and this number, so a new payment
   * is made instead of the cancelled one being answered again.
   */
  attempt?: number
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
  /**
   * The bank waits for another signatory (awaiting_second_signer) and takes
   * that signature through the API, as a new authorisation under their own
   * PSU-ID, not in its online bank. Absent when the bank does not say so.
   */
  secondSignatureViaApi?: boolean
  /**
   * Why the bank refused the payment, as a code (PSU_RIGHTS_MISSING), when
   * the status is rejected or failed and the provider said. Kept on the order
   * as provider_error_code. Absent otherwise.
   */
  refusalCode?: string
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
  /** The QR as a finished image (a data: URL) when the bank hands over no data to draw it from. */
  qrImage: string | null
  /** The bank's page, for the redirect approach. */
  redirectUrl: string | null
}

export type SigningState = 'pending' | 'finalised' | 'failed'

/**
 * Where a signing in several BankID steps stands. A Swedish bank may chain
 * them, each with its own QR and a short life: identify the person, approve
 * a payee it has not paid before, then sign the payment. Null when the bank
 * does not say.
 */
export type SigningStep = 'identify' | 'approve_payee' | 'sign'

export interface SigningProgress {
  state: SigningState
  challenge: SigningChallenge | null
  /** Provider code when the signing failed (e.g. a cancelled or expired BankID). */
  failureCode: string | null
  step: SigningStep | null
}

export type SigningTarget =
  | { kind: 'payment'; providerPaymentId: string; product: string }
  | { kind: 'basket'; providerBasketId: string }

export interface StartedSigning extends SigningProgress {
  providerAuthorisationId: string
  /** The method the bank actually offered: it may impose its own page (redirect) on a decoupled start. */
  method: 'same_device' | 'qr' | 'redirect'
}

/**
 * Where a signing on the bank's own page comes back: the installation's page
 * (https, on its own origin) and an opaque state echoed back as `state`.
 * Required with method 'redirect', absent otherwise.
 */
export interface SigningRedirectReturn {
  returnUrl: string
  returnState: string
}

/**
 * How the debtor's bank lets a person sign, asked before anything is created
 * so a signing that cannot happen is refused up front, never half-done.
 */
export interface BankSigningCapabilities {
  /** BankID in our app: a QR code, or the app on this device. */
  decoupled: boolean
  /** Signing on the bank's own page: the browser goes there and comes back to the return URL. */
  redirect: boolean
  /** Several payments under one BankID, and how many at most (null = no stated limit). */
  basket: { supported: boolean; maxPayments: number | null }
}

/**
 * The bank's answer to a cancel. Only 'cancelled' means the payment is gone:
 * the bank confirmed it (a 204, or its own status read showing the payment
 * cancelled). Every other answer leaves the payment where it was, as far as
 * anyone knows:
 *   - needs_authorisation: the bank wants the cancel signed, which is not
 *     offered here (the person cancels in the online bank; a payment the
 *     bank reports unsigned is released here instead, isReleasableUnsigned);
 *   - too_late: the bank does not allow a cancel now: executed already, past
 *     its cut-off, or (with `unsigned`) not signed while a signing of it is
 *     still open at the bank (crm#1282);
 *   - not_cancelled: anything else.
 */
export type PaymentCancelOutcome = 'cancelled' | 'needs_authorisation' | 'too_late' | 'not_cancelled'

export interface PaymentCancelResult {
  outcome: PaymentCancelOutcome
  /** The provider's status code for the payment after the answer, when it gave one. */
  providerStatus: string | null
  /**
   * The bank reports the payment received and not signed (its status maps to
   * 'submitted'): nothing is paid unless someone signs it. Absent or false
   * when the status says otherwise or the bank gave none.
   */
  unsigned?: boolean
}

/** The code of the PaymentProviderError for a payment id the bank does not know. */
export const PAYMENT_NOT_FOUND = 'PAYMENT_NOT_FOUND'

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
  /**
   * One BankID for several payments. Only for providers/banks that support
   * baskets. signingId names the signing (payment_order_batches.id) the
   * basket is made for: a new signing over the same payments is a new basket.
   */
  createSigningBasket(ctx: PaymentPartyContext, providerPaymentIds: string[], signingId?: string): Promise<{ providerBasketId: string }>
  /** Start BankID: in our screen (same_device, qr) or on the bank's own page (redirect, with where to come back). */
  startSigning(ctx: PaymentPartyContext, target: SigningTarget, method: 'same_device' | 'qr' | 'redirect', redirect?: SigningRedirectReturn | null): Promise<StartedSigning>
  pollSigning(
    ctx: PaymentPartyContext,
    target: SigningTarget,
    providerAuthorisationId: string,
    method: 'same_device' | 'qr' | 'redirect',
  ): Promise<SigningProgress>
  /** Ask the bank to cancel a payment it has not executed. Only outcome 'cancelled' is a confirmed cancel. */
  cancelPayment(ctx: PaymentPartyContext, providerPaymentId: string, product: string): Promise<PaymentCancelResult>
  /** How the debtor's bank (ctx.debtorBic) signs: asked before any payment is created. */
  getBankCapabilities(ctx: PaymentPartyContext): Promise<BankSigningCapabilities>
  /** Know-your-customer status of the company at the provider; payments are refused until valid. */
  getCompanyVerification(ctx: PaymentPartyContext): Promise<CompanyVerification>
  /** A link where the company completes the provider's verification. */
  startCompanyVerification(ctx: PaymentPartyContext): Promise<{ url: string }>
}

/**
 * A provider failure, and what the bank may hold because of it:
 *   - outcomeUnknown: the request may have reached the bank (a timeout, a
 *     network error after sending, a 5xx). A write is never repeated; the
 *     order is held until the bank's id, its debit or a person resolves it.
 *   - retryable (and not outcomeUnknown): it failed before the bank had
 *     anything (connection refused, a rate limit); trying again later is safe.
 *   - neither: a definitive refusal. The bank holds nothing, and the same
 *     instruction would be refused again.
 *
 * `instanceof` answers by a process-wide mark, not by the prototype
 * (lib/errors/brand.ts). A production server holds more than one copy of this
 * module (one per bundler layer, lib/global-singleton.ts): lib/init builds the
 * Connect adapter in the instrumentation hook's copy, so the adapter throws
 * that copy's class while a route catches with its own. A prototype check then
 * answered false for every provider failure, and the signing read each one as
 * UNEXPECTED_ERROR: a refused create held as an unknown outcome, a bank that
 * would not start a second authorisation never sent to the recreate
 * (crm#1282).
 */
const PAYMENT_PROVIDER_ERROR = 'accounted.payments.providerError'

export class PaymentProviderError extends Error {
  readonly name = 'PaymentProviderError'
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
    readonly outcomeUnknown: boolean = false,
  ) {
    super(message)
    brandError(this, PAYMENT_PROVIDER_ERROR)
  }

  static [Symbol.hasInstance](value: unknown): value is PaymentProviderError {
    return isBrandedInstance(this, PaymentProviderError, PAYMENT_PROVIDER_ERROR, value)
  }
}

/** What a failed write at the bank leaves behind. Anything that is not a PaymentProviderError is unknown. */
export type ProviderWriteOutcome = 'refused' | 'not_sent' | 'unknown'

export function providerWriteOutcome(error: unknown): ProviderWriteOutcome {
  if (!(error instanceof PaymentProviderError) || error.outcomeUnknown) return 'unknown'
  return error.retryable ? 'not_sent' : 'refused'
}

// Process-wide (lib/global-singleton.ts): lib/init registers the provider
// through its own copy of this module, a route reads it through another.
const providers = globalSingleton(
  'paymentInitiationProviders',
  () => new Map<PaymentProviderId, PaymentInitiationProvider>(),
)

export function registerPaymentInitiationProvider(provider: PaymentInitiationProvider): void {
  providers.set(provider.id, provider)
}

/**
 * Registration-time idempotency for lib/init: register what `create` builds
 * unless `id` already has a provider (a test's fake, an earlier init).
 * Returns whether it registered one. Reads the map directly because it runs
 * inside init, where the async getters below would wait on the init that is
 * calling them.
 */
export function registerPaymentInitiationProviderIfAbsent(
  id: PaymentProviderId,
  create: () => PaymentInitiationProvider | null,
): boolean {
  if (providers.has(id)) return false
  const provider = create()
  if (!provider) return false
  registerPaymentInitiationProvider(provider)
  return true
}

/**
 * The provider for a company, or null when paying through the bank is
 * unavailable. Like every getter here it waits for lib/init, which registers
 * the providers (lib/initialized.ts).
 */
export async function getPaymentInitiationProvider(companyId: string): Promise<PaymentInitiationProvider | null> {
  await whenInitialized()
  for (const provider of providers.values()) {
    if (provider.isAvailableFor(companyId)) return provider
  }
  return null
}

export async function getPaymentInitiationProviderById(id: PaymentProviderId): Promise<PaymentInitiationProvider | null> {
  await whenInitialized()
  return providers.get(id) ?? null
}

/** Whether this installation has any payments provider at all; false means every payments door is dark. */
export async function hasPaymentInitiationProviders(): Promise<boolean> {
  await whenInitialized()
  return providers.size > 0
}

/** Tests only. */
export function resetPaymentInitiationProviders(): void {
  providers.clear()
}
