'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState } from '@/components/ui/empty-state'
import { StartCard } from '@/components/dashboard/StartCard'
import { Skeleton } from '@/components/ui/skeleton'
import {
  TH_CLASS,
  TD_CLASS,
  QUIET_LINK_CLASS,
  HOVER_REVEAL_CLASS,
  CHECKBOX_REVEAL_CLASS,
} from '@/components/ui/dry-table'
import { OpenInNewTab } from '@/components/ui/open-in-new-tab'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { cn } from '@/lib/utils'
import {
  formatCurrency,
  formatDate,
  formatDateLong,
  formatDateTime,
} from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { useRangeSelect } from '@/lib/hooks/use-range-select'
import { rowsNeedingInterestDate } from '@/lib/skatteverket/interest-period'
import {
  skvAuthErrorNeedsReconnect,
  skvStatusNeedsReconnect,
  type SkvStatusLike,
} from '@/lib/notices/predicates'
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Download,
  Loader2,
  MoreHorizontal,
  RefreshCw,
} from 'lucide-react'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type {
  SkatteverketSaldoResponse,
  SkattekontoTransactionWithSuggestion,
  StoredSkattekontoTransaction,
} from '@/extensions/general/skatteverket/types'
import type { SkattekontoBatchRowResult } from '@/types/skatteverket'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { roundOre } from '@/lib/money'

type PaymentFormat = 'bg_lb' | 'pain001'

const SkattekontoMatchDialog = dynamic(
  () =>
    import('@/components/skattekonto/SkattekontoMatchDialog').then(
      (module) => module.SkattekontoMatchDialog,
    ),
  { loading: DialogLoadingSkeleton },
)

const SkattekontoBookDialog = dynamic(
  () => import('@/components/skattekonto/SkattekontoBookDialog'),
  { loading: DialogLoadingSkeleton },
)

interface SaldoEnvelope {
  data: SkatteverketSaldoResponse | null
  fetchedAt: string | null
  lastSyncedAt: string | null
}

interface TransaktionerEnvelope {
  data: {
    booked: SkattekontoTransactionWithSuggestion[]
    overdue: StoredSkattekontoTransaction[]
    upcoming: StoredSkattekontoTransaction[]
    ignored_count: number
    ignored?: StoredSkattekontoTransaction[]
  }
}

