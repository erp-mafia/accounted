'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useCompany } from '@/contexts/CompanyContext'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  searchUnmatchedOutgoingTransactions,
  type UnmatchedOutgoingTransaction,
} from '@/lib/transactions/outgoing-transaction-search'
import { ArrowDownRightIcon, MagnifyingGlassIcon } from '@/components/icons'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'

/** Pause after the last keystroke before the search goes to the database. */
const SEARCH_DEBOUNCE_MS = 250

interface BankTransactionPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Invoice total in invoice currency. Used to rank transactions by amount proximity. */
  targetAmount: number
  /** Invoice currency. Used to filter the candidate list when set. */
  targetCurrency: string
  onPick: (transactionId: string) => void
}

/**
 * Lightweight picker for unmatched outgoing bank transactions. Used by
 * `/supplier-invoices/new` when the user wants to register an invoice and
 * mark it paid against a specific bank transaction in one go.
 *
 * Filters: negative amount, no journal entry, no supplier_invoice link.
 * Ranks by absolute amount-difference vs `targetAmount`.
 */
export default function BankTransactionPicker({
  open,
  onOpenChange,
  targetAmount,
  targetCurrency,
  onPick,
}: BankTransactionPickerProps) {
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const [transactions, setTransactions] = useState<UnmatchedOutgoingTransaction[]>([])
  const tCommon = useTranslations('common')
  const [isLoading, setIsLoading] = useState(false)
  // The rows could not be read: said in place of them, with "Försök igen".
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  // The term the database was asked for, trailing the input by a short pause.
  const [appliedSearch, setAppliedSearch] = useState('')

  useEffect(() => {
    const handle = setTimeout(() => setAppliedSearch(searchTerm.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [searchTerm])

  useEffect(() => {
    if (!open || !company) return
    const companyId = company.id
    let cancelled = false

    ;(async () => {
      setIsLoading(true)
      // No strict currency filter: the bank transaction that pays a
      // foreign-currency invoice is almost always in the company's domestic
      // currency (e.g. SEK bank account paying a USD invoice). The user
      // would see "no matches" if we filtered to the invoice currency.
      // Cross-currency amount diff is hidden in the row below so the user
      // isn't shown a misleading "Diff X kr" against a USD target.
      // The search runs in the database across every unmatched outgoing row:
      // the newest-first list is capped, so filtering it here could never
      // find an older payment.
      try {
        const { rows } = await searchUnmatchedOutgoingTransactions(supabase, companyId, appliedSearch)
        if (!cancelled) {
          setTransactions(rows)
          setLoadFailed(false)
        }
      } catch {
        if (!cancelled) {
          setTransactions([])
          setLoadFailed(true)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, company, supabase, appliedSearch, attempt])

  const filtered = useMemo(() => {
    const matches = [...transactions]
    // Rank by amount proximity only when currencies match: comparing a USD
    // target to a SEK transaction numerically would produce a meaningless
    // ranking. Cross-currency rows fall back to date-desc order.
    return matches.sort((a, b) => {
      const aSame = a.currency === targetCurrency
      const bSame = b.currency === targetCurrency
      if (aSame !== bSame) return aSame ? -1 : 1
      if (!aSame) return 0
      const da = Math.abs(Math.abs(a.amount) - targetAmount)
      const db = Math.abs(Math.abs(b.amount) - targetAmount)
      return da - db
    })
  }, [transactions, targetAmount, targetCurrency])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" className="flex flex-col">
        <DialogHeader>
          <DialogTitle>Välj banktransaktion</DialogTitle>
          <DialogDescription>
            Välj den utgående banktransaktion som motsvarar denna faktura. Fakturan registreras och markeras som betald i ett steg.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Sök på beskrivning..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 -mx-1 px-1">
          {isLoading ? (
            <LateReveal aria-label="Laddar transaktioner" className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </LateReveal>
          ) : loadFailed ? (
            <LoadError onRetry={() => setAttempt((n) => n + 1)} />
          ) : filtered.length === 0 ? (
            appliedSearch === '' ? (
              <EmptyState icon={ArrowDownRightIcon} title="Inga okategoriserade utgifts­transaktioner hittades." />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
                <span data-ph-mask="">{`Inga transaktioner matchar "${appliedSearch}".`}</span>
                <Button variant="link" onClick={() => setSearchTerm('')}>
                  {tCommon('clear_search')}
                </Button>
              </div>
            )
          ) : (
            filtered.map((tx) => {
              const sameCurrency = tx.currency === targetCurrency
              const absAmount = Math.abs(tx.amount)
              const diff = sameCurrency ? Math.abs(absAmount - targetAmount) : null
              const isExact = diff != null && diff < 0.01
              return (
                <button
                  key={tx.id}
                  type="button"
                  onClick={() => onPick(tx.id)}
                  className="w-full text-left rounded-lg p-3 hover:border-primary/50 hover:bg-secondary/60 transition-colors bg-control shadow-raised"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{tx.description}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(tx.date)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono font-medium tabular-nums text-destructive">
                        {formatCurrency(tx.amount, tx.currency)}
                      </p>
                      {isExact ? (
                        <p className="text-xs text-success">Belopp matchar</p>
                      ) : diff != null && targetAmount > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Diff {formatCurrency(diff, tx.currency)}
                        </p>
                      ) : !sameCurrency ? (
                        <p className="text-xs text-muted-foreground">
                          Annan valuta
                        </p>
                      ) : null}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Avbryt
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
