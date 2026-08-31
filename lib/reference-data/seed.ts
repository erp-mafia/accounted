/**
 * Server-to-client seed for the reference-data cache.
 *
 * The dashboard layout already fetches company settings for its own nav;
 * adding the (small) fiscal-period and cash-account lists to that batch and
 * handing all three to SWR as `fallback` means the first form a user opens
 * renders its period, bank-account and settings-driven fields on the first
 * paint with zero client round trips. SWR consults `fallback` only while
 * the cache has no entry for the key, so after the first background
 * revalidation or any mutate() the live cache wins; a hard reload re-seeds.
 *
 * Keys are serialized with SWR's own `unstable_serialize` and built from
 * `refKeys`, so the seed can never drift from the hooks (pinned by a test).
 */

import { unstable_serialize } from 'swr'
import type { CashAccount, CompanySettings, FiscalPeriod } from '@/types'
import { refKeys } from './keys'

export interface ReferenceSeed {
  fiscalPeriods: FiscalPeriod[]
  cashAccounts: CashAccount[]
  /** `undefined` = not fetched (do not seed); `null` = no settings row yet. */
  settings?: CompanySettings | null
}

export function buildReferenceFallback(
  companyId: string | null,
  seed: ReferenceSeed,
): Record<string, unknown> {
  if (!companyId) return {}
  const fallback: Record<string, unknown> = {
    [unstable_serialize(refKeys.fiscalPeriods(companyId))]: seed.fiscalPeriods,
    [unstable_serialize(refKeys.cashAccounts(companyId))]: seed.cashAccounts,
  }
  if (seed.settings !== undefined) {
    fallback[unstable_serialize(refKeys.companySettings(companyId))] = seed.settings
  }
  return fallback
}
