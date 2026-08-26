'use client'

import { useEffect, useState } from 'react'

/**
 * Account number -> account name for the proposal previews, fetched once per
 * mount for the active company. Provide the result through
 * AccountNamesContext (OperationPreview) so every preview surface (the
 * /pending queue, the chat ApprovalCard) shows "6110 Kontorsmateriel" and
 * not just the number or the bank's raw text. Display-only: a failed fetch
 * leaves the map empty and previews fall back to the number.
 */
export function useAccountNamesSource(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    void fetch('/api/bookkeeping/accounts')
      .then((r) => r.json())
      .then(({ data }) => {
        if (!alive) return
        setNames(
          Object.fromEntries(
            ((data ?? []) as Array<{ account_number: string; account_name: string }>).map((a) => [
              a.account_number,
              a.account_name,
            ]),
          ),
        )
      })
      .catch(() => {
        // Display-only: the number still shows, so a failure is not worth
        // surfacing as an error the user cannot act on.
      })
    return () => {
      alive = false
    }
  }, [])
  return names
}
