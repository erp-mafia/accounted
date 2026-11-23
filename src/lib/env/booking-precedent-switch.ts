/**
 * BOOKING_PRECEDENT_COMPANY_IDS: for the listed companies, a bank row with no
 * counterparty rule leads with how the company last booked that counterparty
 * (lib/transactions/booking-precedent.ts), and auto-learned mapping rows are
 * neither written nor read (lib/bookkeeping/mapping-engine.ts). Unset =
 * nobody: every company's proposals are what they were.
 *
 * It rolls out per company: `*` opens it for every company, a comma-separated
 * list of company ids for those only.
 *
 * Read on the server only.
 */
type Env = Record<string, string | undefined>

export type BookingPrecedentRollout = 'all' | readonly string[]

/** The companies in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function bookingPrecedentRollout(env: Env = process.env): BookingPrecedentRollout {
  const raw = env.BOOKING_PRECEDENT_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether the switch is on for this company. */
export function isBookingPrecedentEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = bookingPrecedentRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}
