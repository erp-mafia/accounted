'use client'

import { useEffect, useRef } from 'react'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCompany } from '@/contexts/CompanyContext'

const STORAGE_KEY_PREFIX = 'Accounted:cash-account:'

interface Props {
  /**
   * Current selection: a BAS ledger account number ('1930', '1932', …).
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
  // Session-cached and seeded by the dashboard layout (lib/reference-data):
  // on a normal visit the list is here on the first render, so the restore
  // below runs in the first effect tick and onReady fires without a round
  // trip. Restore once per company load, not on every background refresh.
  const { cashAccounts: accounts, isLoading } = useCashAccounts()
  const loaded = !isLoading
  const restoredForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!company?.id) {
      onReady?.()
      return
    }
    if (!loaded || restoredForRef.current === company.id) return
    restoredForRef.current = company.id

    // Restore last selection or pick the primary as default.
    if (typeof window !== 'undefined') {
      const stored = window.sessionStorage.getItem(STORAGE_KEY_PREFIX + company.id)
      const inFetched = (ledger: string) =>
        accounts.some(a => a.ledger_account === ledger)

      if (stored && inFetched(stored)) {
        if (stored !== value) onChange(stored)
      } else {
        const primary = accounts.find(a => a.is_primary)
        const fallback = primary ?? accounts[0]
        if (fallback && fallback.ledger_account !== value) {
          onChange(fallback.ledger_account)
        }
      }
    }

    onReady?.()
  // onReady/onChange are lifecycle callbacks: fire once per load, not on
  // parent re-renders that re-create them. `value` is read once at restore.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, loaded, accounts])

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
