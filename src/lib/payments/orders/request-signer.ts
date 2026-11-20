import type { SignerInput } from './party'

/**
 * The signer details a bank wants from the browser session: the person's IP
 * address and user agent (PSU-IP-Address / PSU-User-Agent, forwarded for the
 * bank's own fraud checks) and, when typed, the personnummer and the Nordea
 * Corporate Netbank logon id (checked and dropped for other banks by the
 * party builders).
 */
export function signerFromRequest(request: Request, personalNumber: string | null | undefined, psuAuthoriserId?: string | null): SignerInput {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null
  const authoriser = psuAuthoriserId?.trim() || null
  return {
    personalNumber: personalNumber?.trim() || null,
    ipAddress: ip,
    userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
    ...(authoriser ? { psuAuthoriserId: authoriser } : {}),
  }
}
