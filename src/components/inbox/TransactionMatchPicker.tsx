'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { MagnifyingGlassIcon, SpinnerIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import type { InvoiceExtractionResult } from '@/types'
import { useUnderlagBankCandidates } from './use-underlag-bank-candidates'
import { getErrorMessage } from '@/lib/errors/get-error-message'

// TransactionMatchPicker
//
// Opens from the InvoiceInboxWorkspace FieldsRail when the user clicks
// "Matcha mot transaktion" on an inbox item whose matched_transaction_id is
// null. Lists *unbooked* transactions only: matching points an underlag at
// the bank payment you're about to book, so booked rows are out of scope
// (and surfacing them would invite a double-booking via "Bokför manuellt").
// That is the /api/transactions?unmatched=true set: no verifikat, not
// ignored, not booked through a samlingsverifikat or a split. Two modes:
//   • Suggested (no search): the newest unbooked rows, ranked best-first. No
//     date window: a hard window silently dropped late payments.
//   • Search (≥2 chars): the same unbooked set across ALL dates, narrowed in
//     the database by description/merchant, so a search finds rows outside
//     the suggested list.
// Rows, the underlag's FX rate and the ranking come from
// useUnderlagBankCandidates, the hook Bokför direkt uses too. Amounts compare
// currency-aware (lib/documents/underlag-bank-candidates). User picks one →
// POST /items/:id/match-transaction → onMatched callback.

interface CandidateTransaction {
  id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number
  currency: string
  /** SEK-equivalent for non-SEK transactions, for the "≈ … kr" hint. */
  amountSek: number | null
  confidence: number
  reasons: string[]
}

interface Props {
  open: boolean
  onClose: () => void
  inboxItemId: string
  extractedData: InvoiceExtractionResult | null
  onMatched: (transactionId: string) => void
}

