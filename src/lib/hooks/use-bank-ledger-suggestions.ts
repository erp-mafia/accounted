'use client'

import { useEffect, useState } from 'react'
import { useCompany } from '@/contexts/CompanyContext'
import { fetchLedgerSuggestions, onLedgerSuggestionsForgotten } from '@/lib/cash-accounts/ledger-suggestion-client'
import type { LedgerSuggestionView } from '@/lib/cash-accounts/ledger-suggestion-view'

/**
 * The active company's ledger-account suggestions (crm#1066), read after the
 * first render so no page waits for them. Empty until the answer is in, and
 * empty when the read fails: the notice simply does not show.
 *
 * `connectionId` narrows to one bank connection (the bank picker). `enabled`
 * false reads nothing (a viewer cannot act on a suggestion; a closed dialog
 * has nothing to preselect). Reads again whenever the mapping changed
 * (forgetLedgerSuggestions).
 */
export function useBankLedgerSuggestions(options: { enabled?: boolean; connectionId?: string } = {}): {
  suggestions: LedgerSuggestionView[]
} {
  const { enabled = true, connectionId } = options
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const key = companyId && enabled ? `${companyId}:${connectionId ?? ''}` : null
  // Keyed by what was asked: an answer for another company or connection is
  // never shown while the next one loads.
  const [answer, setAnswer] = useState<{ key: string; suggestions: LedgerSuggestionView[] } | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => onLedgerSuggestionsForgotten(() => setVersion((n) => n + 1)), [])

  useEffect(() => {
    if (!key || !companyId) return
    let cancelled = false
    fetchLedgerSuggestions(companyId, { connectionId })
      .then((suggestions) => {
        if (!cancelled) setAnswer({ key, suggestions })
      })
      .catch(() => {
        if (!cancelled) setAnswer({ key, suggestions: [] })
      })
    return () => {
      cancelled = true
    }
  }, [key, companyId, connectionId, version])

  return { suggestions: key && answer?.key === key ? answer.suggestions : [] }
}
