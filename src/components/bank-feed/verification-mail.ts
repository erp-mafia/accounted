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

/**
 * The URL a second signatory opens to finish a connection that waits for
 * them: the Kopplingar page with the connection named, which the page turns
 * into the flow at the BankID step.
 */
export const RESUME_PARAM = 'bank_connect'

export function resumeFlowUrl(origin: string, connectionId: string): string {
  return `${origin}/settings/connections?${RESUME_PARAM}=${encodeURIComponent(connectionId)}`
}
