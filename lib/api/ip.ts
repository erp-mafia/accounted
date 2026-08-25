/**
 * Truncate a client IP to a privacy-preserving prefix for rate limiting and
 * forensic logging: IPv4 to its /24, IPv6 to its /48. Enough for abuse
 * correlation, not enough to identify a point of presence.
 *
 * Honors `x-forwarded-for` when set (Vercel / proxies); behind Vercel the
 * leftmost value is rewritten by the edge so we accept it as authoritative.
 *
 * Lives in its own module (no route or init imports) so both the v1 REST
 * wrapper and the MCP server can use it without an import cycle.
 */
export function truncateIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  // IPv4: validate octets are 0-255, then drop last octet → "203.0.113.0/24".
  // Out-of-range octets indicate a spoofed or malformed header; refuse to
  // log a pseudo-IP that would pollute abuse-pattern analysis.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map((s) => Number.parseInt(s, 10))
    if (octets.every((o) => o >= 0 && o <= 255)) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
    }
    return undefined
  }
  // IPv6: keep first 3 hextets → "2001:db8:abc::/48"
  const v6 = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):/i.exec(ip)
  if (v6) return `${v6[1]}::/48`
  return undefined
}

/**
 * The client IP as the request presents it: leftmost `x-forwarded-for`
 * entry, else `x-real-ip`, else undefined.
 */
export function requestClientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || undefined
  return request.headers.get('x-real-ip') ?? undefined
}
