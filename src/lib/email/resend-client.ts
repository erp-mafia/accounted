import { Resend } from 'resend'

/**
 * The Resend client for this installation, shared by sending, sending
 * domains, the delivery webhook and the inbound inbox. Throws when
 * RESEND_API_KEY is not set: callers that may run without Resend check the
 * provider first (email-provider.ts).
 */
export function getResendClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is required')
  return new Resend(apiKey)
}
