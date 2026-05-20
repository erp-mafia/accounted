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
  calculateMatchConfidence,
  calculateMerchantSimilarity,
} from '@/lib/documents/core-receipt-matcher'
import type { InvoiceExtractionResult } from '@/types'

// TransactionMatchPicker
//
// Opens from the InvoiceInboxWorkspace FieldsRail when the user clicks
// "Matcha mot transaktion" on an inbox item whose matched_transaction_id is
// null. Lists unmatched company transactions (no journal_entry_id) within
// ±30 days of the invoice date, scored via lib/documents/core-receipt-matcher.
// User picks one → POST /items/:id/match-transaction → onMatched callback.

interface CandidateTransaction {
  id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number
  currency: string
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

const DATE_WINDOW_DAYS = 30

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

  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<CandidateTransaction[]>([])
  const [search, setSearch] = useState('')
  const [matchingId, setMatchingId] = useState<string | null>(null)

  // Pull invoice date + total from extracted_data; default to today if no
  // date was extracted so we still surface a reasonable transaction window.
  const invoiceDate = useMemo(() => {
    const d = extractedData?.invoice?.invoiceDate
    if (!d) return new Date()
    const parsed = new Date(d)
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed
  }, [extractedData])
  const total = extractedData?.totals?.total ?? null
  const supplier = extractedData?.supplier?.name ?? null

  useEffect(() => {
    if (!open) return
    if (!company) {
      // No active company yet — provider still hydrating. Don't fetch.
      return
    }
    let cancelled = false
    setLoading(true)
    ;(async () => {
      // Window: ±30 days around the invoice date.
      const lo = new Date(invoiceDate)
      lo.setDate(lo.getDate() - DATE_WINDOW_DAYS)
      const hi = new Date(invoiceDate)
      hi.setDate(hi.getDate() + DATE_WINDOW_DAYS)
      const loISO = lo.toISOString().slice(0, 10)
      const hiISO = hi.toISOString().slice(0, 10)

      // Defense-in-depth: RLS only narrows to "any company the user belongs
      // to". Multi-tenant users (consultants on multiple companies) would
      // otherwise see cross-company transactions in the picker. Filter to
      // the active company explicitly.
      const { data, error } = await supabase
        .from('transactions')
        .select('id, date, description, merchant_name, amount, currency, journal_entry_id')
        .eq('company_id', company.id)
        .gte('date', loISO)
        .lte('date', hiISO)
        .is('journal_entry_id', null)
        .order('date', { ascending: false })
        .limit(200)

      if (cancelled) return
      if (error) {
        toast({ title: 'Kunde inte hämta transaktioner', description: error.message, variant: 'destructive' })
        setLoading(false)
        return
      }

      // Score + sort.
      const scored: CandidateTransaction[] = (data ?? []).map((tx) => {
        // Compare absolute amounts — bank tx for an expense is negative,
        // invoice total is positive; magnitude is what matches.
        const txAmount = Math.abs(tx.amount as number)
        const invoiceAmount = total != null ? Math.abs(total) : null
        const amountVariance =
          invoiceAmount != null && invoiceAmount > 0
            ? Math.abs(txAmount - invoiceAmount) / invoiceAmount
            : 1
        const dateVariance =
          Math.abs(
            (new Date(tx.date as string).getTime() - invoiceDate.getTime()) /
              (1000 * 60 * 60 * 24),
          )
        const merchant = (tx.merchant_name as string | null) || (tx.description as string | null) || ''
        const similarity = supplier ? calculateMerchantSimilarity(supplier, merchant) : 0
        const { confidence, matchReasons } = calculateMatchConfidence(
          dateVariance,
          amountVariance,
          similarity,
        )
        return {
          id: tx.id as string,
          date: tx.date as string,
          description: (tx.description as string | null) ?? null,
          merchant_name: (tx.merchant_name as string | null) ?? null,
          amount: tx.amount as number,
          currency: (tx.currency as string) ?? 'SEK',
          confidence,
          reasons: matchReasons,
        }
      })
      scored.sort((a, b) => b.confidence - a.confidence)
      setCandidates(scored)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, supabase, company, invoiceDate, total, supplier, toast])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((c) => {
      const hay = `${c.description ?? ''} ${c.merchant_name ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [candidates, search])

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
            Välj banktransaktionen som hör till underlaget. Sorterat efter sannolikhet.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Sök beskrivning…"
            className="pl-9"
          />
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
              Inga okatigoriserade transaktioner inom ±{DATE_WINDOW_DAYS} dagar.
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
