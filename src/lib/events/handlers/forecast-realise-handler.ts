import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { realiseForecastRows } from '@/lib/forecast/realise'

/**
 * Actuals replace forecasts, on arrival: when bank rows arrive (a bank sync,
 * a bank file), the open liquidity forecast rows they pay are marked
 * realised (lib/forecast/realise.ts). Only the forecast's own rows are
 * written; nothing is booked. Best effort inline: a failure is logged by the
 * bus and never fails the sync; from the outbox it throws and is retried.
 */
export async function realiseForecastRowsOnArrival({ transactions, companyId }: EventPayload<'transaction.synced'>): Promise<void> {
  if (!companyId || !Array.isArray(transactions) || transactions.length === 0) return
  await realiseForecastRows(createServiceClientNoCookies(), companyId, transactions)
}
