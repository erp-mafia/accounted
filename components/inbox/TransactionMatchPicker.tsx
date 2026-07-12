'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
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
import { Loader2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  amountVarianceForMatch,
  calculateMatchConfidence,
  calculateMerchantSimilarity,
} from '@/lib/documents/core-receipt-matcher'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import type { InvoiceExtractionResult } from '@/types'

// TransactionMatchPicker
//
// Opens from the InvoiceInboxWorkspace FieldsRail when the user clicks
// "Matcha mot transaktion" on an inbox item whose matched_transaction_id is
// null. Lists *uncategorised* transactions only: matching points an underlag
// at the bank payment you're about to book, so already-booked rows are out of
// scope (and surfacing them would invite a double-booking via "Bokför
// manuellt"). Two modes:
//   • Suggested (no search): every uncategorised company transaction, scored
//     via lib/documents/core-receipt-matcher and sorted best-first. No date
//     window: over-fetching is cheap for a manual picker and a hard window
//     silently dropped late payments out of the candidate set.
//   • Search (≥2 chars): the same uncategorised set across ALL dates, narrowed
//     server-side by description/merchant. This is the fix for "not all
//     transactions come up to search for": the old client-only filter could
//     only see the windowed rows already fetched.
// Amounts are compared currency-aware (see scoring memo): same-currency raw,
// otherwise normalised to SEK via the underlag's FX rate. User picks one →
// POST /items/:id/match-transaction → onMatched callback.

interface RawTransaction {
  id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}

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

// Currencies the /api/currency/rate endpoint (Riksbanken) can resolve. Used
// to normalise a foreign-currency underlag total into SEK so it can be
// compared against SEK bank charges.
const SUPPORTED_FX = ['EUR', 'USD', 'GBP', 'NOK', 'DKK']

// Date tolerance used only for *ranking* candidates (not for filtering, there
// is no longer a date window). Far wider than the receipt matcher's tight ±3d
// default so a payment landing weeks or months after the invoice still earns
// partial date credit and the true match floats to the top, instead of every
// candidate collapsing to "Svag match".
const MATCH_DATE_TOLERANCE_DAYS = 120

// Minimum characters before a keystroke flips the picker into server-side
// search mode. Below this we stay on the scored suggestions and just narrow
// them client-side for instant feedback.
const SEARCH_MIN_CHARS = 2