export default function SkattekontoPage() {
  const { toast } = useToast()
  const t = useTranslations('skattekonto')
  const locale = useLocale() as ErrorLocale
  const tStart = useTranslations('start_cards')
  const hasSkvCapability = useCapability(CAPABILITY.skatteverket)
  const [showPayment, setShowPayment] = useState(false)
  const [paymentSelection, setPaymentSelection] = useState<StoredSkattekontoTransaction[] | null>(null)
  const [paymentFormat, setPaymentFormat] = useState<PaymentFormat>('pain001')
  const [downloadingPayment, setDownloadingPayment] = useState(false)
  const [paymentDownloaded, setPaymentDownloaded] = useState(false)
  const [bankEnteringIds, setBankEnteringIds] = useState<Set<string>>(new Set())
  const [saldo, setSaldo] = useState<SaldoEnvelope | null>(null)
  const [tx, setTx] = useState<TransaktionerEnvelope['data'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  // Row whose inline booking dialog is open (null = closed).
  const [bookTarget, setBookTarget] = useState<SkattekontoTransactionWithSuggestion | null>(
    null,
  )
  const [notConnected, setNotConnected] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // Reason string from a failed call; the flag is the same state found
  // proactively by the /status probe. Two pieces so reload() stays
  // dependency-free. The banner renders on either.
  const [reconnectMessage, setReconnectMessage] = useState<string | null>(null)
  const [needsReconnect, setNeedsReconnect] = useState(false)
  const [matchOpenFor, setMatchOpenFor] = useState<StoredSkattekontoTransaction | null>(
    null,
  )
  // Ignored rows are always fetched (include_ignored=1) but rendered only on
  // demand: the count line below the table toggles the "Ignorerade" band.
  const [showIgnored, setShowIgnored] = useState(false)
  const { dialogProps: ignoreConfirmProps, confirm: confirmIgnore } =
    useDestructiveConfirm()
  // Bulk ignore (hover-checkbox pattern from /transactions and /orders): a
  // sole trader's skattekonto carries private tax rows that are not the
  // firm's affärshändelser, often dozens at a time. Selection holds raw ids;
  // the rendered set is re-derived against what is still ignorable after a
  // reload, so a row that got booked or ignored meanwhile drops out on its
  // own instead of being carried into the next bulk call.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // The /status probe is fire-and-forget, so a slow response from an earlier
  // reload can land after a later one and overwrite the fresher banner state.
  // Each reload bumps the sequence; a probe only applies its result while it
  // is still the latest.
  const statusProbeSeqRef = useRef(0)

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    // /skattekonto/saldo answers 200 for a token flagged needs_reconsent (it
    // keeps the stale snapshot visible on purpose), so nothing in the payload
    // below reveals a dead session. Probe /status for it. Any failure just
    // leaves the banner off.
    const probeSeq = ++statusProbeSeqRef.current
    void (async () => {
      try {
        const res = await fetch('/api/extensions/ext/skatteverket/status')
        if (probeSeq !== statusProbeSeqRef.current) return
        if (!res.ok) {
          setNeedsReconnect(false)
          return
        }
        const s = (await res.json()) as SkvStatusLike
        if (probeSeq !== statusProbeSeqRef.current) return
        // Shared reconnect predicate (lib/notices): the same decision the
        // transactions page and the Hem notice make, never a local variant.
        const stale = skvStatusNeedsReconnect(s)
        setNeedsReconnect(stale)
        // Also clears a message left by an earlier failed sync: otherwise only
        // syncNow's success path ever cleared it, so a transient 401 kept the
        // banner up until a full remount.
        if (!stale) setReconnectMessage(null)
      } catch {
        if (probeSeq !== statusProbeSeqRef.current) return
        setNeedsReconnect(false)
      }
    })()
    try {
      const [saldoRes, txRes] = await Promise.all([
        fetch('/api/extensions/ext/skatteverket/skattekonto/saldo'),
        fetch('/api/extensions/ext/skatteverket/skattekonto/transaktioner?include_ignored=1'),
      ])

      if (saldoRes.status === 401) {
        setNotConnected(true)
        // A skattekontoutdrag file import populates the table without any
        // SKV connection: keep rendering those rows. The StartCard only
        // shows when the table is empty too.
        if (txRes.ok) {
          const txJson = (await txRes.json()) as TransaktionerEnvelope
          setTx(txJson.data)
        }
        return
      }
      // A non-401 response proves a connection now exists: clear a stale
      // not-connected state so a reload after connecting (in another tab or
      // via the visibility refetch below) actually flips the page over.
      setNotConnected(false)

      // A non-auth failure must NOT fall through to the "inget saldo hämtat
      // ännu"-tomvy — that reads as "not configured" when the truth is "the
      // fetch broke". Surface it as an error with a retry instead.
      if (!saldoRes.ok) {
        setLoadError(true)
        return
      }

      const saldoJson = (await saldoRes.json()) as SaldoEnvelope
      setSaldo(saldoJson)

      if (txRes.ok) {
        const txJson = (await txRes.json()) as TransaktionerEnvelope
        setTx(txJson.data)
      }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Auto-recover from the "inte anslutet" empty state when the user returns
  // to this tab: the connect flow lives in Inställningar (often completed in
  // another tab or after a mobile BankID app-switch), so no in-window signal
  // can reach this page. Also fires while the reconnect banner is showing:
  // same journey, and otherwise the banner survives the consent that fixed
  // it. Throttled so rapid tab toggling doesn't hammer the API.
  const staleConnectionRef = useRef(false)
  useEffect(() => {
    staleConnectionRef.current = notConnected || needsReconnect || reconnectMessage !== null
  }, [notConnected, needsReconnect, reconnectMessage])
  const lastVisibilityReloadRef = useRef(0)
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      if (!staleConnectionRef.current) return
      const now = Date.now()
      if (now - lastVisibilityReloadRef.current < 5_000) return
      lastVisibilityReloadRef.current = now
      void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/skattekonto/sync', {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) {
        // 401 covers several distinct auth states (see handleSkvError in the
        // skatteverket extension). Only NOT_CONNECTED means "no connection
        // exists" — the rest (SESSION_EXPIRED, MISSING_SCOPE, TOKEN_REVOKED,
        // …) fire while Inställningar truthfully shows the stored token as
        // "Ansluten". Showing the full "inte anslutet"-tomvy for those
        // contradicts the settings panel; show the server's actual reason
        // with a reconnect CTA instead. The split lives in the shared
        // skvAuthErrorNeedsReconnect predicate (lib/notices), never inline.
        if (res.status === 401) {
          if (skvAuthErrorNeedsReconnect(res.status, json.code)) {
            setReconnectMessage(
              typeof json.error === 'string' && json.error
                ? json.error
                : t('attn_reconnect_body'),
            )
          } else {
            setNotConnected(true)
          }
          return
        }
        // Map the parsed body plus the status, never `new Error(json.error)`:
        // the Error constructor stringifies a non-string body field, and the
        // mapper would discard the route's own Swedish reason.
        toast({
          title: 'Synk misslyckades',
          description: getUserErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      setReconnectMessage(null)
      setNeedsReconnect(false)
      toast({
        title: 'Skattekonto synkroniserat',
        description: `${json.data.booked} bokförda, ${json.data.upcoming} kommande`,
      })
      await reload()
    } catch (err) {
      toast({
        title: 'Synk misslyckades',
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setSyncing(false)
    }
  }

  function bokfor(id: string) {
    // Open the inline booking dialog instead of the old draft-then-navigate
    // detour. The row may live in any bucket: genomförda rows carry the
    // booking suggestion, kommande/förfallna open in plain draft mode.
    const row =
      tx?.booked.find((r) => r.id === id) ??
      tx?.overdue.find((r) => r.id === id) ??
      tx?.upcoming.find((r) => r.id === id) ??
      null
    if (row) setBookTarget(row)
  }

  function handleBooked(_rowId: string, result: SkattekontoBatchRowResult) {
    setBookTarget(null)
    const voucherLabel =
      result.voucher_series && result.voucher_number != null
        ? formatVoucher({
            voucher_series: result.voucher_series,
            voucher_number: result.voucher_number,
          })
        : null
    toast({
      title: t('booked_toast_title'),
      description: voucherLabel
        ? t('booked_toast_description', { voucher: voucherLabel })
        : undefined,
      action: result.journal_entry_id ? (
        <ToastAction altText={t('booked_toast_show')} asChild>
          <Link href={`/bookkeeping/${result.journal_entry_id}`}>
            {t('booked_toast_show')}
          </Link>
        </ToastAction>
      ) : undefined,
    })
    void reload()
  }

  // The shared dialog fetches candidates (single, combined and joined, see
  // findMatchCandidates) and links on its own; the page only reloads.
  function openMatch(row: StoredSkattekontoTransaction) {
    setMatchOpenFor(row)
  }
  const closeMatch = useCallback(() => setMatchOpenFor(null), [])

  function copyOcr(ocr: string) {
    navigator.clipboard
      .writeText(ocr)
      .then(() => toast({ title: 'OCR kopierat' }))
      .catch(() => {})
  }

  async function unignoreRow(id: string) {
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${id}/ignore`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_ignored: false }),
        },
      )
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast({
          title: t('unignore_failed'),
          description: getUserErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      await reload()
    } catch (err) {
      toast({
        title: t('unignore_failed'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    }
  }

  async function ignoreRow(row: StoredSkattekontoTransaction) {
    // Semi-destructive (the row leaves the work list), so confirm up front;
    // the toast's Ångra plus the standing "Ignorerade" band are the second
    // and third recovery affordances. Never a delete: the row stays in the
    // table with is_ignored = true.
    const ok = await confirmIgnore(
      {
        title: t('ignore_confirm_title'),
        description: t('ignore_confirm_body', {
          text: row.transaktionstext,
          amount: formatCurrency(Number(row.belopp_skatteverket)),
          date: formatDate(row.transaktionsdatum),
        }),
        confirmLabel: t('ignore_confirm_cta'),
        cancelLabel: t('ignore_confirm_cancel'),
        variant: 'warning',
      },
      async () => {
        const res = await fetch(
          `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/ignore`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_ignored: true }),
          },
        )
        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          toast({
            title: t('ignore_failed'),
            description: getUserErrorMessage(json, { statusCode: res.status }),
            variant: 'destructive',
          })
          throw new Error('ignore failed')
        }
      },
    )
    if (!ok) return
    toast({
      title: t('ignored_toast_title'),
      action: (
        <ToastAction altText={t('ignored_undo')} onClick={() => void unignoreRow(row.id)}>
          {t('ignored_undo')}
        </ToastAction>
      ),
    })
    await reload()
  }

  /**
   * PATCH the ignore flag on many rows through the same per-row route the
   * single action uses (one select + one conditional update each, so N calls
   * stay cheap and every row keeps the same booked-row 409 guard). Bounded
   * concurrency: a sole trader can select a whole year in one go.
   */
  async function patchIgnoreMany(
    ids: string[],
    isIgnored: boolean,
  ): Promise<{ done: string[]; failed: string[] }> {
    const done: string[] = []
    const failed: string[] = []
    const queue = [...ids]
    const worker = async () => {
      for (;;) {
        const id = queue.shift()
        if (!id) return
        try {
          const res = await fetch(
            `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${id}/ignore`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ is_ignored: isIgnored }),
            },
          )
          if (res.ok) done.push(id)
          else failed.push(id)
        } catch {
          failed.push(id)
        }
      }
    }
    await Promise.allSettled(Array.from({ length: Math.min(6, ids.length) }, worker))
    return { done, failed }
  }

  async function unignoreMany(ids: string[]) {
    const { failed } = await patchIgnoreMany(ids, false)
    if (failed.length > 0) {
      toast({
        title: t('unignore_failed'),
        description: t('bulk_unignore_partial', { failed: failed.length }),
        variant: 'destructive',
      })
    }
    await reload()
  }

  async function ignoreSelected(ids: string[]) {
    if (ids.length === 0) return
    // Same shape as the single-row flow: confirm once up front, Ångra in the
    // toast, and the standing "Ignorerade" band as the lasting way back.
    let outcome: { done: string[]; failed: string[] } = { done: [], failed: [] }
    const ok = await confirmIgnore(
      {
        title: t('bulk_ignore_confirm_title', { count: ids.length }),
        description: t('bulk_ignore_confirm_body', { count: ids.length }),
        confirmLabel: t('bulk_ignore_cta', { count: ids.length }),
        cancelLabel: t('ignore_confirm_cancel'),
        variant: 'warning',
      },
      async () => {
        outcome = await patchIgnoreMany(ids, true)
      },
    )
    if (!ok) return
    setSelectedIds(new Set())
    const undo =
      outcome.done.length > 0 ? (
        <ToastAction
          altText={t('ignored_undo')}
          onClick={() => void unignoreMany(outcome.done)}
        >
          {t('ignored_undo')}
        </ToastAction>
      ) : undefined
    if (outcome.failed.length === 0) {
      toast({ title: t('bulk_ignored_toast_title', { count: outcome.done.length }), action: undo })
    } else {
      // Partial result stays honest: the count that landed, the count that
      // did not (a row booked meanwhile answers 409), and Ångra for the
      // ones that did.
      toast({
        title: t('bulk_ignore_partial_title', { done: outcome.done.length, total: ids.length }),
        description: t('bulk_ignore_partial_body', { failed: outcome.failed.length }),
        variant: 'destructive',
        action: undo,
      })
    }
    await reload()
  }

  // Next charge (concept attn line): the earliest upcoming due date and the
  // sum of everything Skatteverket draws that day. Ignored rows stay out of
  // the work-list buckets, but SKV draws an upcoming charge regardless of our
  // ignore flag, so the saldo-coverage math re-includes them here (same
  // future-due predicate the server bucket applies to unignored rows).
  const nextCharge = useMemo(() => {
    const dueOf = (r: StoredSkattekontoTransaction) =>
      r.forfallodatum ?? r.transaktionsdatum
    const today = new Date().toISOString().slice(0, 10)
    const ignoredUpcoming = (tx?.ignored ?? []).filter(
      (r) => r.status !== 'booked' && dueOf(r) >= today,
    )
    const upcoming = [...(tx?.upcoming ?? []), ...ignoredUpcoming]
    const due = upcoming.map(dueOf).sort()[0]
    if (!due) return null
    const rows = upcoming.filter((r) => dueOf(r) === due)
    const amount = rows.reduce((sum, r) => sum + Number(r.belopp_skatteverket), 0)
    return { due, count: rows.length, amount: Math.round(Math.abs(amount) * 100) / 100, rows }
  }, [tx])

  // Ignorable rows in rendered order (upcoming, overdue, then the unbooked
  // rows of Genomförda): the order shift-range selection follows. Booked
  // rows can never be ignored (the route answers 409, the DB CHECK agrees)
  // and the Ignorerade band is already ignored, so neither gets a checkbox.
  const selectableIds = useMemo(
    () =>
      [...(tx?.upcoming ?? []), ...(tx?.overdue ?? []), ...(tx?.booked ?? [])]
        .filter((r) => !r.journal_entry_id)
        .map((r) => r.id),
    [tx],
  )
  const activeSelectedIds = useMemo(() => {
    const selectable = new Set(selectableIds)
    return new Set([...selectedIds].filter((id) => selectable.has(id)))
  }, [selectableIds, selectedIds])
  const allSelectableSelected =
    selectableIds.length > 0 && activeSelectedIds.size === selectableIds.length
  const selectedRows = useMemo(() => {
    const allRows = [...(tx?.upcoming ?? []), ...(tx?.overdue ?? []), ...(tx?.booked ?? [])]
    return allRows.filter((row) => activeSelectedIds.has(row.id))
  }, [activeSelectedIds, tx])
  const selectionCanBePaid =
    selectedRows.length > 0 &&
    selectedRows.every(
      (row) =>
        row.status === 'upcoming' &&
        Number(row.belopp_skatteverket) < 0 &&
        !row.bank_entered_at,
    )
  const range = useRangeSelect({ visibleIds: selectableIds, selectedIds, setSelectedIds })
  const toggleSelect = useCallback(
    (id: string, extend?: boolean) => range.toggle(id, extend),
    [range],
  )

  const saldoNow = saldo?.data ? saldo.data.saldoSkatteverket : null
  const shortfall =
    nextCharge && saldoNow !== null && saldoNow < nextCharge.amount
      ? Math.round((nextCharge.amount - saldoNow) * 100) / 100
      : null
  const rowsForPayment = (paymentSelection ?? nextCharge?.rows ?? []).filter(
    (row) => Number(row.belopp_skatteverket) < 0 && !row.bank_entered_at,
  )
  const paymentDue = rowsForPayment[0]
    ? (rowsForPayment[0].forfallodatum ?? rowsForPayment[0].transaktionsdatum)
    : null
  const paymentGroups = [...rowsForPayment.reduce((groups, row) => {
    const dueDate = row.forfallodatum ?? row.transaktionsdatum
    groups.set(
      dueDate,
      roundOre((groups.get(dueDate) ?? 0) + Math.abs(Number(row.belopp_skatteverket))),
    )
    return groups
  }, new Map<string, number>()).entries()].sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
  const paymentCharge = roundOre(paymentGroups.reduce((sum, [, amount]) => sum + amount, 0))
  const paymentPeriod = paymentGroups.length > 1
    ? `${paymentGroups[0][0]}_${paymentGroups[paymentGroups.length - 1][0]}`
    : paymentDue

  const downloadPayment = async () => {
    if (downloadingPayment || rowsForPayment.length === 0) return
    setDownloadingPayment(true)
    try {
      const ids = rowsForPayment.map((row) => row.id).join(',')
      const filename = paymentFormat === 'pain001'
        ? `pain001_skatt_${paymentPeriod}.xml`
        : `bg_lb_skatt_${paymentPeriod}.txt`
      const result = await downloadFile({
        url: `/api/skatteverket/tax-payments/payment-file?transaction_ids=${encodeURIComponent(ids)}&format=${paymentFormat}`,
        filename,
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('payment_download_failed'),
          description: failureDescription(result, {
            timeout: t('payment_download_timeout'),
            network: t('payment_download_network'),
          }),
          variant: 'destructive',
        })
        return
      }
      setPaymentDownloaded(true)
      toast({ title: t('payment_downloaded') })
    } finally {
      setDownloadingPayment(false)
    }
  }

  const setRowsBankEntered = async (
    rows: StoredSkattekontoTransaction[],
    entered: boolean,
  ): Promise<boolean> => {
    const ids = rows.map((row) => row.id)
    if (ids.length === 0 || ids.some((id) => bankEnteringIds.has(id))) return false
    setBankEnteringIds((current) => new Set([...current, ...ids]))
    try {
      const response = await fetch('/api/skatteverket/tax-payments/bank-entered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_ids: ids, entered }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: t('bank_entered_failed_title'),
          description: getUserErrorMessage(result, { statusCode: response.status, locale }),
          variant: 'destructive',
        })
        await reload()
        return false
      }
      toast({
        title: entered ? t('bank_entered_toast') : t('bank_entered_cleared_toast'),
      })
      await reload()
      return true
    } catch (error) {
      toast({
        title: t('bank_entered_failed_title'),
        description: getUserErrorMessage(error, { locale }),
        variant: 'destructive',
      })
      await reload()
      return false
    } finally {
      setBankEnteringIds((current) => {
        const next = new Set(current)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }
  }

  const helpNode = (
    <HelpPopover>
      <p>{t('help_text')}</p>
    </HelpPopover>
  )

  const hasLocalRows =
    tx !== null &&
    tx.booked.length + tx.overdue.length + tx.upcoming.length + tx.ignored_count > 0

  // Drives ONE ochre line and nothing else: nothing on this page is hidden or
  // removed while it is true. needs_reconsent is the resting state for the
  // personal-token cohort (93% of connected companies on 2026-08-26), so
  // anything that HIDES on this flag hides from nearly everyone.
  const showReconnect = needsReconnect || reconnectMessage !== null
  const reconnectBody = reconnectMessage ?? t('attn_reconnect_body')

  if (notConnected && !hasLocalRows) {
    return (
      <div className="space-y-8">
        <PageHeader title="Skattekonto" help={helpNode} />
        <div className="animate-fade-in">
          <StartCard
            card="abacus"
            layout="side-right"
            title={tStart('skattekonto_title')}
            body={tStart('skattekonto_body')}
            primary={{ label: tStart('skattekonto_primary'), href: '/settings/skatteverket' }}
            secondary={{ label: t('import_statement_action'), href: '/import?mode=skattekonto' }}
          />
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="space-y-8">
        <PageHeader title="Skattekonto" help={helpNode} />
        <EmptyState
          icon={AlertCircle}
          title="Kunde inte hämta skattekontot"
          description="Något gick fel när saldo och transaktioner skulle hämtas. Försök igen om en stund."
        >
          <Button variant="outline" onClick={() => void reload()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Försök igen
          </Button>
        </EmptyState>
      </div>
    )
  }

  const data = saldo?.data ?? null

  return (
    <div className="space-y-8">
      <PageHeader
        title="Skattekonto"
        help={helpNode}
        action={
          notConnected ? (
            <Button size="sm"
              variant="ghost"
              asChild
              className="text-muted-foreground hover:text-foreground"
            >
              <Link href="/import?mode=skattekonto">{t('import_statement_action')}</Link>
            </Button>
          ) : (
            // The span carries the tooltip: `title` is suppressed on disabled elements.
            <span title={!hasSkvCapability ? 'Synk mot Skatteverket kräver ett abonnemang' : undefined}>
              <Button size="sm"
                variant="ghost"
                onClick={syncNow}
                disabled={syncing || !hasSkvCapability}
                className="text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Synkroniserar…' : 'Synkronisera nu'}
              </Button>
            </span>
          )
        }
      />

      {/* Page level, not nested in the saldo section: the line used to live
          inside the `data` branch below, so a company with no snapshot got no
          feedback at all when the sync it just clicked died. Coexists with the
          shortfall line under convention 6's 2026-08-19 addendum (one
          lib/notices notice plus one page-domain attn line). */}
      {showReconnect ? (
        <AttnLine action={{ label: t('attn_reconnect_action'), href: '/settings/skatteverket' }}>
          {reconnectBody}
        </AttnLine>
      ) : notConnected ? (
        // File-imported rows without a connection: no saldo to show, but the
        // booking/matching flows below work on the local table. One ochre
        // sentence with the connect action, per the attn convention.
        <AttnLine
          action={{ label: tStart('skattekonto_primary'), href: '/settings/skatteverket' }}
        >
          {t('imported_not_connected_attn')}
        </AttnLine>
      ) : null}

      {/* Saldo as compact stat tiles (house metric-card idiom, KPIHeroCards).
          Hidden entirely for unconnected companies rendering imported rows:
          there is no saldo to fetch and the "Synkronisera nu" hint would
          point at a button that cannot work. */}
      {!notConnected && (
      <section className="space-y-4">
        {loading && !data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-28 w-full rounded-lg" />
            <Skeleton className="h-28 w-full rounded-lg" />
          </div>
        ) : !data ? (
          <p className="py-4 text-sm text-muted-foreground">
            Inget saldo hämtat ännu: klicka på ”Synkronisera nu”.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border p-4">
                <div className="flex items-center gap-2">
                  <Image
                    src="/logos/skatteverket_color.svg"
                    alt=""
                    width={16}
                    height={16}
                    className="h-4 w-4 shrink-0 object-contain"
                  />
                  <p className="text-xs text-muted-foreground">Saldo hos Skatteverket</p>
                </div>
                <p
                  className={cn(
                    'mt-2 font-display text-2xl tabular-nums tracking-tight',
                    data.saldoSkatteverket < 0 && 'text-destructive',
                  )}
                >
                  {formatCurrency(data.saldoSkatteverket)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  OCR <span className="tabular-nums">{data.ocrNummer}</span>{' '}
                  <button
                    type="button"
                    onClick={() => copyOcr(data.ocrNummer)}
                    className={QUIET_LINK_CLASS}
                    aria-label="Kopiera OCR"
                  >
                    {t('copy')}
                  </button>
                  {saldo?.lastSyncedAt && (
                    <>
                      {' '}· synkad{' '}
                      <span className="tabular-nums">{formatDateTime(saldo.lastSyncedAt)}</span>
                    </>
                  )}
                </p>
                {data.rantaSkatteverket !== 0 && (
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    Preliminär ränta: {formatCurrency(data.rantaSkatteverket)}
                  </p>
                )}
                {data.saldoKronofogden !== 0 && (
                  <p className="mt-1 text-xs font-medium tabular-nums text-destructive">
                    Hos Kronofogden: {formatCurrency(data.saldoKronofogden)}
                    {data.rantaKronofogden !== 0 &&
                      ` (ränta ${formatCurrency(data.rantaKronofogden)})`}
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">Nästa dragning</p>
                {nextCharge ? (
                  <>
                    <p className="mt-2 font-display text-2xl tabular-nums tracking-tight">
                      {formatCurrency(nextCharge.amount)}
                    </p>
                    <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                      {formatDateLong(nextCharge.due)}
                      {nextCharge.count > 1 && ` · ${nextCharge.count} händelser`}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Inga kommande dragningar.
                  </p>
                )}
              </div>
            </div>

            {/* The reconnect line moved to page level; this slot keeps the
                shortfall notice, which needs `data`. Deliberately still shown
                while a reconnect is pending: it is the warning that prevents
                kostnadsränta, and its action is this page's only route to the
                bankgiro and OCR. */}
            {shortfall !== null && nextCharge ? (
              <AttnLine
                action={{
                  label: t('attn_show_payment'),
                  onClick: () => {
                    setPaymentSelection(null)
                    setPaymentDownloaded(false)
                    setShowPayment(true)
                  },
                }}
              >
                {t('attn_shortfall', {
                  date: formatDateLong(nextCharge.due),
                  charge: formatCurrency(nextCharge.amount),
                  missing: formatCurrency(shortfall),
                })}
              </AttnLine>
            ) : null}

            {/* Optional chain on purpose: `data` is Skatteverket's raw saldo
                JSON cast to our interface, and informationstext is not a
                required field in SKV's own v2.1.0 schema. A response without
                it blanked the whole Skattekonto page. */}
            {(data.informationstext?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Information från Skatteverket
                </p>
                {(data.informationstext ?? []).map((info, i) => (
                  <p key={i} className="text-xs leading-5 text-muted-foreground">
                    {info}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      )}

      {/* Keep the bulk actions mounted whenever the table has selectable rows.
          Selection only changes the controls' enabled state, never the page
          geometry, so checking a row cannot push the table down. */}
      {selectableIds.length > 0 && (
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border px-1 py-2 text-[12.5px]">
          <span className="whitespace-nowrap">
            {t('bulk_selected', { count: activeSelectedIds.size })}
          </span>
          <Button
            size="sm"
            disabled={!selectionCanBePaid}
            onClick={() => {
              setPaymentSelection(selectedRows)
              setPaymentDownloaded(false)
              setShowPayment(true)
            }}
          >
            {t('bulk_payment_cta', { count: activeSelectedIds.size })}
          </Button>
          <Button
            size="sm"
            disabled={activeSelectedIds.size === 0}
            onClick={() => void ignoreSelected([...activeSelectedIds])}
          >
            {t('bulk_ignore_cta', { count: activeSelectedIds.size })}
          </Button>
        </div>
      )}

      {/* One dry table with band rows (concept): Kommande, Förfallna, Genomförda */}
      <SkattekontoTable
        tx={tx}
        showIgnored={showIgnored}
        selectedIds={activeSelectedIds}
        selectableCount={selectableIds.length}
        allSelectableSelected={allSelectableSelected}
        onToggleSelectAll={() => {
          setSelectedIds(allSelectableSelected ? new Set() : new Set(selectableIds))
          range.resetAnchor()
        }}
        onToggleSelect={toggleSelect}
        bankEnteringIds={bankEnteringIds}
        onSetBankEntered={(row, entered) => void setRowsBankEntered([row], entered)}
        onBokfor={bokfor}
        onMatch={openMatch}
        onIgnore={ignoreRow}
        onUnignore={(row) => void unignoreRow(row.id)}
      />

      {/* Ignored rows never disappear silently: a standing count line with a
          toggle keeps them one click away (BFL 5 kap anti-vanish ethos). */}
      {(tx?.ignored_count ?? 0) > 0 && (
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          {t('ignored_count_line', { count: tx?.ignored_count ?? 0 })}{' '}
          <button
            type="button"
            onClick={() => setShowIgnored((v) => !v)}
            className={QUIET_LINK_CLASS}
          >
            {showIgnored ? t('hide_ignored') : t('show_ignored')}
          </button>
        </p>
      )}

      <DestructiveConfirmDialog {...ignoreConfirmProps} />

      {bookTarget && (
        <SkattekontoBookDialog
          row={bookTarget}
          open
          onOpenChange={(o) => {
            if (!o) setBookTarget(null)
          }}
          onBooked={handleBooked}
          onMatch={() => {
            const target = bookTarget
            setBookTarget(null)
            openMatch(target)
          }}
        />
      )}

      <SkattekontoMatchDialog
        row={matchOpenFor}
        open={!!matchOpenFor}
        onClose={closeMatch}
        onMatched={() => void reload()}
      />

      <Dialog
        open={showPayment}
        onOpenChange={(open) => {
          setShowPayment(open)
          if (!open) {
            setPaymentSelection(null)
            setPaymentDownloaded(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-lg tracking-tight">
              {t('payment_title')}
            </DialogTitle>
            {paymentDue && (
              <DialogDescription className="text-[13px] leading-relaxed">
                {t('payment_description', {
                  count: rowsForPayment.length,
                })}
              </DialogDescription>
            )}
          </DialogHeader>
          <dl className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{t('payment_bankgiro_label')}</dt>
              <dd className="font-medium tabular-nums">5050-1055</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">OCR</dt>
              <dd className="flex items-center gap-2 font-medium tabular-nums">
                {data?.ocrNummer}
                {data && (
                  <button
                    type="button"
                    onClick={() => copyOcr(data.ocrNummer)}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Kopiera OCR"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                )}
              </dd>
            </div>
            {paymentGroups.map(([dueDate, amount]) => (
              <div key={dueDate} className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{formatDateLong(dueDate)}</dt>
                <dd className="tabular-nums">{formatCurrency(amount)}</dd>
              </div>
            ))}
            {saldoNow !== null && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{t('payment_balance_label')}</dt>
                <dd className="tabular-nums">{formatCurrency(saldoNow)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{t('payment_total_label')}</dt>
              <dd className="font-medium tabular-nums">{formatCurrency(paymentCharge)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{t('payment_format_label')}</dt>
              <dd>
                <SettingsSelect
                  aria-label={t('payment_format_label')}
                  value={paymentFormat}
                  onChange={(event) => setPaymentFormat(event.target.value as PaymentFormat)}
                  wrapperClassName="-my-1"
                >
                  <option value="pain001">ISO 20022 pain.001</option>
                  <option value="bg_lb">Bankgirot LB</option>
                </SettingsSelect>
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-5 text-muted-foreground">
            {t('payment_bank_entered_hint')}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void downloadPayment()}
              disabled={downloadingPayment || paymentCharge <= 0}
            >
              {downloadingPayment ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {t('payment_download_cta')}
            </Button>
            <Button
              disabled={
                !paymentDownloaded ||
                rowsForPayment.length === 0 ||
                rowsForPayment.some((row) => bankEnteringIds.has(row.id))
              }
              onClick={() => {
                void (async () => {
                  const marked = await setRowsBankEntered(rowsForPayment, true)
                  if (!marked) return
                  setSelectedIds(new Set())
                  range.resetAnchor()
                  setShowPayment(false)
                  setPaymentSelection(null)
                  setPaymentDownloaded(false)
                })()
              }}
            >
              {rowsForPayment.some((row) => bankEnteringIds.has(row.id)) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t('payment_mark_bank_entered_cta')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type TableSection = {
  key: 'upcoming' | 'overdue' | 'booked' | 'ignored'
  label: string
  rows: SkattekontoTransactionWithSuggestion[]
}

/**
 * The date this row shows in the Datum column. Upcoming and overdue rows lead
 * with their due date; genomförda rows lead with the transaction date.
 */
function rowDisplayDate(
  row: StoredSkattekontoTransaction,
  section: TableSection['key'],
): string {
  return section === 'upcoming' || section === 'overdue'
    ? (row.forfallodatum ?? row.transaktionsdatum)
    : row.transaktionsdatum
}

function SkattekontoTable({
  tx,
  showIgnored,
  selectedIds,
  selectableCount,
  allSelectableSelected,
  onToggleSelectAll,
  onToggleSelect,
  bankEnteringIds,
  onSetBankEntered,
  onBokfor,
  onMatch,
  onIgnore,
  onUnignore,
}: {
  tx: TransaktionerEnvelope['data'] | null
  showIgnored: boolean
  selectedIds: Set<string>
  selectableCount: number
  allSelectableSelected: boolean
  onToggleSelectAll: () => void
  onToggleSelect: (id: string, extend?: boolean) => void
  bankEnteringIds: Set<string>
  onSetBankEntered: (row: StoredSkattekontoTransaction, entered: boolean) => void
  onBokfor: (id: string) => void
  onMatch: (row: StoredSkattekontoTransaction) => void
  onIgnore: (row: StoredSkattekontoTransaction) => void
  onUnignore: (row: StoredSkattekontoTransaction) => void
}) {
  const t = useTranslations('skattekonto')
  const hasSelection = selectedIds.size > 0

  const allSections: TableSection[] = [
    { key: 'upcoming', label: t('band_upcoming'), rows: tx?.upcoming ?? [] },
    { key: 'overdue', label: t('band_overdue'), rows: tx?.overdue ?? [] },
    { key: 'booked', label: t('band_booked'), rows: tx?.booked ?? [] },
    ...(showIgnored
      ? [{ key: 'ignored' as const, label: t('band_ignored'), rows: tx?.ignored ?? [] }]
      : []),
  ]
  // Rows from a retroactive omprövningsbeslut share date, text and amount, so
  // they render identically unless we surface ränteberäkningsdatum. Resolved
  // per band, since rows are only confusable with the rows beside them.
  const sections = allSections
    .filter((s) => s.rows.length > 0)
    .map((s) => ({
      ...s,
      interestDateRowIds: rowsNeedingInterestDate(
        s.rows.map((r) => ({
          id: r.id,
          displayDate: rowDisplayDate(r, s.key),
          transaktionstext: r.transaktionstext,
          belopp: Number(r.belopp_skatteverket),
          ranteberakningsdatum: r.ranteberakningsdatum,
        })),
      ),
    }))

  if (sections.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t('no_transactions')}
      </p>
    )
  }

  return (
    <div
      className="overflow-x-auto"
      role="region"
      aria-label="Skattekontohändelser"
    >
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={cn(TH_CLASS, 'w-[26px] !px-1')}>
              <Checkbox
                checked={allSelectableSelected ? true : hasSelection ? 'indeterminate' : false}
                onCheckedChange={onToggleSelectAll}
                aria-label={
                  allSelectableSelected
                    ? t('bulk_clear')
                    : t('bulk_select_all', { count: selectableCount })
                }
                className="border-foreground"
              />
            </th>
            <th className={cn(TH_CLASS, 'w-[110px]')}>Datum</th>
            <th className={TH_CLASS}>Händelse</th>
            <th className={cn(TH_CLASS, 'text-right')}>Belopp</th>
            <th className={cn(TH_CLASS, 'w-[150px]')} />
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {sections.map((section) => (
            <Fragment key={section.key}>
              <tr className="bg-muted/30">
                <td className="w-[26px] !px-1" aria-hidden="true" />
                <td
                  colSpan={4}
                  className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
                >
                  {section.label}
                  {section.key === 'booked' && section.rows.some((r) => !r.journal_entry_id) && (
                    <span className="ml-2 font-normal normal-case tracking-normal">
                      · {t('band_not_booked_count', { count: section.rows.filter((r) => !r.journal_entry_id).length })}
                    </span>
                  )}
                </td>
              </tr>
              {section.rows.map((row) => (
                <SkattekontoRow
                  key={row.id}
                  row={row}
                  section={section.key}
                  isSelected={selectedIds.has(row.id)}
                  onToggleSelect={onToggleSelect}
                  bankEntering={bankEnteringIds.has(row.id)}
                  onSetBankEntered={onSetBankEntered}
                  onBokfor={onBokfor}
                  onMatch={onMatch}
                  onIgnore={onIgnore}
                  onUnignore={onUnignore}
                  showInterestDate={section.interestDateRowIds.has(row.id)}
                />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SkattekontoRow({
  row,
  section,
  isSelected,
  onToggleSelect,
  bankEntering,
  onSetBankEntered,
  onBokfor,
  onMatch,
  onIgnore,
  onUnignore,
  showInterestDate,
}: {
  row: SkattekontoTransactionWithSuggestion
  section: TableSection['key']
  isSelected: boolean
  onToggleSelect: (id: string, extend?: boolean) => void
  bankEntering: boolean
  onSetBankEntered: (row: StoredSkattekontoTransaction, entered: boolean) => void
  onBokfor: (id: string) => void
  onMatch: (row: StoredSkattekontoTransaction) => void
  onIgnore: (row: StoredSkattekontoTransaction) => void
  onUnignore: (row: StoredSkattekontoTransaction) => void
  showInterestDate: boolean
}) {
  const t = useTranslations('skattekonto')
  // Whether shift was held on the checkbox click, for range selection.
  const shiftHeld = useRef(false)
  const amount = Number(row.belopp_skatteverket)
  const isBooked = !!row.journal_entry_id
  const isIgnoredSection = section === 'ignored'
  const selectable = !isBooked && !isIgnoredSection
  const displayDate = rowDisplayDate(row, section)

  return (
    <tr
      className={cn(
        'group transition-colors duration-150 hover:bg-secondary/35',
        isIgnoredSection && 'opacity-60',
        isSelected && 'bg-secondary/40',
      )}
    >
      {/* Selection is a real first table column. Keeping its width in the
          header, bands and every row prevents the date column from moving. */}
      <td className={cn(TD_CLASS, 'w-[26px] !px-1 py-[9px] select-none')}>
        {selectable && (
          <Checkbox
            checked={isSelected}
            onClick={(e) => {
              shiftHeld.current = e.shiftKey
            }}
            onCheckedChange={() => onToggleSelect(row.id, shiftHeld.current)}
            aria-label={t('select_row_aria', { text: row.transaktionstext })}
            className={cn(
              'border-foreground duration-150',
              isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
            )}
          />
        )}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
        {formatDate(displayDate)}
      </td>
      <td className={TD_CLASS}>
        <span className="inline-flex flex-wrap items-center gap-2">
          {row.transaktionstext}
          {/* A retroactive beslut arrives as one row per re-charged month,
              identical apart from ränteberäkningsdatum. Without this the rows
              read as duplicates from the automatic hämtning. */}
          {showInterestDate && row.ranteberakningsdatum && (
            <span className="text-[12.5px] tabular-nums text-muted-foreground">
              {t('interest_from', { date: formatDate(row.ranteberakningsdatum) })}
            </span>
          )}
          {/* Chips mark exceptions: only a *genomförd* row that is still
              unbooked deviates; upcoming rows are unbooked by nature. */}
          {section === 'booked' && !isBooked && (
            row.match_suggestion ? (
              /* data-ph-mask: the voucher reference is user data */
              <Badge variant="warning" className="font-normal" data-ph-mask="">
                {t('chip_possible_duplicate', {
                  voucher:
                    row.match_suggestion.voucher_series && row.match_suggestion.voucher_number
                      ? formatVoucher({
                          voucher_series: row.match_suggestion.voucher_series,
                          voucher_number: row.match_suggestion.voucher_number,
                        })
                      : t('chip_draft'),
                })}
              </Badge>
            ) : (
              /* Plain fact, not an exception: quiet text, and the band
                 header carries the count once. */
              <span className="text-[11px] text-muted-foreground">{t('chip_not_booked').toLowerCase()}</span>
            )
          )}
        </span>
      </td>
      <td
        className={cn(
          TD_CLASS,
          'whitespace-nowrap text-right tabular-nums',
          amount > 0 && 'text-success',
        )}
      >
        {amount > 0 ? `+${formatCurrency(amount)}` : formatCurrency(amount)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={row.bank_entered_at ? 'default' : 'icon'}
              disabled={bankEntering}
              className={cn(
                'text-xs text-muted-foreground',
                !row.bank_entered_at && HOVER_REVEAL_CLASS,
              )}
              aria-label={t(
                row.bank_entered_at ? 'bank_entered_actions_aria' : 'row_actions_aria',
                { text: row.transaktionstext },
              )}
            >
              {bankEntering ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : row.bank_entered_at ? (
                <>
                  <Check className="h-4 w-4" />
                  {t('bank_entered_label')}
                  <ChevronDown className="h-3.5 w-3.5" />
                </>
              ) : (
                <MoreHorizontal className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.bank_entered_at && (
              <>
                <DropdownMenuItem onSelect={() => onSetBankEntered(row, false)}>
                  {t('bank_entered_remove_action')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {isIgnoredSection ? (
              <DropdownMenuItem onSelect={() => onUnignore(row)}>
                {t('action_unignore')}
              </DropdownMenuItem>
            ) : isBooked ? (
              <DropdownMenuItem asChild>
                <Link href={`/bookkeeping/${row.journal_entry_id}`}>
                  {t('action_show_voucher')}
                </Link>
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => onIgnore(row)}>
                  {t('ignore_action')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onMatch(row)}>
                  {t('action_match')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onBokfor(row.id)}>
                  {t('action_book')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  )
}
