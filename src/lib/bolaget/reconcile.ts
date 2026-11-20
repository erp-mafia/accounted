/**
 * The aktiebok against the company settings: the number of shares the
 * register holds against company_settings.antal_aktier (the figure the
 * annual report's aktiekapital note prints, ÅRL 5:34 as the settings say).
 * A mismatch is a warning: either the register lacks an entry or the
 * settings are stale, and only a person knows which. Pure.
 */
import { roundOre } from '@/lib/money'

export type ShareCapitalStatus = 'match' | 'mismatch' | 'settings_empty' | 'register_empty' | 'both_empty'

export interface ShareCapitalReconciliation {
  status: ShareCapitalStatus
  register_shares: number
  settings_shares: number | null
  aktiekapital: number | null
  /** aktiekapital / antal aktier, when both are known (never stored). */
  kvotvarde: number | null
}

export function reconcileWithSettings(
  registerShares: number,
  settings: { aktiekapital: number | null; antal_aktier: number | null },
): ShareCapitalReconciliation {
  const settingsShares = settings.antal_aktier && settings.antal_aktier > 0 ? settings.antal_aktier : null
  const status: ShareCapitalStatus =
    registerShares === 0 && settingsShares === null
      ? 'both_empty'
      : registerShares === 0
        ? 'register_empty'
        : settingsShares === null
          ? 'settings_empty'
          : settingsShares === registerShares
            ? 'match'
            : 'mismatch'
  return {
    status,
    register_shares: registerShares,
    settings_shares: settingsShares,
    aktiekapital: settings.aktiekapital,
    kvotvarde: settings.aktiekapital && settingsShares ? roundOre(settings.aktiekapital / settingsShares) : null,
  }
}
