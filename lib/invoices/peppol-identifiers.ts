import { peppolParticipantSchema } from '@accounted/connect-contract'

/**
 * One definition of what a Peppol participant identifier looks like once the
 * transport noise is stripped, shared by the document reader (EndpointID as
 * the sender wrote it), the recipient resolver (what our registrations hold)
 * and any comparison between the two. Mirrors the hosted connector's rules
 * (accounted-connect) so both sides route the same document to the same
 * registration.
 *
 * - 0007 (Swedish organisation number): digits only; the twelve-digit form
 *   some senders use (16 + orgnr) is reduced to the ten-digit number.
 * - every other scheme: whitespace removed, nothing else assumed about the
 *   alphabet (0088 GLN is digits, 0192 NO:ORGNR is digits, 9915 AT:GOV is
 *   alphanumeric).
 */
export function normalizePeppolIdentifier(scheme: string, identifier: string): string {
  if (scheme.trim() === '0007') {
    const digits = identifier.replace(/\D/g, '')
    return digits.length === 12 && digits.startsWith('16') ? digits.slice(2) : digits
  }
  return identifier.replace(/\s/g, '')
}

/**
 * A Peppol participant scheme is a four-digit ICD code (0007, 0088, 0192).
 * The rule is the contract's, so the archive's CHECK, the hosted proxy and
 * the document reader agree on what a scheme is.
 */
export function isPeppolScheme(scheme: string): boolean {
  return peppolParticipantSchema.shape.scheme.safeParse(scheme.trim()).success
}