export default function TransactionMatchPicker({
  open,
  onClose,
  inboxItemId,
  extractedData,
  onMatched,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const { company } = useCompany()
  const { toast } = useToast()

  // Starts true so the first paint after opening shows skeletons, not a flash
  // of the empty state before the fetch effect runs.
  const [loading, setLoading] = useState(true)
  const [rawRows, setRawRows] = useState<RawTransaction[]>([])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [matchingId, setMatchingId] = useState<string | null>(null)
  // SEK per unit of the underlag currency (e.g. ~11.5 for EUR). null = SEK
  // underlag, fetch pending, or unsupported/failed: amount matching then
  // falls back to same-currency-only.
  const [fxRate, setFxRate] = useState<number | null>(null)

  // ── Underlag (receipt) facts pulled from extracted_data ──────
  const rawInvoiceDate = extractedData?.invoice?.invoiceDate ?? null
  const hasInvoiceDate = useMemo(() => {
    if (!rawInvoiceDate) return false
    return !Number.isNaN(new Date(rawInvoiceDate).getTime())
  }, [rawInvoiceDate])
  // Default to today if no date was extracted so scoring still has an anchor.
  const invoiceDate = useMemo(() => {
    if (!rawInvoiceDate) return new Date()
    const parsed = new Date(rawInvoiceDate)
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed
  }, [rawInvoiceDate])
  const total = extractedData?.totals?.total ?? null
  const receiptCurrency = (extractedData?.invoice?.currency ?? 'SEK').toUpperCase()
  const supplier = extractedData?.supplier?.name ?? null

  // SEK value of the underlag total. For a SEK underlag that's the total
  // itself; for a foreign one it needs the fetched FX rate.
  const receiptSek = useMemo(() => {
    if (total == null) return null
    if (receiptCurrency === 'SEK') return total
    if (fxRate != null) return Math.round(total * fxRate * 100) / 100
    return null
  }, [total, receiptCurrency, fxRate])

  // True when the underlag is in a foreign currency we can't price right now:
  // amount matching is unavailable, so we say so instead of mis-ranking.
  const amountMatchUnavailable =
    total != null && receiptCurrency !== 'SEK' && receiptSek == null

  // ── Reset transient state each time the dialog opens ─────────
  useEffect(() => {
    if (!open) return
    setSearch('')
    setDebouncedSearch('')
    setRawRows([])
    setLoading(true)
  }, [open])

  // ── Debounce the search term feeding the server query ────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // ── Fetch the underlag's FX rate (foreign currency only) ─────
  useEffect(() => {
    if (!open) return
    setFxRate(null)
    if (receiptCurrency === 'SEK' || !SUPPORTED_FX.includes(receiptCurrency)) return
    let cancelled = false
    const dateParam = hasInvoiceDate && rawInvoiceDate ? `&date=${rawInvoiceDate}` : ''
    fetch(`/api/currency/rate?currency=${receiptCurrency}${dateParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return
        const rate = body?.data?.rate
        if (typeof rate === 'number' && rate > 0) setFxRate(rate)
      })
      .catch(() => {
        /* leave null: cross-currency amount signal simply drops out */
      })
    return () => {
      cancelled = true
    }
  }, [open, receiptCurrency, hasInvoiceDate, rawInvoiceDate])

  // ── Fetch candidate rows (suggested vs search mode) ──────────
  useEffect(() => {
    if (!open) return
    if (!company) return // provider still hydrating
    let cancelled = false
    setLoading(true)
    ;(async () => {
      // Strip PostgREST filter-DSL structural chars before interpolating into
      // `.or()`. Commas separate OR-conditions and parentheses group nested
      // filters, so leaving them in would let a search term inject a synthetic
      // clause (e.g. "Acme,company_id.neq.…"). `%` and `\` are LIKE wildcards/
      // escapes we also drop. `.` is safe: it stays inside the ilike value.
      const safe = debouncedSearch.trim().replace(/[%,()\\]/g, ' ').trim()
      const searchMode = safe.length >= SEARCH_MIN_CHARS

      // Defense-in-depth: RLS only narrows to "any company the user belongs
      // to". Multi-tenant users (consultants) would otherwise see other
      // companies' transactions. Filter to the active company explicitly.
      // Uncategorised only (journal_entry_id IS NULL) in both modes: see the
      // component header. The search just adds a server-side name filter so
      // matches outside the suggested set still surface.
      let query = supabase
        .from('transactions')
        .select(
          'id, date, description, merchant_name, amount, currency, amount_sek, exchange_rate',
        )
        .eq('company_id', company.id)
        .is('journal_entry_id', null)

      if (searchMode) {
        query = query
          .or(`description.ilike.%${safe}%,merchant_name.ilike.%${safe}%`)
          .order('date', { ascending: false })
          .limit(100)
      } else {
        // Recent first; scoring floats the best match up regardless of date.
        query = query.order('date', { ascending: false }).limit(300)
      }

      const { data, error } = await query
      if (cancelled) return
      if (error) {
        toast({
          title: 'Kunde inte hämta transaktioner',
          description: error.message,
          variant: 'destructive',
        })
        setRawRows([])
        setLoading(false)
        return
      }
      setRawRows((data ?? []) as RawTransaction[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, supabase, company, debouncedSearch, toast])

  // ── Score + sort (currency-aware) ────────────────────────────
  const candidates = useMemo<CandidateTransaction[]>(() => {
    const scored = rawRows.map((tx) => {
      const txCurrency = (tx.currency ?? 'SEK').toUpperCase()
      const txSek =
        txCurrency === 'SEK'
          ? tx.amount
          : resolveSekAmount(tx.amount, tx.amount_sek, tx.currency, tx.exchange_rate)

      // Currency-aware variance: null when uncomparable, which makes the
      // matcher drop the amount signal instead of matching 750 EUR to 750 SEK.
      const amountVariance = amountVarianceForMatch(
        total,
        receiptCurrency,
        receiptSek,
        tx.amount,
        txCurrency,
        txSek,
      )

      const dateVariance = Math.abs(
        (new Date(tx.date).getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24),
      )
      const merchant = tx.merchant_name || tx.description || ''
      const similarity = supplier ? calculateMerchantSimilarity(supplier, merchant) : 0
      const { confidence, matchReasons } = calculateMatchConfidence(
        dateVariance,
        amountVariance,
        similarity,
        MATCH_DATE_TOLERANCE_DAYS,
      )

      return {
        id: tx.id,
        date: tx.date,
        description: tx.description ?? null,
        merchant_name: tx.merchant_name ?? null,
        amount: tx.amount,
        currency: txCurrency,
        amountSek: txCurrency === 'SEK' ? null : Math.round(txSek * 100) / 100,
        confidence,
        reasons: matchReasons,
      }
    })
    scored.sort((a, b) => b.confidence - a.confidence)
    return scored
  }, [rawRows, invoiceDate, total, receiptCurrency, receiptSek, supplier])

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
          description: json.error ?? `HTTP ${res.status}`,
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
        {(total != null || supplier) && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs flex items-center gap-x-3 gap-y-1 flex-wrap">
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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
              const tier =
                c.confidence >= 0.8 ? 'success' : c.confidence >= 0.5 ? 'warning' : 'outline'
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
                    'w-full text-left flex items-center gap-3 py-3 hover:bg-muted/50 transition-colors px-2 -mx-2 rounded',
                    matchingId && !isMatching && 'opacity-50',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">
                        {c.merchant_name ?? c.description ?? 'Okänd transaktion'}
                      </span>
                      <Badge variant={tier} className="shrink-0 text-[10px]">
                        {tierLabel}
                      </Badge>
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
                  {isMatching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
