'use client'

import { useEffect, useMemo, useState } from 'react'
import { FOREIGN_CURRENCIES, type InvoiceExtractionResult } from '@/types'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { transactionTextSearchFilter } from '@/lib/transactions/text-search'
import {
  rankBankRowsForUnderlag,
  underlagPaymentFacts,
  underlagTotalSek,
  type RankedBankRow,
  type UnbookedBankRow,
  type UnderlagPaymentFacts,
} from '@/lib/documents/underlag-bank-candidates'

/** Pause after the last keystroke before a search goes to the database. */
const SEARCH_DEBOUNCE_MS = 300

export interface UnderlagBankCandidates {
  /** What the underlag says about its payment (total, currency, date, supplier). */
  facts: UnderlagPaymentFacts
  /** Ranked rows for the current search: the newest unbooked rows without
   *  one, the database's matches across every date with one. */
  ranked: RankedBankRow[]
  /** Every row loaded since the dialog opened, by id: a picked row stays
   *  readable after a search stops listing it. */
  rowById: ReadonlyMap<string, UnbookedBankRow>
  loading: boolean
  /** The load failed; the list is then empty. */
  error: string | null
  /** SEK per unit of the underlag currency; null for SEK, pending, unsupported or failed. */
  fxRate: number | null
  /** The underlag total in kronor, or null. */
  totalSek: number | null
  /** A foreign total that cannot be priced right now: amount matching is off. */
  amountMatchUnavailable: boolean
}

/**
 * The bank rows an underlag can be paired with, for both inbox surfaces that
 * offer one: the match picker and Bokför direkt. One source,
 * /api/transactions?unmatched=true, which leaves out ignored rows and rows
 * booked through a samlingsverifikat or split (transaction_voucher_links), and
 * searches description and merchant in the database (`q`) instead of a capped
 * list in the browser. One FX rate for a foreign underlag, one ranking
 * (lib/documents/underlag-bank-candidates).
 */
export function useUnderlagBankCandidates({
  open,
  extractedData,
  search,
}: {
  open: boolean
  extractedData: InvoiceExtractionResult | null
  search: string
}): UnderlagBankCandidates {
  const facts = useMemo(() => underlagPaymentFacts(extractedData), [extractedData])
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [rows, setRows] = useState<UnbookedBankRow[]>([])
  const [rowById, setRowById] = useState<ReadonlyMap<string, UnbookedBankRow>>(() => new Map())
  // Starts true so the first paint after opening shows skeletons, not a flash
  // of the empty state before the fetch runs.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fxRate, setFxRate] = useState<number | null>(null)

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [search])

  useEffect(() => {
    if (!open) return
    setRows([])
    setRowById(new Map())
    setError(null)
    setLoading(true)
  }, [open])

  // SEK rate of a foreign underlag (Riksbanken), so its total compares with
  // the kronor bank rows. It only ranks: never a booking amount.
  useEffect(() => {
    if (!open) return
    setFxRate(null)
    if (facts.currency === 'SEK' || !(FOREIGN_CURRENCIES as readonly string[]).includes(facts.currency)) return
    let cancelled = false
    const dateParam = facts.invoiceDate ? `&date=${facts.invoiceDate}` : ''
    fetch(`/api/currency/rate?currency=${facts.currency}${dateParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return
        const rate = body?.data?.rate
        if (typeof rate === 'number' && rate > 0) setFxRate(rate)
      })
      .catch(() => {
        /* leave null: the cross-currency amount signal drops out */
      })
    return () => {
      cancelled = true
    }
  }, [open, facts.currency, facts.invoiceDate])

  // A term too short to search keeps the newest rows.
  const searchTerm = transactionTextSearchFilter(debouncedSearch) ? debouncedSearch.trim() : ''
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const query = searchTerm ? `&q=${encodeURIComponent(searchTerm)}` : ''
        const res = await fetch(`/api/transactions?unmatched=true${query}`)
        const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string }
        if (cancelled) return
        if (!res.ok) {
          setRows([])
          setError(getErrorMessage(json, { statusCode: res.status }))
          return
        }
        const loaded = (Array.isArray(json.data) ? json.data : []) as UnbookedBankRow[]
        setRows(loaded)
        setError(null)
        setRowById((previous) => {
          const next = new Map(previous)
          for (const row of loaded) next.set(row.id, row)
          return next
        })
      } catch (err) {
        if (cancelled) return
        setRows([])
        setError(getErrorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, searchTerm])

  const ranked = useMemo(() => rankBankRowsForUnderlag(rows, facts, fxRate), [rows, facts, fxRate])
  const totalSek = underlagTotalSek(facts, fxRate)
  return {
    facts,
    ranked,
    rowById,
    loading,
    error,
    fxRate,
    totalSek,
    amountMatchUnavailable: facts.total != null && facts.currency !== 'SEK' && totalSek == null,
  }
}
