/**
 * The one settings refusal that is a question to the person: moving the lock
 * date back over momsperioder whose declaration is already filed
 * (409 BOOKKEEPING_LOCK_REOPENS_FILED_VAT, lib/company/settings-service.ts).
 * The page names the periods, the person confirms, and the save is sent again
 * with acknowledge_filed_vat_periods, the acknowledgment the API and MCP doors
 * take (components/settings/use-save-settings.ts).
 */

import type { ReopenedVatPeriod } from '@/lib/vat/filed-periods-reopened'

/**
 * The labels (tax_period: 2026-Q2, 2026-05, 2025/2026) of the filed periods a
 * refused save would reopen, read from the refusal's details. Null for any
 * other answer, and for this refusal without a readable period: that one is
 * shown as the refusal it is, never asked about blind.
 */
export function filedVatPeriodsInRefusal(body: unknown): string[] | null {
  const error = (body as { error?: unknown } | null)?.error
  if (!error || typeof error !== 'object') return null
  const { code, details } = error as { code?: unknown; details?: { filed_periods?: unknown } | null }
  if (code !== 'BOOKKEEPING_LOCK_REOPENS_FILED_VAT' || !Array.isArray(details?.filed_periods)) return null
  const labels = details.filed_periods
    .map((period: Partial<ReopenedVatPeriod> | null) => period?.tax_period)
    .filter((label): label is string => typeof label === 'string' && label.length > 0)
  return labels.length > 0 ? labels : null
}
