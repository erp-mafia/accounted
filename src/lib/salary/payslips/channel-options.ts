import type { DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'

/**
 * The channel choice behind "Skicka lönebesked" on the salary run page.
 * Client-safe: the send itself is lib/salary/payslips/send.ts, which takes
 * the same channel as POST /api/salary/runs/{id}/payslips/send { channel }.
 */
export type PayslipSendChannel = 'email' | DigitalMailboxProviderId

/**
 * Billo before Kivra: Billo reaches every employee with a personnummer (one
 * without Billo gets a BankID link by sms or email), Kivra only its users.
 */
const MAILBOX_ORDER: readonly DigitalMailboxProviderId[] = ['billo', 'kivra']

/**
 * The choices the send offers, in the order the dialog lists them: the email
 * link first (the default), then each mailbox the company sends through.
 * Only email means no choice to make.
 */
export function payslipChannelOptions(activeProviders: readonly DigitalMailboxProviderId[]): PayslipSendChannel[] {
  return ['email', ...MAILBOX_ORDER.filter((provider) => activeProviders.includes(provider))]
}

/** The pick while it is still offered, else the email link. */
export function resolvePayslipChannel(
  choice: PayslipSendChannel | null,
  options: readonly PayslipSendChannel[],
): PayslipSendChannel {
  return choice && options.includes(choice) ? choice : 'email'
}

/**
 * The send request. The email link posts no body, exactly as before the
 * mailbox channels; a mailbox posts { channel }.
 */
export function payslipSendRequest(channel: PayslipSendChannel): RequestInit {
  if (channel === 'email') return { method: 'POST' }
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  }
}
