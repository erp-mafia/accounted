/**
 * Moments the way a Swedish reader says them, in Stockholm time:
 * "17 oktober 2026 kl. 14:05". Isomorphic: the mail, the signer's page and
 * the signed copy's evidence page say the same.
 */
export function formatSigningMoment(iso: string): string {
  const date = new Date(iso)
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'long', year: 'numeric' }).format(date)
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(date)
  return `${day} kl. ${time}`
}

/** The Stockholm calendar day of an instant: "2026-10-24". */
export function stockholmDay(iso: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

/** A signature's moment, short, in Stockholm time: "29 okt 2026, 09:21". */
export function formatSigningShortMoment(iso: string): string {
  const date = new Date(iso)
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(date)
  return `${part('day')} ${part('month').replace(/\.$/, '')} ${part('year')}, ${time}`
}