export default function TransactionMatchPicker({
  open,
  onClose,
  inboxItemId,
  extractedData,
  onMatched,
}: Props) {
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [matchingId, setMatchingId] = useState<string | null>(null)

  // Rows, FX rate and ranking: the one hook both inbox surfaces use.
  const {
    facts,
    ranked,
    loading,
    error: loadError,
    totalSek: receiptSek,
    amountMatchUnavailable,
  } = useUnderlagBankCandidates({ open, extractedData, search })
  const { total, currency: receiptCurrency, supplier, prominentAmounts } = facts
  const rawInvoiceDate = facts.invoiceDate
  const hasInvoiceDate = rawInvoiceDate != null

  // ── Reset the search each time the dialog opens ──────────────
  useEffect(() => {
    if (open) setSearch('')
  }, [open])

  useEffect(() => {
    if (!loadError) return
    toast({
      title: 'Kunde inte hämta transaktioner',
      description: loadError,
      variant: 'destructive',
    })
  }, [loadError, toast])

  const candidates = useMemo<CandidateTransaction[]>(
    () =>
      ranked.map((r) => ({
        id: r.row.id,
        date: r.row.date,
        description: r.row.description ?? null,
        merchant_name: r.row.merchant_name ?? null,
        amount: r.row.amount,
        currency: r.currency,
        amountSek: r.amountSek,
        confidence: r.confidence,
        reasons: r.reasons,
      })),
    [ranked],
  )

  // Instant client-side narrowing while the debounced server query catches up.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((c) => {
      const hay = `${c.description ?? ''} ${c.merchant_name ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [candidates, search])

  // Any typed text counts as "searching" for labelling/empty-state purposes
  // (1 char narrows the suggested set client-side; ≥2 also hits the server).
  const hasSearchText = search.trim().length > 0

  async function handlePick(transactionId: string) {
    setMatchingId(transactionId)
    try {
      const res = await fetch(
        `/api/extensions/ext/invoice-inbox/items/${inboxItemId}/match-transaction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id: transactionId }),
        },
      )
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        toast({
          title: 'Kunde inte matcha',
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      onMatched(transactionId)
      onClose()
    } finally {
      setMatchingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Matcha mot transaktion</DialogTitle>
          <DialogDescription>
            Välj banktransaktionen som hör till underlaget.
          </DialogDescription>
        </DialogHeader>

        {/* Underlag reference: what we're matching against, so a currency or
            amount mismatch with a candidate is obvious at a glance. */}
        {(total != null || prominentAmounts.length > 0 || supplier) && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs flex items-center gap-x-3 gap-y-1 flex-wrap">
            <span className="text-muted-foreground shrink-0">Underlag</span>
            {supplier && <span className="font-medium truncate">{supplier}</span>}
            {total != null && (
              <span className="tabular-nums font-medium shrink-0">
                {formatCurrency(total, receiptCurrency)}
                {receiptSek != null && receiptCurrency !== 'SEK' && (
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    ≈ {formatCurrency(receiptSek, 'SEK')}
                  </span>
                )}
              </span>
            )}
            {total == null && prominentAmounts.length > 0 && (
              <span className="tabular-nums font-medium shrink-0">
                {prominentAmounts.map((a) => formatCurrency(a.amount, receiptCurrency)).join(' · ')}
              </span>
            )}
            {hasInvoiceDate && rawInvoiceDate && (
              <span className="text-muted-foreground tabular-nums shrink-0">
                {formatDate(rawInvoiceDate)}
              </span>
            )}
          </div>
        )}

        {amountMatchUnavailable && (
          <p className="text-[11px] text-muted-foreground -mt-1">
            Växelkurs saknas för {receiptCurrency}: kandidaterna rankas på datum
            och leverantör, inte belopp.
          </p>
        )}

        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Sök i alla transaktioner…"
            className="pl-9"
          />
        </div>

        <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
          <span>{hasSearchText ? 'Sökresultat' : 'Föreslagna matchningar'}</span>
          {!loading && <span className="tabular-nums">{filtered.length} st</span>}
        </div>

        <div className="max-h-[55vh] overflow-y-auto -mx-6 px-6 divide-y">
          {loading ? (
            <div className="space-y-3 py-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground text-center">
              {hasSearchText
                ? `Inga okategoriserade transaktioner matchar "${search.trim()}".`
                : 'Inga okategoriserade transaktioner att matcha mot.'}
            </p>
          ) : (
            filtered.map((c) => {
              // A strong match is the expected case, so it reads as muted
              // text; only the weaker tiers get a chip.
              const tier =
                c.confidence >= 0.8 ? null : c.confidence >= 0.5 ? 'warning' : 'outline'
              const tierLabel =
                c.confidence >= 0.8
                  ? 'Stark match'
                  : c.confidence >= 0.5
                    ? 'Möjlig match'
                    : 'Svag match'
              const isMatching = matchingId === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => void handlePick(c.id)}
                  disabled={!!matchingId}
                  className={cn(
                    'w-full text-left flex items-center gap-3 py-3 hover:bg-secondary/35 transition-colors px-2 -mx-2 rounded-sm',
                    matchingId && !isMatching && 'opacity-50',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">
                        {c.merchant_name ?? c.description ?? 'Okänd transaktion'}
                      </span>
                      {tier ? (
                        <Badge variant={tier} className="shrink-0 text-[11px]">
                          {tierLabel}
                        </Badge>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">{tierLabel}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                      <span>{formatDate(c.date)}</span>
                      {c.reasons.length > 0 && (
                        <>
                          <span>·</span>
                          <span className="truncate">{c.reasons.join(' · ')}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-medium tabular-nums">
                      {formatCurrency(c.amount, c.currency)}
                    </p>
                    {c.amountSek != null && (
                      <p className="text-[11px] text-muted-foreground tabular-nums">
                        ≈ {formatCurrency(c.amountSek, 'SEK')}
                      </p>
                    )}
                  </div>
                  {isMatching && <SpinnerIcon className="h-4 w-4 animate-spin text-muted-foreground" />}
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
