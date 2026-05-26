'use client'

import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCompany } from '@/contexts/CompanyContext'
import type { CashAccount } from '@/types'

const STORAGE_KEY_PREFIX = 'gnubok:cash-account:'

interface Props {
  /**
   * Current selection — a BAS ledger account number ('1930', '1932', …).
   * `null` would only be meaningful if "all accounts" were an option, which
   * isn't currently supported (reconciliation is always single-account).
   */
  value: string
  onChange: (accountNumber: string) => void
  /**
   * Optional label above the select. Pass null to render without a label.
   */
  label?: string | null
  /**
   * Called once after the initial fetch completes so callers can suppress a
   * skeleton until the selector is ready.
   */
  onReady?: () => void
  className?: string
}

/**
 * Cash account selector for reconciliation, drift, and any UI that scopes a
 * read to a particular settlement account (1930 SEK, 1932 EUR, …).
 *
 * Loads /api/cash-accounts for the active company, persists the last selection
 * per company in sessionStorage, and renders the same Select primitive as the
 * fiscal-year picker so the UX stays consistent.
 *
 * sessionStorage (not localStorage) so the selection clears when the tab/
 * session ends. The data is a UI preference, not a credential; persisting
 * which BAS account a company uses across sessions in browser storage would
 * couple company id + financial account reference for the lifetime of the
 * browser profile (GDPR Art. 25(2) data minimisation, ISO 27001 A.8.12).
 */
export function CashAccountSelector({
  value,
  onChange,
  label = 'Konto',
  onReady,
  className,
}: Props) {
  const { company } = useCompany()
  const [accounts, setAccounts] = useState<CashAccount[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!company?.id) {
      onReady?.()
      return
    }
    let cancelled = false
    ;(async () => {
      const res = await fetch('/api/cash-accounts')
      if (!res.ok) {
        if (!cancelled) {
          setLoaded(true)
          onReady?.()
        }
        return
      }
      const { data } = await res.json()
      if (cancelled) return

      const fetched: CashAccount[] = data || []
      // is_primary first (already ordered on the server), then by ledger code.
      setAccounts(fetched)
      setLoaded(true)

      // Restore last selection or pick the primary as default.
      if (typeof window !== 'undefined') {
        const stored = window.sessionStorage.getItem(STORAGE_KEY_PREFIX + company.id)
        const inFetched = (ledger: string) =>
          fetched.some(a => a.ledger_account === ledger)

        if (stored && inFetched(stored)) {
          if (stored !== value) onChange(stored)
        } else {
          const primary = fetched.find(a => a.is_primary)
          const fallback = primary ?? fetched[0]
          if (fallback && fallback.ledger_account !== value) {
            onChange(fallback.ledger_account)
          }
        }
      }

      onReady?.()
    })()
    return () => {
      cancelled = true
    }
  // onReady excluded — lifecycle callback, shouldn't retrigger on parent renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id])

  const handleChange = (next: string) => {
    if (company?.id && typeof window !== 'undefined') {
      window.sessionStorage.setItem(STORAGE_KEY_PREFIX + company.id, next)
    }
    onChange(next)
  }

  // Fallback when the table is empty (fresh company, no PSD2 connections yet):
  // show a single hardcoded '1930' option so the rest of the UI still works.
  const options = accounts.length > 0
    ? accounts.map(a => ({
        value: a.ledger_account,
        label: `${a.ledger_account} ${a.name ?? a.iban ?? a.currency}`,
      }))
    : [{ value: '1930', label: '1930 Bankkonto' }]

  return (
    <div className={className}>
      {label && <Label>{label}</Label>}
      <div className={`flex items-center gap-2 ${label ? 'mt-1' : ''}`}>
        <Select
          value={value}
          onValueChange={handleChange}
          disabled={!loaded && accounts.length === 0}
        >
          <SelectTrigger className="w-full sm:w-[280px]">
            <SelectValue placeholder={loaded ? 'Välj konto' : 'Laddar…'} />
          </SelectTrigger>
          <SelectContent>
            {options.map(o => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
