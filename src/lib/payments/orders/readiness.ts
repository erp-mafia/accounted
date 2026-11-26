/**
 * Whether a company is ready to pay through the bank, and if not, what stands
 * in the way: one answer for every surface that decides it (the payment
 * dialog, the supplier invoice list, Betalningar, the Betalningar settings
 * page, the signing refusal and the Att göra row), so none of them keeps its
 * own copy of the rules.
 *
 *   unavailable            bank payments are not open to the company: no
 *                          provider on the installation, outside the pilot,
 *                          no paid plan, or a sandbox (the availability's
 *                          reason says which; switched-on.ts)
 *   no_account             open, but no account a payment can leave from
 *   ready                  a payment can be signed: the company is verified,
 *                          or no account it can pay from needs it
 *   verification_needed    a person must start the verification, make a new
 *                          form link, or renew a lapsed one
 *   verification_pending   a form is out and the provider's answer is awaited
 *   verification_unknown   the verification could not be read
 *
 * Pure: the session route (availability.ts getPaymentsReadiness), the
 * worklist and the browser all derive it from the same inputs.
 */

import { FORM_OUT_STATES, type VerificationState } from './verification-state'

/** The account context of a payment call (debtor.ts paymentAccountContext). */
export type PaymentAccountContext = 'corporate' | 'private'

/**
 * Whether a payment from an account in this context waits for the company's
 * verification. The corporate context only, exactly the signing gate
 * (signing.ts): whether a private-context payment (an enskild firma on the
 * owner's private agreement) needs one is the provider's open question, and
 * until it is answered such a payment is tried without it.
 */
export function verificationRequiredFor(context: PaymentAccountContext): boolean {
  return context === 'corporate'
}

export const PAYMENTS_READINESS = [
  'unavailable',
  'no_account',
  'ready',
  'verification_needed',
  'verification_pending',
  'verification_unknown',
] as const

export type PaymentsReadiness = (typeof PAYMENTS_READINESS)[number]

/** What the readiness needs of an account (availability.ts PayableAccount). */
export interface ReadinessAccount {
  payable: boolean
  account_context: PaymentAccountContext
}

/**
 * The verification alone: verified (valid, or expiring, which still pays),
 * a form out, or a person's step. Null is a verification that could not be read.
 */
export function verificationReadiness(
  state: VerificationState | null,
): Extract<PaymentsReadiness, 'ready' | 'verification_needed' | 'verification_pending' | 'verification_unknown'> {
  if (state === null) return 'verification_unknown'
  if (state === 'valid' || state === 'expiring') return 'ready'
  if (FORM_OUT_STATES.has(state)) return 'verification_pending'
  return 'verification_needed'
}

/**
 * The company's readiness from what availability and the verification read
 * answer. `accounts` is every account the company has (the session route) or
 * the one a payment leaves from (the payment dialog): the verification
 * counts only when a payable account among them needs it.
 */
export function paymentsReadiness(input: {
  available: boolean
  accounts: readonly ReadinessAccount[]
  verification: { state: VerificationState } | null
}): PaymentsReadiness {
  if (!input.available) return 'unavailable'
  const payable = input.accounts.filter((a) => a.payable)
  if (payable.length === 0) return 'no_account'
  if (!payable.some((a) => verificationRequiredFor(a.account_context))) return 'ready'
  return verificationReadiness(input.verification?.state ?? null)
}

/** The one thing a person can do about the verification now: the button's job. */
export type VerificationStep = 'verify' | 'new_link' | 'renew' | 'open_form' | 'none'

/**
 * The step by state. A form opened in this sitting (its link at hand) is
 * opened again; one opened elsewhere, one handed to a firmatecknare (its link
 * may be lost, and the 24 hours would hold the company), or a dead link gets
 * a fresh link, as the Koppla banken step offers; a lapsed or lapsing
 * verification is renewed; none at all is started.
 */
export function verificationStep(state: VerificationState, options: { formAtHand?: boolean } = {}): VerificationStep {
  if (options.formAtHand && FORM_OUT_STATES.has(state)) return 'open_form'
  switch (state) {
    case 'not_started':
      return 'verify'
    case 'form_open':
    case 'awaiting_signatory':
    case 'link_expired':
      return 'new_link'
    case 'expiring':
    case 'expired':
      return 'renew'
    case 'valid':
      return 'none'
  }
}
