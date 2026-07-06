'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Plus, Trash2, AlertTriangle, Loader2, Lock, CalendarPlus, Eraser, Tags } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { JournalEntryReviewContent } from '@/components/bookkeeping/JournalEntryReviewContent'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import BookingTemplatePicker from '@/components/bookkeeping/BookingTemplatePicker'
import CreatePeriodDialog from '@/components/bookkeeping/CreatePeriodDialog'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import { AddAccountDialog } from '@/components/bookkeeping/AddAccountDialog'
import DuplicateBookingDialog from '@/components/transactions/DuplicateBookingDialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { formatVoucher, resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { useCompany } from '@/contexts/CompanyContext'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { CreateJournalEntryLineInput, FiscalPeriod, BASAccount, JournalEntrySourceType, Currency } from '@/types'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

const CURRENCIES: { value: Currency; label: string }[] = [
  { value: 'SEK', label: 'SEK' },
  { value: 'EUR', label: 'EUR' },
  { value: 'USD', label: 'USD' },
  { value: 'GBP', label: 'GBP' },
  { value: 'NOK', label: 'NOK' },
  { value: 'DKK', label: 'DKK' },
]

export interface FormLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description: string
  currency?: string
  amount_in_currency?: number
  exchange_rate?: number
  /** SIE dimension map {sie_dim_no: object_code}, e.g. {"1":"KS01","6":"P001"}. */
  dimensions?: Record<string, string>
}

interface Props {
  onCreated?: () => void
  onEntryCreated?: (entryId: string) => void
  initialLines?: FormLine[]
  initialDate?: string
  initialDescription?: string
  initialNotes?: string
  initialVoucherSeries?: string
  sourceType?: JournalEntrySourceType
  sourceId?: string
  submitUrl?: string
  embedded?: boolean
  /** Render without the Card chrome (e.g. inside a dialog) but keep the full
   *  non-embedded field set (series, notes, documents, voucher hint). */
  bare?: boolean
  /** Edit an existing DRAFT in place: the form PATCHes this entry instead of
   *  creating a new one. Only the draft's header + lines are updated. */
  editEntryId?: string
  /** Fired after a successful draft edit (editEntryId path). */
  onUpdated?: () => void
}

const BLANK_LINE: FormLine = { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }

