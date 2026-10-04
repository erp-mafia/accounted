import type { SignerInput } from './party'

/**
 * The signer details a bank wants from the browser session: the person's IP
 * address and user agent (PSU-IP-Address / PSU-User-Agent, forwarded for the
 * bank's own fraud checks) and, when typed, the personnummer.
 */
export function signerFromRequest(request: Request, personalNumber: string | null | undefined): SignerInput {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null
  return {
    personalNumber: personalNumber?.trim() || null,
    ipAddress: ip,
    userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
  }
}
