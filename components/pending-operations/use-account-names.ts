'use client'

import { useMemo } from 'react'
import { useAccounts } from '@/lib/reference-data/hooks'

/**
 * Account number -> account name for the proposal previews. Provide the
 * result through AccountNamesContext (OperationPreview) so every preview
 * surface (the /pending queue, the chat ApprovalCard) shows "6110
 * Kontorsmateriel" and not just the number or the bank's raw text.
 * Display-only: derived from the session-cached chart (lib/reference-data),
 * so it costs no request of its own; while the chart is unavailable the map
 * is empty and previews fall back to the number.
 */
export function useAccountNamesSource(): Record<string, string> {
  const { accounts } = useAccounts()
  return useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.account_number, a.account_name])),
    [accounts],
  )
}
