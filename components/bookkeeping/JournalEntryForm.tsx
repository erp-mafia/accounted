'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Plus, Trash2, AlertTriangle, Loader2, Lock, CalendarPlus } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { JournalEntryReviewContent } from '@/components/bookkeeping/JournalEntryReviewContent'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import BookingTemplatePicker from '@/components/bookkeeping/BookingTemplatePicker'
import CreatePeriodDialog from '@/components/bookkeeping/CreatePeriodDialog'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
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
}

interface Props {
  onCreated?: () => void
  onEntryCreated?: (entryId: string) => void
  initialLines?: FormLine[]
  initialDate?: string
  initialDescription?: string
  initialNotes?: string
  sourceType?: JournalEntrySourceType
  sourceId?: string
  submitUrl?: string
  embedded?: boolean
}

const BLANK_LINE: FormLine = { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }

export default function JournalEntryForm({
  onCreated,
  onEntryCreated,
  initialLines,
  initialDate,
  initialDescription,
  initialNotes,
  sourceType,
  sourceId,
  submitUrl,
  embedded,
}: Props) {
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const { company } = useCompany()
  const t = useTranslations('journal_form')
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [entryDate, setEntryDate] = useState(initialDate ?? new Date().toISOString().split('T')[0])
  const [description, setDescription] = useState(initialDescription ?? '')
  const [notes, setNotes] = useState(initialNotes ?? '')
  const [lines, setLines] = useState<FormLine[]>(
    initialLines ?? [{ ...BLANK_LINE }, { ...BLANK_LINE }]
  )
  const [voucherSeries, setVoucherSeries] = useState('A')
  const [nextVoucherNumber, setNextVoucherNumber] = useState<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [isSavingDraft, setIsSavingDraft] = useState(false)
  const saveAsDraftRef = useRef(false)
  const [showNoDocWarning, setShowNoDocWarning] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [entryCurrency, setEntryCurrency] = useState<Currency>('SEK')
  const [exchangeRate, setExchangeRate] = useState('')
  const [isFetchingRate, setIsFetchingRate] = useState(false)
  const [foreignAmount, setForeignAmount] = useState('')
  const [periodMismatch, setPeriodMismatch] = useState<'no_period' | 'wrong_period' | null>(null)
  const [showCreatePeriod, setShowCreatePeriod] = useState(false)
  // Per-account saldo as of entryDate, keyed by account_number.
  // undefined = not fetched, null = fetch in flight.
  const [accountBalances, setAccountBalances] = useState<Record<string, number | null>>({})

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
    // Fetch default voucher series from company settings — prefer the
    // per-source-type mapping when present; fall back to the legacy
    // default_voucher_series, then to 'A'.
    if (!embedded) {
      fetch('/api/settings').then(r => r.json()).then(({ data }) => {
        if (!data) return
        const effectiveSourceType = sourceType ?? 'manual'
        const perSource = resolveDefaultSeriesForSource(
          data as { default_voucher_series_per_source_type?: Record<string, string> | null } | null,
          effectiveSourceType,
        )
        const fallback = data.default_voucher_series || 'A'
        setVoucherSeries(perSource !== 'A' ? perSource : fallback)
      }).catch(() => {/* keep 'A' */})
    }
  }, [embedded, sourceType])

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
      // Non-critical — user can enter rate manually
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
  // form. Balances are reference-only ("saldo before this entry") — they ignore
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
          // reference value, not authoritative — showing 0 here is preferable
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
        // Reference value — failure is non-fatal, just leave previous state.
      }
    }, 150)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [accountsKey, entryDate])

  const addLine = () => {
    setLines([...lines, { ...BLANK_LINE }])
  }

  const removeLine = (index: number) => {
    if (lines.length <= 2) return
    setLines(lines.filter((_, i) => i !== index))
  }

  const updateLine = (index: number, field: keyof FormLine, value: string) => {
    const updated = [...lines]
    updated[index] = { ...updated[index], [field]: value }

    // If entering debit, clear credit and vice versa
    if (field === 'debit_amount' && value) {
      updated[index].credit_amount = ''
    } else if (field === 'credit_amount' && value) {
      updated[index].debit_amount = ''
    }

    // Auto-fill line description from account name when selecting an account
    if (field === 'account_number' && value) {
      const account = accounts.find((a) => a.account_number === value)
      if (account) {
        updated[index].line_description = account.account_name
      }

      // Auto-fill balancing amount when both amount fields are empty
      if (!updated[index].debit_amount && !updated[index].credit_amount) {
        const otherLines = updated.filter((_, i) => i !== index)
        const otherDebit = otherLines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
        const otherCredit = otherLines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
        const diff = Math.round((otherCredit - otherDebit) * 100) / 100
        if (diff > 0) {
          updated[index].debit_amount = diff.toFixed(2)
        } else if (diff < 0) {
          updated[index].credit_amount = Math.abs(diff).toFixed(2)
        }
      }
    }

    setLines(updated)
  }

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

  const handleTemplateApply = (templateLines: FormLine[], templateDescription: string) => {
    setLines(templateLines)
    if (!description) setDescription(templateDescription)
  }

  const handleReview = () => {
    if (!selectedPeriod || !description || !isBalanced || periodMismatch) return
    const hasDocuments = uploadedFiles.some((f) => f.status === 'uploaded')
    if (!embedded && !hasDocuments) {
      setShowNoDocWarning(true)
      return
    }
    setShowReview(true)
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
    const url = saveAsDraftRef.current ? `${baseUrl}?as_draft=true` : baseUrl
    const res = await fetch(url, {
      method: 'POST',
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
      }),
    })
    return (await throwOnStructuredError(res)) as { data?: { id?: string; voucher_series?: string; voucher_number?: number }; journal_entry_id?: string }
  }, [lines, isForeign, rate, entryCurrency, computedForeignAmount, submitUrl, selectedPeriod, entryDate, description, sourceType, sourceId, voucherSeries, notes])

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
      setShowReview(false)
      setDescription('')
      setNotes('')
      setUploadedFiles([])
      setLines([{ ...BLANK_LINE }, { ...BLANK_LINE }])
      setEntryCurrency('SEK')
      setExchangeRate('')
      setForeignAmount('')
      onCreated?.()
      if (journalEntryId) {
        onEntryCreated?.(journalEntryId)
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        // User dismissed the activation dialog — no toast needed
      } else {
        const anyErr = err as { body?: unknown; status?: number }
        toast({
          title: t('toast_create_failed'),
          description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
          variant: 'destructive',
        })
      }
    } finally {
      setIsSubmitting(false)
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
      setEntryCurrency('SEK')
      setExchangeRate('')
      setForeignAmount('')
      onCreated?.()
      if (journalEntryId) {
        onEntryCreated?.(journalEntryId)
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        // Activation dialog dismissed — silent
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

  const formContent = (
    <div className="space-y-4">
      <div className={`grid gap-4 grid-cols-1 ${
        embedded && initialDate
          ? 'sm:grid-cols-2'
          : embedded
            ? 'sm:grid-cols-3'
            : 'sm:grid-cols-[1fr_auto_1fr_3.5rem]'
      }`}>
        <div>
          <Label>{t('fiscal_year')}</Label>
          <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder={t('fiscal_year_placeholder')} />
            </SelectTrigger>
            <SelectContent>
              {periods.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!(embedded && initialDate) && (
          <div>
            <Label>{t('date')}</Label>
            <Input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />
          </div>
        )}
        <div>
          <Label>{t('description')}</Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('description_placeholder')}
          />
        </div>
        <div className={embedded ? 'hidden' : 'col-span-full'}>
          <Label>{t('internal_note')} <span className="text-muted-foreground font-normal">{t('internal_note_optional')}</span></Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('internal_note_placeholder')}
            className="mt-1 resize-none"
            rows={2}
            maxLength={2000}
          />
        </div>
        {!embedded && (
          <div>
            <Label>{t('series')}</Label>
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
              className="mt-1 text-center font-mono"
              maxLength={1}
            />
          </div>
        )}
      </div>

      {/* Period mismatch warning */}
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

      {/* Currency section */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-24">
          <Label className="text-xs text-muted-foreground">{t('currency')}</Label>
          <Select value={entryCurrency} onValueChange={(v) => {
            setEntryCurrency(v as Currency)
            if (v === 'SEK') {
              setExchangeRate('')
              setForeignAmount('')
            }
          }}>
            <SelectTrigger className="mt-1 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isForeign && (
          <>
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
          </>
        )}
      </div>

      {/* Entry lines — mobile cards */}
      <div className="sm:hidden space-y-3">
        {lines.map((line, index) => (
          <div key={index} className="rounded-lg border bg-card p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <AccountCombobox
                  value={line.account_number}
                  accounts={accounts}
                  onChange={(num) => updateLine(index, 'account_number', num)}
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
              placeholder={t('line_description_placeholder')}
            />
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{t('col_debit')}</Label>
                <Input
                  type="number"
                  value={line.debit_amount}
                  onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
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
                  type="number"
                  value={line.credit_amount}
                  onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                  placeholder="0,00"
                  className="text-right"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                />
              </div>
            </div>
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

      {/* Entry lines — desktop table */}
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
                    onChange={(num) => updateLine(index, 'account_number', num)}
                  />
                </td>
                <td className="py-1.5 px-1">
                  <Input
                    value={line.line_description}
                    onChange={(e) => updateLine(index, 'line_description', e.target.value)}
                    placeholder={t('line_description_placeholder')}
                    className="h-8"
                  />
                </td>
                <td className="py-1.5 px-1">
                  <Input
                    type="number"
                    value={line.debit_amount}
                    onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                    placeholder="0,00"
                    className="text-right h-8"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                  />
                </td>
                <td className="py-1.5 px-1">
                  <Input
                    type="number"
                    value={line.credit_amount}
                    onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeLine(index)}
                    disabled={lines.length <= 2}
                    className="h-8 w-8 p-0 min-h-[44px] min-w-[44px]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
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
      </div>

      {/* Document attachments */}
      {!embedded && (
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

      <ActivateAccountsDialog
        open={activationDialog.open}
        accountNumbers={activationDialog.accountNumbers}
        onConfirm={confirmActivation}
        onCancel={cancelActivation}
      />

      <ConfirmationDialog
        open={showReview}
        onOpenChange={setShowReview}
        onConfirm={handleConfirm}
        isSubmitting={isSubmitting}
        title={
          !embedded && nextVoucherNumber != null
            ? t('review_title_with_voucher', { voucher: formatVoucher({ voucher_series: voucherSeries, voucher_number: nextVoucherNumber }) })
            : t('review_title')
        }
        warningText={embedded ? '' : t('review_warning')}
      >
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
        open={showNoDocWarning}
        onOpenChange={setShowNoDocWarning}
        onConfirm={() => {
          setShowNoDocWarning(false)
          setShowReview(true)
        }}
        isSubmitting={false}
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
    </div>
  )

  if (embedded) {
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
