/**
 * BOOKING_SCREEN_COMPANY_IDS: the booking screen at /bokfor, one full page
 * where a bank row or a new verifikation is booked with the betalning on
 * top, the underlag on the left and the kontering on the right. Unset =
 * nobody: the booking dialogs stay where they are for every company until
 * the operators flip it.
 *
 * It rolls out per company, like BOLAGET_COMPANY_IDS: `*` opens it for every
 * company, a comma-separated list of company ids for those only.
 *
 * What the switch never changes: how a booking posts. The screen books
 * through the same endpoints and the same form as the dialogs.
 */
type Env = Record<string, string | undefined>

export type BookingScreenRollout = 'all' | readonly string[]

/** The companies in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function bookingScreenRollout(env: Env = process.env): BookingScreenRollout {
  const raw = env.BOOKING_SCREEN_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether the booking screen is switched on for this company. */
export function isBookingScreenEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = bookingScreenRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}