export default function JournalEntryForm({
  onCreated,
  onEntryCreated,
  initialLines,
  initialDate,
  initialDescription,
  initialNotes,
  initialVoucherSeries,
  sourceType,
  sourceId,
  submitUrl,
  embedded,
  bare,
  editEntryId,
  onUpdated,
}: Props) {
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const { company } = useCompany()
  const t = useTranslations('journal_form')
  const locale = useLocale()
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [entryDate, setEntryDate] = useState(initialDate ?? new Date().toISOString().split('T')[0])
  const [description, setDescription] = useState(initialDescription ?? '')
  const [notes, setNotes] = useState(initialNotes ?? '')
  const [showNotes, setShowNotes] = useState(false)
  // Dimension tagging (kostnadsställe/projekt). The affordances render only
  // when company_settings.dimensions_enabled: a UI-visibility gate; lines
  // that already carry dimensions (e.g. a draft being edited) still round-trip
  // untouched when the toggle is off.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [showDims, setShowDims] = useState(false)
  // Header-level default dims ("gäller alla rader"). The per-row maps on
  // `lines` are the ONE source of truth: this state only drives the header
  // comboboxes; setHeaderDimension writes the default through to the rows.
  const [headerDims, setHeaderDims] = useState<Record<string, string>>({})
  // Which row's dimension popover is open (desktop table), and its container
  // for the outside-click close.
  const [dimPopoverRow, setDimPopoverRow] = useState<number | null>(null)
  const dimPopoverRef = useRef<HTMLDivElement | null>(null)
  const [lines, setLines] = useState<FormLine[]>(
    initialLines ?? [{ ...BLANK_LINE }, { ...BLANK_LINE }]
  )
  const [voucherSeries, setVoucherSeries] = useState(initialVoucherSeries ?? 'A')
  const [nextVoucherNumber, setNextVoucherNumber] = useState<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Booking-time duplicate guard (TRANSACTION_BOOK_POSSIBLE_DUPLICATE): the
  // /book endpoint flags an already-booked sibling sharing date+amount+account.
  // Surface it and let the user book anyway. The override is bound to the
  // reviewed candidate via a ref the next submit reads: force is sent ONLY on
  // that retry, never on a normal submit or to the manual journal-entry endpoint.
  const [duplicateCandidate, setDuplicateCandidate] = useState<BookedDuplicateCandidate | null>(null)
  const forceDuplicateRef = useRef<{ force: true; expected_duplicate_journal_entry_id: string } | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [isSavingDraft, setIsSavingDraft] = useState(false)
  const saveAsDraftRef = useRef(false)
  const [showNoDocWarning, setShowNoDocWarning] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  // Full BAS catalogue (static reference data, fetched once per session). Lets
  // the account picker surface standard accounts the company hasn't activated
  // yet; picking one activates it at commit via the existing rail.
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [entryCurrency, setEntryCurrency] = useState<Currency>('SEK')
  const [exchangeRate, setExchangeRate] = useState('')
  const [isFetchingRate, setIsFetchingRate] = useState(false)
  const [foreignAmount, setForeignAmount] = useState('')
  const [periodMismatch, setPeriodMismatch] = useState<'no_period' | 'wrong_period' | null>(null)
  const [showCreatePeriod, setShowCreatePeriod] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  // Month (YYYY-MM) of the most recently posted voucher this session. Used to
  // flag, at the review step, when the user is about to book into a different
  // month: guards against accidentally posting to the wrong month.
  const [lastPostedMonth, setLastPostedMonth] = useState<string | null>(null)
  // Per-account saldo as of entryDate, keyed by account_number.
  // undefined = not fetched, null = fetch in flight.
  const [accountBalances, setAccountBalances] = useState<Record<string, number | null>>({})
  // Inline account-creation: which line triggered the dialog, and what the
  // user typed in the combobox so we can prefill the dialog.
  const [creatingAccountForLine, setCreatingAccountForLine] = useState<number | null>(null)
  const [createAccountPrefill, setCreateAccountPrefill] = useState<string>('')
  // Per-row refs to the account/debit/credit inputs so the keyboard flow can
  // advance focus with Enter: konto → debet → kredit → nästa rads konto. Two
  // layouts render simultaneously (mobile cards + desktop table); we focus
  // whichever one is actually visible.
  const desktopAccountRefs = useRef<(HTMLInputElement | null)[]>([])
  const mobileAccountRefs = useRef<(HTMLInputElement | null)[]>([])
  const desktopDebitRefs = useRef<(HTMLInputElement | null)[]>([])
  const mobileDebitRefs = useRef<(HTMLInputElement | null)[]>([])
  const desktopCreditRefs = useRef<(HTMLInputElement | null)[]>([])
  const mobileCreditRefs = useRef<(HTMLInputElement | null)[]>([])
  // Confirm button in the inline (bare) review, focused on open so Enter posts.
  const bareConfirmRef = useRef<HTMLButtonElement>(null)

  const isForeign = entryCurrency !== 'SEK'

  const isUploading = uploadedFiles.some((f) => f.status === 'uploading')

  const hasContent = description !== '' || notes !== '' ||
    lines.some(l => l.account_number !== '' || l.debit_amount !== '' || l.credit_amount !== '') ||
    uploadedFiles.length > 0
  useUnsavedChanges(hasContent)

  async function fetchPeriods() {
    const res = await fetch('/api/bookkeeping/fiscal-periods')
    const { data } = await res.json()
    const fetched: FiscalPeriod[] = data || []
    setPeriods(fetched)

    // Auto-select period matching the current entry date
    const match = fetched.find(
      (p) => entryDate >= p.period_start && entryDate <= p.period_end
    )
    if (match) {
      setSelectedPeriod(match.id)
      setPeriodMismatch(null)
    } else if (fetched.length > 0) {
      setSelectedPeriod(fetched[0].id)
      setPeriodMismatch('no_period')
    }
  }

  async function fetchAccounts() {
    const res = await fetch('/api/bookkeeping/accounts')
    const { data } = await res.json()
    setAccounts(data || [])
  }

  useEffect(() => {
    fetchPeriods()
    fetchAccounts()
    loadBasCatalog().then(setCatalog).catch(() => {/* search degrades to the active chart */})
    // Company settings power two things here: dimensions_enabled gates the
    // tagging affordances (all modes, incl. the TransactionBookingDialog
    // embed), and the default voucher series seeds the standalone form:
    // prefer the per-source-type mapping when present; fall back to the legacy
    // default_voucher_series, then to 'A'. In edit mode the draft's own series
    // is pre-filled: never override it from the company defaults.
    fetch('/api/settings').then(r => r.json()).then(({ data }) => {
      if (!data) return
      setDimensionsEnabled(data.dimensions_enabled === true)
      if (!embedded && !editEntryId) {
        const effectiveSourceType = sourceType ?? 'manual'
        const perSource = resolveDefaultSeriesForSource(
          data as { default_voucher_series_per_source_type?: Record<string, string> | null } | null,
          effectiveSourceType,
        )
        const fallback = data.default_voucher_series || 'A'
        setVoucherSeries(perSource !== 'A' ? perSource : fallback)
      }
    }).catch(() => {/* keep 'A' + hidden dimension affordances */})
  }, [embedded, sourceType, editEntryId])

  // Auto-select period when entry date changes
  useEffect(() => {
    if (periods.length === 0) return
    const match = periods.find(
      (p) => entryDate >= p.period_start && entryDate <= p.period_end
    )
    if (match) {
      setSelectedPeriod(match.id)
      setPeriodMismatch(null)
    } else {
      setPeriodMismatch('no_period')
    }
  }, [entryDate, periods])

  // Preview the upcoming voucher number for the selected period + series.
  // Read-only hint; the actual number is reserved atomically at commit time,
  // so this may shift by one if another entry lands first.
  useEffect(() => {
    if (embedded || !selectedPeriod || !voucherSeries) {
      setNextVoucherNumber(null)
      return
    }
    let cancelled = false
    const qs = new URLSearchParams({ period_id: selectedPeriod, series: voucherSeries })
    fetch(`/api/bookkeeping/voucher-sequences/next?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return
        const next = body?.data?.next
        setNextVoucherNumber(typeof next === 'number' ? next : null)
      })
      .catch(() => {
        if (!cancelled) setNextVoucherNumber(null)
      })
    return () => {
      cancelled = true
    }
  }, [embedded, selectedPeriod, voucherSeries])

  // Fetch exchange rate from Riksbanken when currency changes
  const fetchRate = useCallback(async (currency: Currency) => {
    if (currency === 'SEK') return
    setIsFetchingRate(true)
    try {
      const res = await fetch(`/api/currency/rate?currency=${currency}&date=${entryDate}`)
      if (res.ok) {
        const { data } = await res.json()
        if (data?.rate) {
          setExchangeRate(String(data.rate))
        }
      }
    } catch {
      // Non-critical: user can enter rate manually
    } finally {
      setIsFetchingRate(false)
    }
  }, [entryDate])

  useEffect(() => {
    if (entryCurrency !== 'SEK') {
      fetchRate(entryCurrency)
    }
  }, [entryCurrency, fetchRate])

  // Stable key of selected account numbers across all lines, sorted + deduped.
  // Only valid 4-digit BAS account numbers are included.
  const accountsKey = useMemo(
    () =>
      Array.from(
        new Set(lines.map((l) => l.account_number).filter((a) => /^\d{4}$/.test(a)))
      )
        .sort()
        .join(','),
    [lines]
  )

  // Fetch per-account saldo as of entryDate for the accounts currently on the
  // form. Balances are reference-only ("saldo before this entry"): they ignore
  // the draft lines the user is typing, by design.
  useEffect(() => {
    if (!accountsKey) {
      setAccountBalances({})
      return
    }
    const accountList = accountsKey.split(',')
    // Carry forward any previously-known balances for these accounts so the
    // value doesn't blank out on re-fetch; mark genuinely new accounts as
    // loading (null).
    setAccountBalances((prev) => {
      const next: Record<string, number | null> = {}
      for (const a of accountList) next[a] = a in prev ? prev[a] : null
      return next
    })

    let cancelled = false
    const handle = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ accounts: accountsKey, as_of: entryDate })
        const res = await fetch(`/api/bookkeeping/account-balances?${qs}`)
        if (!res.ok) {
          // 4xx (e.g. future entryDate rejected by Zod) or 5xx: collapse the
          // loading skeleton so the column doesn't get stuck. Saldo is a
          // reference value, not authoritative: showing 0 here is preferable
          // to an indefinite spinner.
          if (cancelled) return
          setAccountBalances((prev) => {
            const next = { ...prev }
            for (const a of accountList) {
              if (next[a] == null) next[a] = 0
            }
            return next
          })
          return
        }
        const body = (await res.json()) as {
          data: Array<{ account_number: string; balance: number }>
        }
        if (cancelled) return
        setAccountBalances((prev) => {
          const next = { ...prev }
          for (const row of body.data) next[row.account_number] = row.balance
          return next
        })
      } catch {
        // Reference value: failure is non-fatal, just leave previous state.
      }
    }, 150)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [accountsKey, entryDate])

  // New rows inherit the current header default (a row without a per-row
  // override follows the header (see setHeaderDimension).
  const makeBlankLine = useCallback(
    (): FormLine =>
      Object.keys(headerDims).length > 0
        ? { ...BLANK_LINE, dimensions: { ...headerDims } }
        : { ...BLANK_LINE },
    [headerDims]
  )

  const addLine = () => {
    setLines([...lines, makeBlankLine()])
  }

  const removeLine = (index: number) => {
    if (lines.length <= 2) return
    setLines(lines.filter((_, i) => i !== index))
    // Keep the open dimension popover attached to the same row after the splice.
    setDimPopoverRow((r) => (r === null ? r : r === index ? null : r > index ? r - 1 : r))
  }

  /**
   * Header default write-through. Inheritance rule: a row inherits dimension
   * `dimNo` iff its current value equals the previous header default (unset
   * counts as equal to an unset default). Inheriting rows follow the change
   * (including clearing); rows whose value differs are per-row overrides and
   * are left untouched. A row explicitly set to the same code as the header is
   * indistinguishable from an inherited one and follows later header changes
   * by design: the per-row maps stay the single source of truth.
   */
  const setHeaderDimension = (dimNo: string, code: string | null) => {
    const prev = headerDims[dimNo]
    const next = code?.trim() || undefined
    setHeaderDims((h) => {
      const out = { ...h }
      if (next) out[dimNo] = next
      else delete out[dimNo]
      return out
    })
    setLines((ls) =>
      ls.map((l) => {
        if (l.dimensions?.[dimNo] !== prev) return l // per-row override: keep
        const dims = { ...(l.dimensions ?? {}) }
        if (next) dims[dimNo] = next
        else delete dims[dimNo]
        return { ...l, dimensions: Object.keys(dims).length > 0 ? dims : undefined }
      })
    )
  }

  const updateLineDimension = (index: number, dimNo: string, code: string | null) => {
    setLines((ls) =>
      ls.map((l, i) => {
        if (i !== index) return l
        const dims = { ...(l.dimensions ?? {}) }
        const trimmed = code?.trim()
        if (trimmed) dims[dimNo] = trimmed
        else delete dims[dimNo]
        return { ...l, dimensions: Object.keys(dims).length > 0 ? dims : undefined }
      })
    )
  }

  // Compact per-row display, e.g. "KS01 · P001" (dim number order).
  const compactDims = (dims: Record<string, string>) =>
    Object.entries(dims)
      .filter(([, v]) => v)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => v)
      .join(' · ')

  // Close the row dimension popover on outside click (same pattern as the
  // comboboxes' own dropdowns; their option clicks preventDefault so a
  // selection never counts as outside).
  useEffect(() => {
    if (dimPopoverRow === null) return
    function handlePointerDown(e: MouseEvent | TouchEvent) {
      if (dimPopoverRef.current && !dimPopoverRef.current.contains(e.target as Node)) {
        setDimPopoverRow(null)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [dimPopoverRow])

  const updateLine = (index: number, field: keyof FormLine, value: string) => {
    const updated = [...lines]
    updated[index] = { ...updated[index], [field]: value }

    // If entering debit, clear credit and vice versa
    if (field === 'debit_amount' && value) {
      updated[index].credit_amount = ''
    } else if (field === 'credit_amount' && value) {
      updated[index].debit_amount = ''
    }

    // Auto-fill line description from account name when selecting an account.
    // NOTE: we intentionally do NOT auto-fill a balancing amount here: that was
    // surprising when splitting across several lines. The balancing amount is
    // now opt-in via double-clicking a debit/credit field (handleFillBalance).
    if (field === 'account_number' && value) {
      // Fall back to the BAS catalogue so the description still auto-fills when
      // the chosen account isn't in the active chart yet.
      const account =
        accounts.find((a) => a.account_number === value) ??
        catalog.find((a) => a.account_number === value)
      if (account) {
        updated[index].line_description = account.account_name
        // Fortnox-style: seed the verifikationstext from the first row's account
        // when the user hasn't typed one yet. Non-destructive: never overwrites.
        if (index === 0 && !description.trim()) {
          setDescription(account.account_name)
        }
      }
    }

    setLines(updated)
  }

  // Outstanding imbalance from every line except `excludeIndex`.
  // Positive => debit side is short (a debit on the target row balances it);
  // negative => credit side is short.
  const computeBalancingDiff = useCallback(
    (excludeIndex: number) => {
      const others = lines.filter((_, i) => i !== excludeIndex)
      const d = others.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
      const c = others.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
      return Math.round((c - d) * 100) / 100
    },
    [lines]
  )

  // Opt-in balancing: double-click a debit/credit field to fill the amount that
  // makes the voucher balance. No-op if already balanced or if the balancing
  // entry belongs on the other side.
  const handleFillBalance = (index: number, side: 'debit' | 'credit') => {
    const diff = computeBalancingDiff(index)
    const fill = side === 'debit' ? diff : -diff
    if (fill <= 0) return
    updateLine(index, side === 'debit' ? 'debit_amount' : 'credit_amount', fill.toFixed(2))
  }

  // Move focus to a row's input. Deferred a frame so it runs after any
  // re-render (e.g. the auto-appended trailing row). offsetParent is null for
  // display:none elements, so this picks whichever layout is currently visible.
  const focusRowInput = useCallback(
    (
      desktop: React.RefObject<(HTMLInputElement | null)[]>,
      mobile: React.RefObject<(HTMLInputElement | null)[]>,
      index: number
    ) => {
      requestAnimationFrame(() => {
        const d = desktop.current?.[index]
        const m = mobile.current?.[index]
        const target = d && d.offsetParent !== null ? d : m && m.offsetParent !== null ? m : (d ?? m)
        target?.focus()
        target?.select?.()
      })
    },
    []
  )
  const focusAccount = useCallback(
    (index: number) => focusRowInput(desktopAccountRefs, mobileAccountRefs, index),
    [focusRowInput]
  )
  const focusDebit = useCallback(
    (index: number) => focusRowInput(desktopDebitRefs, mobileDebitRefs, index),
    [focusRowInput]
  )
  const focusCredit = useCallback(
    (index: number) => focusRowInput(desktopCreditRefs, mobileCreditRefs, index),
    [focusRowInput]
  )

  // Keep exactly one trailing blank row so the user never has to click "Lägg
  // till rad": once the last row is started (account or amount), append a fresh
  // blank below it. Applies uniformly to typed, templated and copied lines.
  // The guard lives inside the functional updater so chained updates see each
  // other's result, making it idempotent and safe under StrictMode's dev-only
  // double-invoke (no runaway append, no double blank row).
  useEffect(() => {
    setLines((prev) => {
      const last = prev[prev.length - 1]
      if (!last) return prev
      const trailingBlank =
        last.account_number === '' && last.debit_amount === '' && last.credit_amount === ''
      return trailingBlank ? prev : [...prev, makeBlankLine()]
    })
  }, [lines, makeBlankLine])

  // Inline (bare) review: move focus to the confirm button when it opens so
  // Enter posts: parity with the ConfirmationDialog's autoFocusConfirm.
  useEffect(() => {
    if (bare && showReview) {
      requestAnimationFrame(() => bareConfirmRef.current?.focus())
    }
  }, [bare, showReview])

  // Only lines with both an account and a non-zero amount end up in the submit
  // payload (see the filter in handleConfirm). Compute totals and balance from
  // those same lines so the enable-gate matches what the API will actually see.
  const submittableLines = lines.filter((l) => {
    const d = parseFloat(l.debit_amount) || 0
    const c = parseFloat(l.credit_amount) || 0
    return !!l.account_number && (d > 0 || c > 0)
  })
  const incompleteLineCount = lines.filter((l) => {
    const d = parseFloat(l.debit_amount) || 0
    const c = parseFloat(l.credit_amount) || 0
    const hasAmount = d > 0 || c > 0
    const hasAccount = !!l.account_number
    // Row counts as incomplete if exactly one of (account, amount) is present.
    return hasAccount !== hasAmount
  }).length
  const totalDebit = submittableLines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
  const totalCredit = submittableLines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
  const isBalanced =
    Math.round((totalDebit - totalCredit) * 100) === 0
    && totalDebit > 0
    && submittableLines.length >= 2
    && incompleteLineCount === 0

  const rate = parseFloat(exchangeRate) || 0
  // If user has manually entered a foreign amount, use that; otherwise derive from SEK total
  const parsedForeignInput = parseFloat(foreignAmount) || 0
  const computedForeignAmount = isForeign && rate > 0
    ? (parsedForeignInput > 0
      ? parsedForeignInput
      : (totalDebit > 0 ? Math.round(totalDebit / rate * 100) / 100 : 0))
    : 0
  // The expected SEK equivalent based on foreign amount × rate
  const computedSekAmount = isForeign && rate > 0 && computedForeignAmount > 0
    ? Math.round(computedForeignAmount * rate * 100) / 100
    : 0

  // Month/period safety signals surfaced at the review step (not as a blocking
  // dialog on every date change (that would add friction to routine entry).
  const monthLabel = useCallback(
    (ym: string) => {
      const [y, m] = ym.split('-').map(Number)
      if (!y || !m) return ym
      return new Date(y, m - 1, 1).toLocaleDateString(locale === 'en' ? 'en-GB' : 'sv-SE', {
        month: 'long',
        year: 'numeric',
      })
    },
    [locale]
  )
  const entryMonth = entryDate.slice(0, 7)
  const monthChanged = lastPostedMonth != null && entryMonth !== lastPostedMonth
  const selectedPeriodObj = periods.find((p) => p.id === selectedPeriod)
  const selectedPeriodLocked = !!(selectedPeriodObj?.locked_at || selectedPeriodObj?.is_closed)

  const handleTemplateApply = (templateLines: FormLine[], templateDescription: string) => {
    setLines(templateLines)
    if (!description) setDescription(templateDescription)
  }

  // Wipe the form back to a blank entry. Mirrors the post-submit reset: it
  // clears the data the user typed (lines, description, note, attachments,
  // currency) but keeps the contextual defaults (period, date, series) so the
  // form is immediately ready for the next entry.
  const handleClearAll = () => {
    setDescription('')
    setNotes('')
    setUploadedFiles([])
    setLines([{ ...BLANK_LINE }, { ...BLANK_LINE }])
    setHeaderDims({})
    setEntryCurrency('SEK')
    setExchangeRate('')
    setForeignAmount('')
  }

  const handleOpenCreateAccount = (lineIndex: number, prefill: string) => {
    setCreatingAccountForLine(lineIndex)
    setCreateAccountPrefill(prefill)
  }

  // After a new account is created, refresh the chart, auto-select it on the
  // line that initiated the create, and close the dialog. All other form
  // state is preserved: we never navigate away from the form.
  const handleAccountCreated = async (account: BASAccount) => {
    await fetchAccounts()
    if (creatingAccountForLine != null) {
      updateLine(creatingAccountForLine, 'account_number', account.account_number)
    }
    setCreatingAccountForLine(null)
    setCreateAccountPrefill('')
  }

  const handleReview = () => {
    if (!selectedPeriod || !description || !isBalanced || periodMismatch) return
    const hasDocuments = uploadedFiles.some((f) => f.status === 'uploaded')
    if (!embedded && !bare && !hasDocuments) {
      setShowNoDocWarning(true)
      return
    }
    setShowReview(true)
  }

  // Whether an Enter should open the review: mirrors the review button's
  // enable gate exactly, so Enter never submits something the button wouldn't.
  const canSubmitReview = () =>
    isBalanced &&
    !!description &&
    !!selectedPeriod &&
    !periodMismatch &&
    !isUploading &&
    canWrite &&
    !isSubmitting &&
    !isSavingDraft

  // Enter anywhere in the form = "Granska & skapa": opens the review exactly as
  // the button does, from any field. Navigation is Tab's job. Two Enter
  // exceptions stay intact: the account combobox (it calls preventDefault to
  // select the highlighted account (we skip when defaultPrevented) and the
  // internal-note textarea (newlines). The inline review owns its own Enter.
  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    if (e.defaultPrevented || showReview) return
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return
    e.preventDefault()
    if (canSubmitReview()) handleReview()
  }

  // Enter-to-advance inside the konteringsrader: konto → debet → kredit →
  // nästa rads konto. Navigation only fires while the entry is NOT
  // submittable: once the voucher balances, Enter falls through to the
  // form-level handler above and opens the review instead, so a single Enter
  // never both moves focus and submits.
  const handleAmountKeyDown =
    (index: number, side: 'debit' | 'credit') =>
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter' || canSubmitReview()) return
      e.preventDefault()
      // An amount on this side finishes the row (debit clears credit and vice
      // versa) → jump to the next row's account. An empty debit means the row
      // books on the credit side → hop across first.
      if (side === 'debit' && !(parseFloat(lines[index].debit_amount) > 0)) {
        focusCredit(index)
      } else {
        focusAccount(index + 1)
      }
    }

  // Enter in a radbeskrivning continues to that row's amount.
  const handleLineDescKeyDown =
    (index: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter' || canSubmitReview()) return
      e.preventDefault()
      focusDebit(index)
    }

  // Enter in the verifikationstext drops into the first row still missing an
  // account, so the top-to-bottom keyboard flow never needs the mouse.
  const handleHeaderDescKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || canSubmitReview()) return
    const idx = lines.findIndex((l) => !l.account_number)
    if (idx === -1) return
    e.preventDefault()
    focusAccount(idx)
  }

  // Inner submit: builds payload, POSTs, throws a structured error on failure
  // (so the activation hook can intercept ACCOUNTS_NOT_IN_CHART).
  const postJournalEntry = useCallback(async () => {
    let currencyMetaApplied = false
    const entryLines: CreateJournalEntryLineInput[] = lines
      .filter((l) => l.account_number && (l.debit_amount || l.credit_amount))
      .map((l) => {
        const base: CreateJournalEntryLineInput = {
          account_number: l.account_number,
          debit_amount: parseFloat(l.debit_amount) || 0,
          credit_amount: parseFloat(l.credit_amount) || 0,
          line_description: l.line_description || undefined,
        }

        if (l.dimensions) {
          const dims = Object.fromEntries(
            Object.entries(l.dimensions).filter(([, v]) => typeof v === 'string' && v.trim() !== '')
          )
          if (Object.keys(dims).length > 0) base.dimensions = dims
        }

        if (l.currency) {
          base.currency = l.currency
          if (l.amount_in_currency != null) base.amount_in_currency = l.amount_in_currency
          if (l.exchange_rate != null) base.exchange_rate = l.exchange_rate
        } else if (isForeign && rate > 0 && l.account_number.startsWith('19') && !currencyMetaApplied) {
          base.currency = entryCurrency
          base.amount_in_currency = computedForeignAmount
          base.exchange_rate = rate
          currencyMetaApplied = true
        }

        return base
      })

    const baseUrl = submitUrl ?? '/api/bookkeeping/journal-entries'
    // Edit mode PATCHes the draft in place; create mode POSTs (with ?as_draft
    // when saving a draft rather than posting).
    const url = editEntryId
      ? `${baseUrl}/${editEntryId}`
      : saveAsDraftRef.current
        ? `${baseUrl}?as_draft=true`
        : baseUrl
    const res = await fetch(url, {
      method: editEntryId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fiscal_period_id: selectedPeriod,
        entry_date: entryDate,
        description,
        source_type: sourceType ?? 'manual',
        source_id: sourceId,
        voucher_series: voucherSeries || 'A',
        notes: notes || undefined,
        lines: entryLines,
        // Set only when retrying past the booking-time duplicate guard (see
        // handleBookAnyway). Stripped by schemas that don't declare it, so a
        // stray value never reaches the manual journal-entry endpoint.
        ...(forceDuplicateRef.current ?? {}),
      }),
    })
    return (await throwOnStructuredError(res)) as { data?: { id?: string; voucher_series?: string; voucher_number?: number }; journal_entry_id?: string }
  }, [lines, isForeign, rate, entryCurrency, computedForeignAmount, submitUrl, editEntryId, selectedPeriod, entryDate, description, sourceType, sourceId, voucherSeries, notes])

  const { runSubmit, dialog: activationDialog, confirm: confirmActivation, cancel: cancelActivation } =
    useSubmitWithAccountActivation(postJournalEntry)

  const handleConfirm = async () => {
    setIsSubmitting(true)
    saveAsDraftRef.current = false
    try {
      const result = await runSubmit()

      const journalEntryId = result.data?.id ?? result.journal_entry_id
      if (journalEntryId && uploadedFiles.length > 0) {
        const filesToLink = uploadedFiles.filter((f) => f.status === 'uploaded' && f.id)
        let linkFailCount = 0
        for (const file of filesToLink) {
          try {
            await fetch(`/api/documents/${file.id}/link`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ journal_entry_id: journalEntryId }),
            })
          } catch {
            linkFailCount++
          }
        }
        if (linkFailCount > 0) {
          toast({
            title: t('toast_attach_failed_title'),
            description: t('toast_attach_failed_description', { count: linkFailCount }),
            variant: 'destructive',
          })
        }
      }

      toast({
        title: t('toast_created_title'),
        description: t('toast_created_description', { voucher: formatVoucher(result.data ?? {}) }),
      })
      setLastPostedMonth(entryDate.slice(0, 7))
      setShowReview(false)
      setDescription('')
      setNotes('')
      setUploadedFiles([])
      setLines([{ ...BLANK_LINE }, { ...BLANK_LINE }])
      setHeaderDims({})
      setEntryCurrency('SEK')
      setExchangeRate('')
      setForeignAmount('')
      onCreated?.()
      if (journalEntryId) {
        onEntryCreated?.(journalEntryId)
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        // User dismissed the activation dialog: no toast needed
      } else {
        const anyErr = err as {
          body?: { error?: { code?: string; details?: { candidate?: BookedDuplicateCandidate } } }
          status?: number
        }
        const candidate = anyErr.body?.error?.details?.candidate
        if (anyErr.body?.error?.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' && candidate) {
          // Soft duplicate guard fired: don't dead-end on a toast that merely
          // says "book anyway". Open the dialog so the user can review the
          // existing verifikat or confirm. handleBookAnyway re-submits with
          // force bound to this candidate.
          setDuplicateCandidate(candidate)
        } else {
          toast({
            title: t('toast_create_failed'),
            description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
            variant: 'destructive',
          })
        }
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  // Retry the booking past the duplicate guard. force is bound to the reviewed
  // candidate via the ref; cleared afterwards so a later normal submit can't
  // inherit it. handleConfirm runs its full success path (toast, reset,
  // onEntryCreated) exactly as a first-try booking would.
  const handleBookAnyway = async () => {
    const candidate = duplicateCandidate
    if (!candidate) return
    forceDuplicateRef.current = {
      force: true,
      // Bind on the voucher id: present on both a sibling-transaction candidate
      // and a ledger-only voucher candidate (which has no transaction_id).
      expected_duplicate_journal_entry_id: candidate.journal_entry_id,
    }
    setDuplicateCandidate(null)
    try {
      await handleConfirm()
    } finally {
      forceDuplicateRef.current = null
    }
  }

  const handleSaveDraft = async () => {
    if (!selectedPeriod || !description || !isBalanced || periodMismatch) return
    setIsSavingDraft(true)
    saveAsDraftRef.current = true
    try {
      const result = await runSubmit()

      const journalEntryId = result.data?.id ?? result.journal_entry_id
      if (journalEntryId && uploadedFiles.length > 0) {
        const filesToLink = uploadedFiles.filter((f) => f.status === 'uploaded' && f.id)
        for (const file of filesToLink) {
          try {
            await fetch(`/api/documents/${file.id}/link`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ journal_entry_id: journalEntryId }),
            })
          } catch {
            // Non-blocking: user can attach underlag from the draft view
          }
        }
      }

      toast({
        title: t('toast_draft_saved_title'),
        description: t('toast_draft_saved_description'),
      })
      setDescription('')
      setNotes('')
      setUploadedFiles([])
      setLines([{ ...BLANK_LINE }, { ...BLANK_LINE }])
      setHeaderDims({})
      setEntryCurrency('SEK')
      setExchangeRate('')
      setForeignAmount('')
      onCreated?.()
      if (journalEntryId) {
        onEntryCreated?.(journalEntryId)
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        // Activation dialog dismissed: silent
      } else {
        const anyErr = err as { body?: unknown; status?: number }
        toast({
          title: t('toast_save_draft_failed'),
          description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
          variant: 'destructive',
        })
      }
    } finally {
      saveAsDraftRef.current = false
      setIsSavingDraft(false)
    }
  }

  // Edit an existing draft: PATCH in place (postJournalEntry routes to the
  // editEntryId URL) and keep it a draft. No field reset: the host dialog
  // closes on success via onUpdated.
  const handleSaveEdit = async () => {
    if (!selectedPeriod || !description || !isBalanced || periodMismatch) return
    setIsSavingDraft(true)
    try {
      await runSubmit()
      toast({
        title: t('toast_updated_title'),
        description: t('toast_updated_description'),
      })
      onUpdated?.()
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        // Activation dialog dismissed: silent
      } else {
        const anyErr = err as { body?: unknown; status?: number }
        toast({
          title: t('toast_update_failed'),
          description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
          variant: 'destructive',
        })
      }
    } finally {
      setIsSavingDraft(false)
    }
  }

  // Inline review for the modal (bare): swap the form body to a read-only
  // summary instead of stacking a second dialog over the form dialog. The
  // no-underlag caveat folds in here so there's a single confirm step.
  const reviewPanel = (
    <div
      className="space-y-4"
      // The host dialog swallows Escape (accidental-close guard), so Escape
      // here is free to mean "back to the form": keyboard mirror of ←.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !isSubmitting) {
          e.stopPropagation()
          setShowReview(false)
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setShowReview(false)}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← {t('review_back')}
        </button>
        <span className="font-display text-lg">
          {nextVoucherNumber != null
            ? t('review_title_with_voucher', { voucher: formatVoucher({ voucher_series: voucherSeries, voucher_number: nextVoucherNumber }) })
            : t('review_title')}
        </span>
      </div>

      {(monthChanged || selectedPeriodLocked) && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3">
          <AlertTriangle className="h-5 w-5 text-warning-foreground mt-0.5 shrink-0" />
          <div className="flex-1 text-sm text-warning-foreground space-y-0.5">
            {monthChanged && (
              <p className="font-medium">
                {t('review_month_changed', { prev: monthLabel(lastPostedMonth as string), current: monthLabel(entryMonth) })}
              </p>
            )}
            {selectedPeriodLocked && <p>{t('review_period_locked')}</p>}
          </div>
        </div>
      )}

      {uploadedFiles.filter((f) => f.status === 'uploaded').length === 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
          <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
          <p>{t('no_doc_body')}</p>
        </div>
      )}

      <JournalEntryReviewContent
        periodName={periods.find((p) => p.id === selectedPeriod)?.name || ''}
        entryDate={entryDate}
        description={description}
        notes={notes || undefined}
        voucherSeries={voucherSeries}
        lines={lines}
        totalDebit={totalDebit}
        totalCredit={totalCredit}
        attachmentCount={uploadedFiles.filter((f) => f.status === 'uploaded').length}
        showBalanceBadge
        hideDate={false}
      />

      <div className="flex justify-end gap-2 pt-2 border-t">
        <Button variant="outline" onClick={() => setShowReview(false)} disabled={isSubmitting}>
          {t('review_back')}
        </Button>
        <Button ref={bareConfirmRef} onClick={handleConfirm} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {/* No underlag attached → explicit acknowledgement, equivalent to the
              blocking "Bokför utan underlag" dialog in the non-bare flow (BFL
              5 kap 6-7 §§). With a document it's the normal create label. */}
          {uploadedFiles.some((f) => f.status === 'uploaded')
            ? t('review_confirm')
            : t('no_doc_confirm')}
        </Button>
      </div>
    </div>
  )

  const formContent = (
    <div className="space-y-4" onKeyDown={handleFormKeyDown}>
      {bare && showReview ? reviewPanel : (
      <>
      {/* Verifikat metadata: compact bar on top (Fortnox-style). Date, series
          and period are pre-filled; the period derives from the date. The
          konteringsrader below are the focus. */}
      <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-[1fr_2fr_auto]">
          {!(embedded && initialDate) && (
            <div>
              <Label className="text-xs text-muted-foreground">{t('date')}</Label>
              <Input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="mt-1 h-8"
              />
            </div>
          )}
          <div>
            <Label className="text-xs text-muted-foreground">{t('description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleHeaderDescKeyDown}
              placeholder={t('description_placeholder')}
              className="mt-1 h-8"
            />
          </div>
          {!embedded && (
            <div className="w-16">
              <Label className="text-xs text-muted-foreground">{t('series')}</Label>
              <Input
                value={voucherSeries}
                onChange={(e) => {
                  const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(-1)
                  setVoucherSeries(v)
                }}
                onFocus={(e) => {
                  const target = e.target
                  setTimeout(() => target.select(), 0)
                }}
                onBlur={() => {
                  if (!voucherSeries) setVoucherSeries('A')
                }}
                className="mt-1 h-8 text-center font-mono"
                maxLength={1}
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {embedded ? (
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t('fiscal_year')}</Label>
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger className="h-7 w-auto text-xs">
                  <SelectValue placeholder={t('fiscal_year_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {periods.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            selectedPeriodObj && (
              <span className="text-muted-foreground">
                {t('fiscal_year')}:{' '}
                <span className="text-foreground">{selectedPeriodObj.name}</span>
                {nextVoucherNumber != null && (
                  <span className="ml-2 font-mono text-foreground">
                    {voucherSeries}{nextVoucherNumber}
                  </span>
                )}
              </span>
            )
          )}
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">{t('currency')}</Label>
            <Select value={entryCurrency} onValueChange={(v) => {
              setEntryCurrency(v as Currency)
              if (v === 'SEK') {
                setExchangeRate('')
                setForeignAmount('')
              }
            }}>
              <SelectTrigger className="h-7 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!embedded && !showNotes && !notes && (
            <button
              type="button"
              onClick={() => setShowNotes(true)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              + {t('internal_note')}
            </button>
          )}
          {dimensionsEnabled && !showDims && (
            <button
              type="button"
              onClick={() => setShowDims(true)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              + {t('add_dimensions')}
            </button>
          )}
        </div>

        {isForeign && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Label className="text-xs text-muted-foreground">
                {t('exchange_rate_label', { currency: entryCurrency })}
              </Label>
              <div className="relative mt-1">
                <Input
                  type="number"
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                  placeholder="0,0000"
                  className="h-8 pr-8"
                  step="0.0001"
                  min="0"
                />
                {isFetchingRate && (
                  <Loader2 className="absolute right-2 top-1.5 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>
            <div className="w-40">
              <Label className="text-xs text-muted-foreground">
                {t('amount_in_currency_label', { currency: entryCurrency })}
              </Label>
              <Input
                type="number"
                value={foreignAmount || (computedForeignAmount > 0 && !parsedForeignInput ? computedForeignAmount.toFixed(2) : '')}
                onChange={(e) => setForeignAmount(e.target.value)}
                placeholder="0,00"
                className="mt-1 h-8"
                step="0.01"
                min="0"
              />
            </div>
            {rate > 0 && computedForeignAmount > 0 && (
              <p className="text-xs text-muted-foreground pb-1">
                {computedForeignAmount.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {entryCurrency} × {rate.toLocaleString('sv-SE', { minimumFractionDigits: 4 })} = {computedSekAmount.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK
              </p>
            )}
          </div>
        )}

        {!embedded && (showNotes || notes) && (
          <div>
            <Label className="text-xs text-muted-foreground">
              {t('internal_note')}{' '}
              <span className="font-normal">{t('internal_note_optional')}</span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('internal_note_placeholder')}
              className="mt-1 resize-none"
              rows={2}
              maxLength={2000}
            />
          </div>
        )}

        {/* Header default dims: writes through to all rows without a per-row
            override (see setHeaderDimension for the inheritance rule). */}
        {dimensionsEnabled && showDims && (
          <div className="max-w-md space-y-1">
            <LineDimensionFields
              dimensions={headerDims}
              onChange={setHeaderDimension}
              inputClassName="h-8"
            />
            <p className="text-xs text-muted-foreground">{t('dimensions_apply_all_hint')}</p>
          </div>
        )}

        {periodMismatch === 'no_period' && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3">
            <AlertTriangle className="h-5 w-5 text-warning-foreground mt-0.5 shrink-0" />
            <div className="flex-1 text-sm text-warning-foreground">
              <p className="font-medium">{t('no_period_warning', { date: entryDate })}</p>
              <p className="mt-0.5">{t('no_period_help')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCreatePeriod(true)}
              className="shrink-0"
            >
              <CalendarPlus className="h-3.5 w-3.5 mr-1.5" />
              {t('create_period')}
            </Button>
          </div>
        )}
      </div>

      {/* Entry lines: mobile cards */}
      <div className="sm:hidden space-y-3">
        {lines.map((line, index) => (
          <div key={index} className="rounded-lg border bg-card p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <AccountCombobox
                  value={line.account_number}
                  accounts={accounts}
                  catalog={catalog}
                  notActivatedLabel={t('account_not_activated')}
                  onChange={(num) => updateLine(index, 'account_number', num)}
                  onCommit={() => focusDebit(index)}
                  onCreateAccount={(prefill) => handleOpenCreateAccount(index, prefill)}
                  inputRef={(el) => { mobileAccountRefs.current[index] = el }}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeLine(index)}
                disabled={lines.length <= 2}
                className="h-8 w-8 p-0 min-h-[44px] min-w-[44px] shrink-0 -mr-1 -mt-1"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Input
              value={line.line_description}
              onChange={(e) => updateLine(index, 'line_description', e.target.value)}
              onKeyDown={handleLineDescKeyDown(index)}
              placeholder={t('line_description_placeholder')}
            />
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{t('col_debit')}</Label>
                <Input
                  ref={(el) => { mobileDebitRefs.current[index] = el }}
                  type="number"
                  value={line.debit_amount}
                  onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                  onKeyDown={handleAmountKeyDown(index, 'debit')}
                  onDoubleClick={() => handleFillBalance(index, 'debit')}
                  title={t('fill_balance_tooltip')}
                  placeholder="0,00"
                  className="text-right"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{t('col_credit')}</Label>
                <Input
                  ref={(el) => { mobileCreditRefs.current[index] = el }}
                  type="number"
                  value={line.credit_amount}
                  onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                  onKeyDown={handleAmountKeyDown(index, 'credit')}
                  onDoubleClick={() => handleFillBalance(index, 'credit')}
                  title={t('fill_balance_tooltip')}
                  placeholder="0,00"
                  className="text-right"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                />
              </div>
            </div>
            {dimensionsEnabled && (
              <LineDimensionFields
                dimensions={line.dimensions}
                onChange={(dimNo, code) => updateLineDimension(index, dimNo, code)}
              />
            )}
            {/^\d{4}$/.test(line.account_number) && (
              <div className="flex justify-end text-xs text-muted-foreground tabular-nums pt-0.5">
                {accountBalances[line.account_number] === null || accountBalances[line.account_number] === undefined ? (
                  <Skeleton className="h-3 w-20" />
                ) : (
                  <span>
                    {t('saldo_label')} {formatCurrency(accountBalances[line.account_number] as number)}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Mobile totals */}
        <div className="flex justify-between items-center px-1 pt-2 font-semibold text-sm">
          <span>{t('sum')}</span>
          <div className="flex gap-4">
            <span className={isBalanced ? 'text-success' : 'text-destructive'}>
              {t('sum_d', { amount: totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) })}
            </span>
            <span className={isBalanced ? 'text-success' : 'text-destructive'}>
              {t('sum_k', { amount: totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) })}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={addLine}
            className="flex-1"
          >
            <Plus className="h-3 w-3 mr-1" />
            {t('add_line')}
          </Button>
          <BookingTemplatePicker
            onApply={handleTemplateApply}
            entityType={company?.entity_type}
          />
        </div>
      </div>

      {/* Entry lines: desktop table */}
      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <tr className="border-b text-left">
              <th className="py-2 w-28">{t('col_account')}</th>
              <th className="py-2 px-1">{t('col_description')}</th>
              <th className="py-2 w-32 px-1 text-right">{t('col_debit')}</th>
              <th className="py-2 w-32 px-1 text-right">{t('col_credit')}</th>
              <th className="py-2 w-28 px-1 text-right">{t('col_saldo')}</th>
              <th className="py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="border-b">
                <td className="py-1.5">
                  <AccountCombobox
                    value={line.account_number}
                    accounts={accounts}
                    catalog={catalog}
                    notActivatedLabel={t('account_not_activated')}
                    onChange={(num) => updateLine(index, 'account_number', num)}
                    onCommit={() => focusDebit(index)}
                    onCreateAccount={(prefill) => handleOpenCreateAccount(index, prefill)}
                    inputRef={(el) => { desktopAccountRefs.current[index] = el }}
                    className="h-8"
                  />
                </td>
                <td className="py-1.5 px-1">
                  <Input
                    value={line.line_description}
                    onChange={(e) => updateLine(index, 'line_description', e.target.value)}
                    onKeyDown={handleLineDescKeyDown(index)}
                    placeholder={t('line_description_placeholder')}
                    className="h-8"
                  />
                  {line.dimensions &&
                    Object.keys(line.dimensions).length > 0 &&
                    (line.account_number || line.debit_amount || line.credit_amount) && (
                      <Badge variant="outline" className="mt-1 font-mono text-[11px] font-normal">
                        {compactDims(line.dimensions)}
                      </Badge>
                    )}
                </td>
                <td className="py-1.5 px-1">
                  <Input
                    ref={(el) => { desktopDebitRefs.current[index] = el }}
                    type="number"
                    value={line.debit_amount}
                    onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                    onKeyDown={handleAmountKeyDown(index, 'debit')}
                    onDoubleClick={() => handleFillBalance(index, 'debit')}
                    title={t('fill_balance_tooltip')}
                    placeholder="0,00"
                    className="text-right h-8"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                  />
                </td>
                <td className="py-1.5 px-1">
                  <Input
                    ref={(el) => { desktopCreditRefs.current[index] = el }}
                    type="number"
                    value={line.credit_amount}
                    onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                    onKeyDown={handleAmountKeyDown(index, 'credit')}
                    onDoubleClick={() => handleFillBalance(index, 'credit')}
                    title={t('fill_balance_tooltip')}
                    placeholder="0,00"
                    className="text-right h-8"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                  />
                </td>
                <td className="py-1.5 px-1 text-right tabular-nums text-muted-foreground">
                  {(() => {
                    if (!/^\d{4}$/.test(line.account_number)) return null
                    const bal = accountBalances[line.account_number]
                    if (bal === null || bal === undefined) {
                      return <Skeleton className="h-4 w-20 ml-auto" />
                    }
                    return formatCurrency(bal)
                  })()}
                </td>
                <td className="py-1.5">
                  <div className="flex items-center justify-end">
                    {dimensionsEnabled && (
                      <div
                        className="relative"
                        ref={dimPopoverRow === index ? dimPopoverRef : undefined}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDimPopoverRow(dimPopoverRow === index ? null : index)}
                          className={`h-8 w-8 p-0 min-h-[44px] min-w-[44px] ${
                            line.dimensions && Object.keys(line.dimensions).length > 0
                              ? 'text-foreground'
                              : 'text-muted-foreground'
                          }`}
                          aria-label={t('row_dimensions_aria')}
                          aria-expanded={dimPopoverRow === index}
                          title={t('row_dimensions_aria')}
                        >
                          <Tags className="h-3.5 w-3.5" />
                        </Button>
                        {dimPopoverRow === index && (
                          <div
                            className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border bg-card p-3 shadow-md"
                            onKeyDown={(e) => {
                              // The comboboxes preventDefault their own Escape
                              // (closing their dropdown): only an unhandled
                              // Escape closes the popover.
                              if (e.key === 'Escape' && !e.defaultPrevented) {
                                e.preventDefault()
                                e.stopPropagation()
                                setDimPopoverRow(null)
                              }
                            }}
                          >
                            <LineDimensionFields
                              stacked
                              dimensions={line.dimensions}
                              onChange={(dimNo, code) => updateLineDimension(index, dimNo, code)}
                              inputClassName="h-8"
                            />
                          </div>
                        )}
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeLine(index)}
                      disabled={lines.length <= 2}
                      className="h-8 w-8 p-0 min-h-[44px] min-w-[44px]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td colSpan={2} className="py-2 px-1">
                {t('sum')}
              </td>
              <td
                className={`py-2 px-1 text-right ${
                  isBalanced ? 'text-success' : 'text-destructive'
                }`}
              >
                {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </td>
              <td
                className={`py-2 px-1 text-right ${
                  isBalanced ? 'text-success' : 'text-destructive'
                }`}
              >
                {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        <div className="flex gap-2 mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={addLine}
          >
            <Plus className="h-3 w-3 mr-1" />
            {t('add_line')}
          </Button>
          <BookingTemplatePicker
            onApply={handleTemplateApply}
            entityType={company?.entity_type}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('fill_balance_hint')} {t('keyboard_hint')}
        </p>
      </div>

      {/* Document attachments: hidden when editing a draft; underlag is
          managed from the verifikat detail page (JournalEntryAttachments). */}
      {!embedded && !editEntryId && (
        <div>
          <Label className="mb-2 block">{t('attachments_label')}</Label>
          <DocumentUploadZone
            files={uploadedFiles}
            onFilesChange={setUploadedFiles}
          />
        </div>
      )}

      {!isBalanced && totalDebit > 0 && (
        <p className="text-sm text-destructive">
          {t('difference', { amount: formatCurrency(Math.abs(totalDebit - totalCredit)) })}
        </p>
      )}

      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          {editEntryId ? (
            <Button
              onClick={handleSaveEdit}
              disabled={!isBalanced || !description || !selectedPeriod || !!periodMismatch || isSubmitting || isSavingDraft || isUploading || !canWrite}
              title={!canWrite ? t('read_only_tooltip') : undefined}
            >
              {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : isSavingDraft && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('save_edit')}
            </Button>
          ) : (
            <>
              {!embedded && (
                <Button
                  variant="ghost"
                  onClick={() => setShowClearConfirm(true)}
                  disabled={!hasContent || isSubmitting || isSavingDraft}
                  title={t('clear_all_tooltip')}
                >
                  <Eraser className="mr-2 h-4 w-4" />
                  {t('clear_all')}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={handleSaveDraft}
                disabled={!isBalanced || !description || !selectedPeriod || !!periodMismatch || isSubmitting || isSavingDraft || isUploading || !canWrite}
                title={!canWrite ? t('read_only_tooltip') : t('save_draft_tooltip')}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : isSavingDraft && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('save_draft')}
              </Button>
              <Button
                onClick={handleReview}
                disabled={!isBalanced || !description || !selectedPeriod || !!periodMismatch || isSubmitting || isSavingDraft || isUploading || !canWrite}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4" />}
                {t('review_and_create')}
              </Button>
            </>
          )}
        </div>
        {(!description || !selectedPeriod || isUploading || periodMismatch || incompleteLineCount > 0 || (!isBalanced && submittableLines.length < 2)) && (
          <div className="text-xs text-muted-foreground space-y-0.5 text-right">
            {!description && <p>{t('validation_description')}</p>}
            {!selectedPeriod && <p>{t('validation_period')}</p>}
            {periodMismatch === 'no_period' && <p>{t('validation_no_matching_period')}</p>}
            {isUploading && <p>{t('validation_uploading')}</p>}
            {incompleteLineCount > 0 && (
              <p>{t('validation_incomplete_lines')}</p>
            )}
            {submittableLines.length < 2 && incompleteLineCount === 0 && (
              <p>{t('validation_min_lines')}</p>
            )}
          </div>
        )}
      </div>
      </>
      )}

      <ActivateAccountsDialog
        open={activationDialog.open}
        accountNumbers={activationDialog.accountNumbers}
        onConfirm={confirmActivation}
        onCancel={cancelActivation}
        onCreateUnknown={(num) => {
          cancelActivation()
          const lineIndex = lines.findIndex((l) => l.account_number === num)
          setCreatingAccountForLine(lineIndex >= 0 ? lineIndex : null)
          setCreateAccountPrefill(num)
        }}
      />

      <AddAccountDialog
        open={creatingAccountForLine != null}
        onOpenChange={(next) => {
          if (!next) {
            setCreatingAccountForLine(null)
            setCreateAccountPrefill('')
          }
        }}
        initialAccountNumber={/^\d{1,4}$/.test(createAccountPrefill) ? createAccountPrefill : undefined}
        initialAccountName={/^\d{1,4}$/.test(createAccountPrefill) ? undefined : createAccountPrefill}
        onCreated={handleAccountCreated}
      />

      <ConfirmationDialog
        open={showReview && !bare}
        onOpenChange={setShowReview}
        onConfirm={handleConfirm}
        isSubmitting={isSubmitting}
        autoFocusConfirm
        title={
          !embedded && nextVoucherNumber != null
            ? t('review_title_with_voucher', { voucher: formatVoucher({ voucher_series: voucherSeries, voucher_number: nextVoucherNumber }) })
            : t('review_title')
        }
        warningText={embedded ? '' : t('review_warning')}
      >
        {(monthChanged || selectedPeriodLocked) && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3">
            <AlertTriangle className="h-5 w-5 text-warning-foreground mt-0.5 shrink-0" />
            <div className="flex-1 text-sm text-warning-foreground space-y-0.5">
              {monthChanged && (
                <p className="font-medium">
                  {t('review_month_changed', {
                    prev: monthLabel(lastPostedMonth as string),
                    current: monthLabel(entryMonth),
                  })}
                </p>
              )}
              {selectedPeriodLocked && <p>{t('review_period_locked')}</p>}
            </div>
          </div>
        )}
        <JournalEntryReviewContent
          periodName={periods.find((p) => p.id === selectedPeriod)?.name || ''}
          entryDate={entryDate}
          description={description}
          notes={notes || undefined}
          voucherSeries={!embedded ? voucherSeries : undefined}
          lines={lines}
          totalDebit={totalDebit}
          totalCredit={totalCredit}
          attachmentCount={uploadedFiles.filter((f) => f.status === 'uploaded').length}
          showBalanceBadge={!embedded}
          hideDate={!!embedded}
        />
      </ConfirmationDialog>

      {/* Warning dialog when no documents attached */}
      <ConfirmationDialog
        open={showNoDocWarning && !bare}
        onOpenChange={setShowNoDocWarning}
        onConfirm={() => {
          setShowNoDocWarning(false)
          setShowReview(true)
        }}
        isSubmitting={false}
        autoFocusConfirm
        title={t('no_doc_dialog_title')}
        warningText={t('no_doc_dialog_warning')}
        confirmLabel={t('no_doc_confirm')}
      >
        <div className="text-sm text-muted-foreground">
          {t('no_doc_body')}
        </div>
      </ConfirmationDialog>

      <CreatePeriodDialog
        open={showCreatePeriod}
        onOpenChange={setShowCreatePeriod}
        entryDate={entryDate}
        periods={periods}
        onCreated={fetchPeriods}
      />

      {/* Clear-all confirmation */}
      <Dialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('clear_all_confirm_title')}</DialogTitle>
            <DialogDescription>{t('clear_all_confirm_body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearConfirm(false)}>
              {t('clear_all_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                handleClearAll()
                setShowClearConfirm(false)
              }}
            >
              <Eraser className="mr-2 h-4 w-4" />
              {t('clear_all_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DuplicateBookingDialog
        candidate={duplicateCandidate}
        processing={isSubmitting}
        onCancel={() => setDuplicateCandidate(null)}
        onBookAnyway={handleBookAnyway}
      />
    </div>
  )

  if (embedded || bare) {
    return formContent
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('card_title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {formContent}
      </CardContent>
    </Card>
  )
}
