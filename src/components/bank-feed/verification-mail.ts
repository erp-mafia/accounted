/**
 * Hand the payments verification to a signatory: a mailto with the
 * provider's form link, so whoever may sign for the company opens it on
 * their own device. The link is valid 24 hours; the mail says so.
 */

export interface VerificationMailInput {
  subject: string
  /** The two lines above the link; the link goes on its own line after them. */
  lines: readonly [string, string]
  url: string
}

export function verificationMailto({ subject, lines, url }: VerificationMailInput): string {
  const body = `${lines[0]}\n${lines[1]}\n\n${url}`
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

import { BANK_CONNECT_RETURN_PARAM } from '@/lib/bank-feed/return-url'

/**
 * The URL a second signatory opens to finish a connection that waits for
 * them: the Kopplingar page with the connection named, which the page turns
 * into the flow at the BankID step. The same parameter names the connection
 * when a bank's own page sends the browser back (return-link.ts).
 */
export const RESUME_PARAM = BANK_CONNECT_RETURN_PARAM

export function resumeFlowUrl(origin: string, connectionId: string): string {
  return `${origin}/settings/connections?${RESUME_PARAM}=${encodeURIComponent(connectionId)}`
}
