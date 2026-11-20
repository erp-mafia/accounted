/**
 * Enable Banking's PSU headers: the person behind a read, when a person asked
 * for it ("Synka nu", the first import after the account picker).
 *
 * Most banks allow a consent four background reads per account and day
 * (PSD2 RTS art. 36(5)). Enable Banking tells a background read from one the
 * person asked for by these headers alone: a read that carries them is not
 * counted against that budget, one without them is. The cron and the agent
 * sync are background reads and never send them.
 *
 * Enable Banking wants every header the bank requires or none, and IP address
 * and user agent are the two banks ask for. A read that cannot name both goes
 * without, as a background read. A bank that requires more, or refuses the
 * value (an IPv6 address at some banks), answers PSU_HEADER_NOT_PROVIDED or
 * PSU_HEADER_INVALID; the read is then retried once without the headers.
 */

export type PsuHeaders = {
  'Psu-Ip-Address': string
  'Psu-User-Agent': string
}

/** The headers for the person present, or undefined when IP address or user agent is unknown. */
export function psuHeadersOf(
  person: { ipAddress: string | null; userAgent: string | null } | null | undefined,
): PsuHeaders | undefined {
  const ipAddress = person?.ipAddress?.trim()
  const userAgent = person?.userAgent?.trim()
  if (!ipAddress || !userAgent) return undefined
  return { 'Psu-Ip-Address': ipAddress, 'Psu-User-Agent': userAgent }
}

/** Enable Banking refused the PSU headers we sent: a required one is missing, or one has a value the bank does not take. */
export function isPsuHeaderRefusal(body: string): boolean {
  return body.includes('PSU_HEADER_NOT_PROVIDED') || body.includes('PSU_HEADER_INVALID')
}
