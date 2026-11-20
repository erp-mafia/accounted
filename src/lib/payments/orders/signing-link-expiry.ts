/**
 * When a payment signing link runs out, the way a Swedish reader says it:
 * "17 oktober 2026 kl. 14:05", in Stockholm time. Isomorphic: the mail and
 * the page at /betala/<token> say the same.
 */
export function formatSigningLinkExpiry(iso: string): string {
  const date = new Date(iso)
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'long', year: 'numeric' }).format(date)
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(date)
  return `${day} kl. ${time}`
}
