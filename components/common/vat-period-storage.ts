/**
 * Per-company persistence for the VAT declaration cadence picker, mirroring
 * the FyPicker pattern (components/common/fiscal-year-storage.ts): plain
 * localStorage keyed by company id. The stored value is a JSON
 * StoredVatCadence; parsing and the decision of whether a stored cadence
 * still applies live in lib/vat/period-selection.ts so they can be
 * unit-tested without a browser.
 */

import { parseStoredVatCadence, type StoredVatCadence } from '@/lib/vat/period-selection'

export const VAT_PERIOD_STORAGE_KEY_PREFIX = 'Accounted:vat-period:'

export function readStoredVatCadence(companyId: string): StoredVatCadence | null {
  if (typeof window === 'undefined') return null
  try {
    return parseStoredVatCadence(
      window.localStorage.getItem(VAT_PERIOD_STORAGE_KEY_PREFIX + companyId),
    )
  } catch {
    return null
  }
}

export function writeStoredVatCadence(companyId: string, cadence: StoredVatCadence): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(VAT_PERIOD_STORAGE_KEY_PREFIX + companyId, JSON.stringify(cadence))
  } catch {
    // Storage unavailable (private mode, quota): the picker just falls back
    // to the setting-derived default next visit.
  }
}
