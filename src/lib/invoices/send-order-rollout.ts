/**
 * INVOICE_SEND_ORDER_USER_IDS: who sees Vägar, the send order on
 * Försäljning → Utskick, while the company has no saved order
 * (comma-separated user ids, or `*` for everyone). Unset or empty means
 * nobody, so a deploy never changes the page for anyone.
 *
 * A company with a saved order (company_settings.invoice_send_order) sees it
 * whatever the list says, and the order applies to every company that has one.
 */
type Env = Record<string, string | undefined>

export type SendOrderRollout = 'all' | readonly string[]

/** The users in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function sendOrderRollout(env: Env = process.env): SendOrderRollout {
  const raw = env.INVOICE_SEND_ORDER_USER_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether this user sees the send order on Utskick without a saved order. */
export function isSendOrderSetupEnabled(userId: string | null | undefined, env: Env = process.env): boolean {
  if (!userId) return false
  const rollout = sendOrderRollout(env)
  return rollout === 'all' || rollout.includes(userId.toLowerCase())
}
