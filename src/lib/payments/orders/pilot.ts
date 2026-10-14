/**
 * The half of the payments door that needs no provider: the pilot switch and
 * the paid plan (switched-on.ts explains both). Kept apart from switched-on.ts
 * because that module reaches the provider registry, and with it lib/init;
 * the worklist, which client pages import, gates on this half alone (a
 * company's verification record exists only where a provider once answered).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

/** The environment as a plain map: process.env, or a test's object. */
export type PaymentsEnv = Readonly<Record<string, string | undefined>>

/** The pilot switch, parsed: null = no pilot (the paid plan decides), 'all' = everyone, or the listed company ids. */
export type PaymentsPilot = null | 'all' | ReadonlySet<string>

export function paymentsPilot(env: PaymentsEnv = process.env): PaymentsPilot {
  const raw = env.OPENPAYMENTS_COMPANY_IDS?.trim()
  if (!raw) return null
  if (raw === '*') return 'all'
  const ids = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  return ids.length ? new Set(ids) : null
}

/** Whether the company may pay through the bank as far as the pilot and the plan go: 'not_in_pilot' and 'subscription' say why not. */
export async function paymentsAdmitted(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_in_pilot' | 'subscription' }> {
  const pilot = paymentsPilot()
  if (pilot === 'all') return { ok: true }
  if (pilot) return pilot.has(companyId) ? { ok: true } : { ok: false, reason: 'not_in_pilot' }
  if (await hasCapability(supabase, companyId, CAPABILITY.bank_sync)) return { ok: true }
  return { ok: false, reason: 'subscription' }
}
