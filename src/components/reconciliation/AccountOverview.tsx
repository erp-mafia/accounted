'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type {
  ReconciliationAccount,
  ReconciliationItem,
  ReconciliationItemBucket,
  ReconciliationStatus,
} from '@/lib/reconciliation/schemas'
import type { BankBalanceCheck } from '@/lib/reconciliation/bank-balance-check'
import { dropProposedLedgerDuplicates } from '@/lib/reconciliation/overview-rows'
import { accountTransactionsHref } from '@/lib/reconciliation/account-links'
import type { SkattekontoBatchRowResult, SkattekontoTransactionWithSuggestion } from '@/types/skatteverket'
import { SignoffDialog, type SignoffPreviewResult, type SignoffSubmitInput } from './SignoffDialog'
import { ReconciliationUnderlag } from './ReconciliationUnderlag'
import { MatcherPreview, type MatcherMatch } from './MatcherPreview'
import { ReconciliationSummary } from './ReconciliationSummary'
import { lacksSkatteverketSaldo, sidesAgree } from './verdict'
import { PairRow, PairsHead } from './ReconciliationPairs'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { SKATTEKONTO_ACCOUNT_DEFAULT, isSkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'

const SkattekontoBookDialog = dynamic(
  () => import('@/components/skattekonto/SkattekontoBookDialog'),
  { loading: DialogLoadingSkeleton },
)

const SkattekontoLinkProposalsDialog = dynamic(
  () =>
    import('@/components/skattekonto/SkattekontoLinkProposalsDialog').then(
      (module) => module.SkattekontoLinkProposalsDialog,
    ),
  { loading: DialogLoadingSkeleton },
)

const SkattekontoMatchDialog = dynamic(
  () =>
    import('@/components/skattekonto/SkattekontoMatchDialog').then(
      (module) => module.SkattekontoMatchDialog,
    ),
  { loading: DialogLoadingSkeleton },
)

/**
 * The body of the Avstämning flow for one account: the strip of four figures
 * (outside, ledger, difference, unexplained) with the verdict sentence and
 * the bridge behind a disclosure, the actions row, and the full-width banded
 * table of paired rows behind the bridge. Everything comes from the PR 2 dashboard routes; the
 * same service functions feed the v1 API and the MCP tools, so what the page
 * shows is what an agent sees.
 */

interface ItemsPayload {
  items: ReconciliationItem[]
  count: number
  total_count: number
  has_more: boolean
  older_unmatched_count: number
}

const BUCKET_ORDER: ReconciliationItemBucket[] = [
  'proposed',
  'unmatched_external',
  'unmatched_ledger',
  'matched',
  'ignored',
  'upcoming',
  // Bank only, and only once asked for: read on demand (beforeItems).
  'before_history',
]

/** Buckets that start folded: they explain the bridge but are not work. */
const FOLDED_BY_DEFAULT: ReadonlySet<ReconciliationItemBucket> = new Set(['matched', 'ignored'])

const ITEMS_LIMIT = 200

export interface ReconciliationWindow {
  from: string
  to: string
}

interface AccountOverviewProps {
  account: ReconciliationAccount
  /** The company's other bank accounts: targets for "Flytta till konto". */
  otherBankAccounts?: ReconciliationAccount[]
  /** The selected period: scopes the bank bridge and the item windows; its end is the default sign-off date. */
  window: ReconciliationWindow
  /** Called after any write so the account table can refresh its statuses. */
  onChanged: () => void
  /** Opens the manual match view. */
  onMatchManually?: () => void
  /**
   * The workspace's slot in the top bar, beside "Senast avstämt": the
   * sign-off details and Öppna igen render there, so the date is said once.
   */
  headerSlot?: HTMLElement | null
}

export function AccountOverview({ account, otherBankAccounts = [], window, onChanged, onMatchManually, headerSlot = null }: AccountOverviewProps) {
  const t = useTranslations('reconciliation')
  const locale = useLocale()
  const { toast } = useToast()
  const [status, setStatus] = useState<ReconciliationStatus | null>(null)
  // The company's skattekonto account (1630, or 2012 for an enskild firma that
  // runs it there): what the skattekonto texts name.
  const skattekontoAccount =
    status && isSkattekontoLedgerAccount(status.account_number) ? status.account_number : SKATTEKONTO_ACCOUNT_DEFAULT
  const [items, setItems] = useState<ItemsPayload | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState<Set<ReconciliationItemBucket>>(new Set())
  const [bookRow, setBookRow] = useState<ReconciliationItem | null>(null)
  // Skattekonto: every proposal linked in one previewed action (PH 171).
  const [linkAllOpen, setLinkAllOpen] = useState(false)
  // Row the book dialog handed to the match flow (a ledger twin exists). Kept
  // as the converted row so the match dialog's fetch effect sees a stable object.
  const [matchRow, setMatchRow] = useState<SkattekontoTransactionWithSuggestion | null>(null)
  const [signoffOpen, setSignoffOpen] = useState(false)
  const [matcher, setMatcher] = useState<MatcherMatch[] | null>(null)
  const [bridgeOpen, setBridgeOpen] = useState(false)
  // Bank: the verifikat dated before the bank's history (crm#1221), listed
  // only when asked for. Null until read; a refresh reads them again.
  const [beforeOpen, setBeforeOpen] = useState(false)
  const [beforeItems, setBeforeItems] = useState<ReconciliationItem[] | null>(null)
  const searchParams = useSearchParams()
  const autorunRequested = searchParams.get('autorun') === '1'
  const autorunDone = useRef(false)

  const isSkv = account.kind === 'skattekonto'
  // Manual accounts have no rows to match or book: the body is the balance
  // bridge (IB, movement, UB against a specification or the signer's
  // underlag) and the sign-off.
  const isManual = account.kind === 'manual'
  const transactionsHref = accountTransactionsHref(account)
  const base =`/api/reconciliation/accounts/${encodeURIComponent(account.account_key)}`

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ date_from: window.from, date_to: window.to })
      const [statusRes, itemsRes] = await Promise.all([
        fetch(`${base}?${qs.toString()}`),
        fetch(`${base}/items?limit=${ITEMS_LIMIT}&${qs.toString()}`),
      ])
      setLoadError(false)
      if (!statusRes.ok || !itemsRes.ok) {
        setLoadError(true)
        return
      }
      const statusJson = await statusRes.json()
      const itemsJson = await itemsRes.json()
      setStatus(statusJson.data as ReconciliationStatus)
      setItems(itemsJson.data as ItemsPayload)
      setBeforeItems(null)
    } catch {
      setLoadError(true)
    }
  }, [base, window.from, window.to])

  // The workspace keys this component on account_key, so a new account is a
  // fresh mount: no state to reset here.
  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    await load()
    onChanged()
  }, [load, onChanged])

  useEffect(() => {
    if (!beforeOpen || beforeItems !== null) return
    let cancelled = false
    void (async () => {
      const qs = new URLSearchParams({
        date_from: window.from,
        date_to: window.to,
        bucket: 'before_history',
        limit: String(ITEMS_LIMIT),
      })
      try {
        const res = await fetch(`${base}/items?${qs.toString()}`)
        const json = res.ok ? await res.json() : null
        if (!cancelled) setBeforeItems(((json?.data?.items ?? []) as ReconciliationItem[]))
      } catch {
        if (!cancelled) setBeforeItems([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [beforeOpen, beforeItems, base, window.from, window.to])

  const byBucket = useMemo(() => {
    const map = new Map<ReconciliationItemBucket, ReconciliationItem[]>()
    for (const b of BUCKET_ORDER) map.set(b, [])
    // A verifikat its proposals fully explain shows in its pair only, not again as missing on the other side.
    for (const item of dropProposedLedgerDuplicates(items?.items ?? [])) map.get(item.bucket)?.push(item)
    if (beforeOpen && beforeItems) map.set('before_history', beforeItems)
    return map
  }, [items, beforeOpen, beforeItems])

  const proposedCount = status?.counts.proposed ?? 0
  const bookableIds = useMemo(
    () =>
      (byBucket.get('unmatched_external') ?? [])
        // A row the ledger already holds (a summarised verifikat covers it)
        // is linked, not booked: "Bokför N händelser" never counts it.
        .filter((i) => i.item_type === 'skattekonto_transaction' && i.actions.includes('book') && !i.covered_by_ledger)
        .map((i) => i.item_id),
    [byBucket],
  )

  // ---- writes -------------------------------------------------------------

  async function postJson(url: string, body: unknown, method: 'POST' | 'DELETE' = 'POST') {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast({
        title: t('toast_failed'),
        description: getUserErrorMessage(json, { statusCode: res.status }),
        variant: 'destructive',
      })
      return null
    }
    return json.data as Record<string, unknown>
  }

  async function matchProposals() {
    setBusy('proposals')
    try {
      // One click links every 1:1 proposal and same-date sum (0.95); a sum
      // found within the 7-day window (0.85) waits for its own row's Koppla.
      const data = await postJson(`${base}/links`, { use_proposals: true, set_confidence_threshold: 0.9 })
      if (data) {
        const applied = (data.applied as unknown[]).length
        const skipped = (data.skipped as unknown[]).length
        toast({
          title: skipped > 0 ? t('toast_matched_skipped', { applied, skipped }) : t('toast_matched', { applied }),
        })
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function matchOne(item: ReconciliationItem) {
    if (!item.proposal) return
    setBusy(item.item_id)
    try {
      // A set proposal (#2293) links the row to every verifikat in it (1:N,
      // all or nothing, slices revalidated server-side); a 1:1 proposal to one.
      const journalEntryIds = item.proposal.vouchers?.map((v) => v.journal_entry_id) ?? [
        item.proposal.journal_entry_id,
      ]
      const data = await postJson(`${base}/links`, {
        // A combined skattekonto proposal links every row of its group at once.
        pairs: [{ external_ids: item.proposal.external_ids ?? [item.item_id], journal_entry_ids: journalEntryIds }],
      })
      if (data) {
        const skipped = data.skipped as Array<{ message: string }>
        if (skipped.length > 0) {
          toast({ title: t('toast_failed'), description: skipped[0].message, variant: 'destructive' })
        } else {
          toast({ title: t('toast_matched', { applied: (data.applied as unknown[] | undefined)?.length ?? 1 }) })
        }
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function unmatchOne(item: ReconciliationItem) {
    setBusy(item.item_id)
    try {
      // A verifikat linked to other verifikat is undone by its settlement id;
      // a bank or skattekonto row by its own id.
      const linkId = item.settlement?.settlement_id ?? item.item_id
      const data = await postJson(`${base}/links/${linkId}`, undefined, 'DELETE')
      if (data) {
        toast({ title: t('toast_unmatched') })
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function setIgnored(item: ReconciliationItem, ignored: boolean) {
    setBusy(item.item_id)
    try {
      const data = await postJson(`${base}/items/${item.item_id}/ignore`, { ignored })
      if (data) {
        toast({ title: ignored ? t('toast_ignored') : t('toast_unignored') })
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function bookAll() {
    if (bookableIds.length === 0) return
    setBusy('book')
    try {
      const data = await postJson('/api/extensions/ext/skatteverket/skattekonto/transaktioner/bokfor-batch', {
        ids: bookableIds,
      })
      if (data) {
        const results = (data.results ?? []) as SkattekontoBatchRowResult[]
        const ok = results.filter((r) => r.ok).length
        const failed = results.length - ok
        // Rows whose event the ledger already holds were skipped, not lost:
        // say so, and that they are linked rather than booked.
        const twins = results.filter((r) => r.error_code === 'LEDGER_TWIN_EXISTS').length
        // The same for rows a summarised verifikat already covers.
        const covered = results.filter((r) => r.error_code === 'LEDGER_COVER_EXISTS').length
        // And for rows a bank verifikat already books without the
        // skattekonto (PH 171): ignored rather than linked.
        const direct = results.filter((r) => r.error_code === 'LEDGER_DIRECT_EXISTS').length
        toast({
          title: failed > 0 ? t('toast_book_partial', { ok, failed }) : t('toast_booked', { count: ok }),
          ...(covered > 0
            ? { description: t('toast_book_covered', { count: covered, skattekonto: skattekontoAccount }) }
            : twins > 0
              ? { description: t('toast_book_twins', { count: twins }) }
              : direct > 0
                ? { description: t('toast_book_direct', { count: direct }) }
                : {}),
          variant: failed > 0 && ok === 0 ? 'destructive' : undefined,
        })
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  // A policy refusal carries a code and a Swedish reason written for the
  // signer; show that reason as-is. The generic mapper does not recognise it
  // and used to replace it with a "request contains invalid data" string.
  function signoffRefusal(json: Record<string, unknown>, statusCode: number): string {
    return typeof json.code === 'string' && typeof json.error === 'string' && json.error.trim()
      ? json.error
      : getUserErrorMessage(json, { statusCode })
  }

  // The same call with dry_run: the server judges the exact sign-off (its own
  // window, from the fiscal period start to the date) and the dialog shows
  // that verdict instead of the page tile's number, which is scoped to the
  // period or range picked above and can differ.
  async function previewSignoff(input: SignoffSubmitInput): Promise<SignoffPreviewResult> {
    const res = await fetch(`${base}/signoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, dry_run: true }),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok) {
      const preview = (json.data as { would_sign?: { unexplained_difference?: number | null } } | undefined)?.would_sign
      return { kind: 'ok', unexplained: preview?.unexplained_difference ?? null }
    }
    const code = typeof json.code === 'string' ? json.code : null
    if (code === 'NOT_RECONCILED') {
      const details = json.details as { unexplained_difference?: number | null } | undefined
      return { kind: 'needs_force', unexplained: details?.unexplained_difference ?? null }
    }
    if (code === 'OUTSIDE_UNKNOWN') return { kind: 'needs_force', unexplained: null }
    return { kind: 'blocked', message: signoffRefusal(json, res.status) }
  }

  async function submitSignoff(input: SignoffSubmitInput) {
    const res = await fetch(`${base}/signoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return signoffRefusal(json, res.status)
    setSignoffOpen(false)
    toast({ title: t('toast_signed_off', { date: formatDate(input.through_date) }) })
    await refresh()
    return null
  }

  async function reopen(signoffId: string) {
    setBusy('reopen')
    try {
      const data = await postJson(`${base}/signoff/${signoffId}/reopen`, {})
      if (data) {
        toast({ title: t('toast_reopened') })
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function runMatcher() {
    if (!status) return
    setBusy('matcher')
    try {
      const data = await postJson('/api/reconciliation/bank/run', {
        date_from: window.from,
        date_to: window.to,
        account_number: status.account_number,
        dry_run: true,
      })
      if (data) setMatcher((data.matches ?? []) as MatcherMatch[])
    } finally {
      setBusy(null)
    }
  }

  async function applyMatches(pairs: MatcherMatch[], strongOnly: boolean) {
    if (!status || pairs.length === 0) return
    setBusy('matcher')
    try {
      const data = await postJson('/api/reconciliation/bank/run', {
        date_from: window.from,
        date_to: window.to,
        account_number: status.account_number,
        dry_run: false,
        selected_matches: pairs.map((m) => ({
          transaction_id: m.transaction_id,
          journal_entry_id: m.journal_entry_id,
        })),
        // Strong-only applies re-enforce the floor server-side, same as the
        // old bank view; a single hand-picked weaker pair omits it.
        ...(strongOnly ? { confidence_threshold: 0.85 } : {}),
      })
      if (data) {
        const applied = (data.applied as number) ?? 0
        toast({ title: t('toast_matched', { applied }) })
        const appliedKeys = new Set(pairs.map((m) => `${m.transaction_id}:${m.journal_entry_id}`))
        setMatcher((prev) => (prev ? prev.filter((m) => !appliedKeys.has(`${m.transaction_id}:${m.journal_entry_id}`)) : prev))
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function markOpeningBalance(item: ReconciliationItem) {
    setBusy(item.item_id)
    try {
      const data = await postJson('/api/reconciliation/bank/mark-opening-balance', { journal_entry_id: item.item_id })
      if (data !== null) {
        toast({ title: t('toast_marked_ib') })
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function moveToAccount(item: ReconciliationItem, target: ReconciliationAccount) {
    setBusy(item.item_id)
    try {
      const res = await fetch(`/api/transactions/${item.item_id}/cash-account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_number: target.account_number }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('toast_failed'), description: getUserErrorMessage(json, { statusCode: res.status }), variant: 'destructive' })
        return
      }
      toast({ title: t('toast_moved', { account: `${target.name} (${target.account_number})` }) })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  // ?autorun=1 (the old bankavstämning deep link from the transactions inbox):
  // run the matcher preview once the bridge is up, once per mount.
  useEffect(() => {
    if (!autorunRequested || autorunDone.current || isSkv || !status) return
    autorunDone.current = true
    void runMatcher()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once when the status first loads
  }, [autorunRequested, isSkv, status])

  // ---- render -------------------------------------------------------------

  if (loadError) {
    return (
      <div>
        <div className="min-w-0">
          <AttnLine action={{ label: t('older_show'), onClick: () => void load() }}>
            {t('load_failed')}
          </AttnLine>
        </div>
      </div>
    )
  }

  if (!status || !items) {
    // The silhouette of the page that follows: the strip of figures, the
    // action row and the paired rows, so nothing moves when the data lands.
    return (
      <div className="space-y-6" aria-busy>
        <div className="grid grid-cols-2 gap-6 border-b border-border pb-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-28" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 w-64 rounded-full" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="space-y-px">
          <div className="flex items-center gap-6 border-b border-border py-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-6 border-b border-border py-3.5">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="ml-auto h-3.5 w-20" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const currency = status.currency
  const money = (n: number | null | undefined) => (n == null ? t('tile_unknown') : formatCurrency(n, currency))
  const asOfDate = status.as_of.slice(0, 10)
  const fetchedAt = isSkv ? status.skattekonto?.fetched_at : account.source.synced_at
  const sourceLabel = isSkv ? t('source_skv') : t('source_bank')
  const specification = isManual ? (status.manual?.specification ?? null) : null
  const specificationLabel = specification ? (locale === 'en' ? specification.label_en : specification.label_sv) : null

  const bankRaw = status.bank as { bank_transaction_inflow?: number; bank_transaction_outflow?: number; bank_transaction_count?: number } | null
  // The bank's history (crm#1221): verifikat dated before its first day are
  // outside the comparison, which starts there. Said once, under the verdict.
  const bankHistory =
    !isSkv && !isManual
      ? (status.bank as {
          history_start?: string | null
          before_history_count?: number
          before_history_total?: number
          opening_difference?: number | null
        } | null)
      : null
  const historyStart = bankHistory?.history_start ?? null
  const beforeCount = bankHistory?.before_history_count ?? 0
  const openingDifference = beforeCount > 0 ? (bankHistory?.opening_difference ?? null) : null
  // The period ends before the bank's first row: there is no bank side to compare.
  const periodBeforeHistory = !!historyStart && window.to < historyStart
  const bankBreakdown =
    !isSkv && bankRaw && typeof bankRaw.bank_transaction_inflow === 'number' && typeof bankRaw.bank_transaction_outflow === 'number'
      ? t('tile_bank_breakdown', {
          inflow: formatCurrency(bankRaw.bank_transaction_inflow, currency),
          outflow: formatCurrency(Math.abs(bankRaw.bank_transaction_outflow), currency),
          count: bankRaw.bank_transaction_count ?? 0,
        })
      : null

  const externalTile = isManual
    ? {
        key: 'external',
        label: specificationLabel ?? t('tile_external_manual'),
        value: money(status.external_balance),
        sub: specification
          ? t('tile_spec_today')
          : status.external_balance != null && status.signoff
            ? t('tile_external_signed', { date: formatDate(status.signoff.through_date) })
            : t('tile_external_manual_sub'),
      }
    : {
        key: 'external',
        label: isSkv ? t('tile_external_skv') : t('tile_external_bank'),
        // The bank tile is the period sum (what its label says), which lives on
        // the bridge; external_balance is the reported bank balance and is often
        // unknown, which rendered as "okänt" next to a bridge that knows better.
        value: money(
          isSkv
            ? status.external_balance
            : (status.bridge.find((l) => l.key === 'bank_transactions')?.amount ?? status.external_balance),
        ),
        // Bank: the gross split makes the net self-explanatory; skattekonto: when it was fetched.
        sub: bankBreakdown ?? (fetchedAt ? t('tile_synced', { date: formatDate(fetchedAt) }) : t('rail_never_synced')),
      }

  const tiles: Array<{ key: string; label: string; value: string; sub: string; tone?: 'ok' | 'attn'; help?: string }> = [
    externalTile,
    {
      key: 'ledger',
      label: isSkv
        ? t('tile_ledger', { account: status.account_number })
        : t('tile_ledger_bank', { account: status.account_number }),
      value: money(status.ledger_balance),
      sub:
        beforeCount > 0 && historyStart
          ? t('tile_from', { date: formatDate(historyStart) })
          : t('tile_per', { date: formatDate(asOfDate) }),
    },
    { key: 'difference', label: t('tile_difference'), value: money(status.difference), sub: '' },
    {
      key: 'unexplained',
      label: t('tile_unexplained'),
      help: t('tile_unexplained_help'),
      value: money(status.unexplained_difference),
      sub: '',
      tone: status.unexplained_difference == null ? undefined : status.is_reconciled ? 'ok' : 'attn',
    },
  ]

  // What the bank itself reports (F7): booked + available balance from the
  // last PSD2 balance refresh, with its fetch date. Point-in-time, so it
  // lives outside the movement-based tiles.
  const bankReportedRaw =
    !isSkv && !isManual
      ? (status.bank as {
          bank_reported_balance?: number | null
          bank_reported_available_balance?: number | null
          bank_balance_updated_at?: string | null
        } | null)
      : null
  // Both the amount and its fetch timestamp must exist: a balance of unknown
  // age labeled with today's date is exactly the misleading staleness the
  // timestamp exists to prevent, so without it the line is omitted entirely.
  const bankReportedLine =
    bankReportedRaw &&
    typeof bankReportedRaw.bank_reported_balance === 'number' &&
    bankReportedRaw.bank_balance_updated_at
      ? typeof bankReportedRaw.bank_reported_available_balance === 'number'
        ? t('bank_reported_line_available', {
            amount: formatCurrency(bankReportedRaw.bank_reported_balance, currency),
            available: formatCurrency(bankReportedRaw.bank_reported_available_balance, currency),
            date: formatDate(bankReportedRaw.bank_balance_updated_at),
          })
        : t('bank_reported_line', {
            amount: formatCurrency(bankReportedRaw.bank_reported_balance, currency),
            date: formatDate(bankReportedRaw.bank_balance_updated_at),
          })
      : null

  // The bank's balance against the books on the bank's own day
  // (lib/reconciliation/bank-balance-check.ts). The tiles compare movements
  // in the period and cannot see an opening balance that never reached the
  // books, so this stands under the verdict instead of behind the bridge. Its
  // parts sum to the difference.
  const balanceCheck =
    !isSkv && !isManual ? ((status.bank as { balance_check?: BankBalanceCheck | null } | null)?.balance_check ?? null) : null
  const balanceDiffers = balanceCheck !== null && Math.abs(balanceCheck.difference) >= 0.005
  const balanceParts =
    balanceCheck && balanceDiffers
      ? [
          balanceCheck.unbooked.count > 0
            ? t('balance_check_part_unbooked', {
                count: balanceCheck.unbooked.count,
                amount: formatCurrency(balanceCheck.unbooked.total, currency),
              })
            : null,
          balanceCheck.before_history && Math.abs(balanceCheck.before_history.difference) >= 0.005
            ? t('balance_check_part_before', {
                date: formatDate(balanceCheck.before_history.history_start),
                amount: formatCurrency(balanceCheck.before_history.difference, currency),
              })
            : null,
          Math.abs(balanceCheck.rest) >= 0.005
            ? t('balance_check_part_rest', { amount: formatCurrency(balanceCheck.rest, currency) })
            : null,
        ].filter((part): part is string => part !== null)
      : []

  const bucketLabel = (bucket: ReconciliationItemBucket): string => {
    switch (bucket) {
      case 'proposed':
        return t('bucket_proposed')
      case 'unmatched_external':
        return isSkv ? t('bucket_unmatched_external_skv') : t('bucket_unmatched_external_bank')
      case 'unmatched_ledger':
        return isSkv ? t('bucket_unmatched_ledger_skv') : t('bucket_unmatched_ledger_bank')
      case 'matched':
        return t('bucket_matched')
      case 'ignored':
        return t('bucket_ignored')
      case 'upcoming':
        return t('bucket_upcoming')
      case 'before_history':
        return isSkv ? t('bucket_before_history') : t('bucket_before_history_bank')
    }
  }

  const openWork =
    (byBucket.get('proposed')?.length ?? 0) +
    (byBucket.get('unmatched_external')?.length ?? 0) +
    (byBucket.get('unmatched_ledger')?.length ?? 0)

  // The verdict in one sentence: what the difference holds, as the bridge's
  // own counted lines ("9 omatchade banktransaktioner"). The Differens and
  // Oförklarat tiles above carry the amounts, so the sentence never repeats
  // them; the full bridge stays behind a disclosure.
  const explained = status.bridge
    .filter((l) => !['bank_transactions', 'external_balance', 'specification', 'ledger_balance', 'opening_balance', 'movement'].includes(l.key))
    .filter((l) => l.count != null && l.count > 0)
    .map((l) => {
      const label = locale === 'en' ? l.label_en : l.label_sv
      return `${l.count} ${label.charAt(0).toLowerCase()}${label.slice(1)}`
    })
  // No bank row at all on the account (lib/reconciliation/service.ts): two
  // zeros are no agreement, so the sentence says what is missing instead of
  // "Banken och bokföringen stämmer" (PH 195). The same for a skattekonto
  // with no saldo from Skatteverket (crm#1701).
  const noBankRows = !isSkv && !isManual && (status.bank as { no_bank_rows?: boolean } | null)?.no_bank_rows === true
  const verdict = noBankRows
    ? fetchedAt
      ? t('v2_verdict_no_bank_rows_synced', { date: formatDate(fetchedAt) })
      : t('v2_verdict_no_bank_rows')
    : lacksSkatteverketSaldo(status)
      ? t('v2_verdict_no_skv_saldo')
      : sidesAgree(status)
        ? isSkv
          ? t('v2_verdict_ok_skv')
          : isManual
            ? t('v2_verdict_ok_manual')
            : balanceDiffers
              ? t('v2_verdict_ok_bank_balance_differs')
              : t('v2_verdict_ok_bank')
        : explained.length > 0
          ? t('v2_verdict_diff', { explanations: explained.join(', ') })
          : null


  // Default sign-off date: the window end, never past today nor past the
  // skattekonto snapshot. The button hides when that date is already signed.
  const todayIso = todayIsoStockholm()
  const signoffMaxDate = isSkv ? (asOfDate < todayIso ? asOfDate : todayIso) : todayIso
  const signoffDefaultDate = window.to < signoffMaxDate ? window.to : signoffMaxDate
  const signoffEnabled = !status.signoff || status.signoff.through_date < signoffDefaultDate

  return (
    <div className="space-y-6">
      <div>
        <div className="min-w-0 space-y-6">
      <div className="space-y-3">
        {/* The two sides and what separates them, on one line (Kick's
            reconciliation strip): the outside, the ledger, the difference,
            the part of it nothing explains. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-border pb-4 md:grid-cols-4">
          {tiles.map((tile) => (
            <div key={tile.key} className="min-w-0">
              <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
                <span className="truncate">{tile.label}</span>
                {tile.help && <InfoTooltip content={tile.help} iconClassName="h-3 w-3" />}
              </div>
              <div
                className={cn(
                  'mt-1 text-xl font-semibold leading-tight tabular-nums',
                  tile.tone === 'ok' && 'text-success',
                  tile.tone === 'attn' && 'text-warning',
                )}
                data-ph-mask
              >
                {tile.value}
              </div>
              {tile.sub && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{tile.sub}</div>}
            </div>
          ))}
        </div>
        <p className={cn('text-[13px]', status.is_reconciled && !balanceDiffers ? 'text-success' : 'text-muted-foreground')} data-ph-mask>
          {verdict}
          <button type="button" onClick={() => setBridgeOpen((v) => !v)} className={cn(QUIET_LINK_CLASS, verdict && 'ml-3', 'text-[12.5px]')}>
            {bridgeOpen ? t('v2_hide_bridge') : t('v2_show_bridge')}
          </button>
        </p>
        {balanceCheck && (
          <div className="space-y-1 text-[12.5px] text-muted-foreground" data-ph-mask>
            <p>
              {balanceDiffers
                ? t('balance_check_diff', {
                    bank: formatCurrency(balanceCheck.bank_balance, currency),
                    date: formatDate(balanceCheck.as_of),
                    account: status.account_number,
                    booked: formatCurrency(balanceCheck.booked_balance, currency),
                    difference: formatCurrency(balanceCheck.difference, currency),
                  })
                : t('balance_check_ok', {
                    date: formatDate(balanceCheck.as_of),
                    amount: formatCurrency(balanceCheck.bank_balance, currency),
                  })}
            </p>
            {balanceParts.length > 0 && (
              <div className="flex items-center gap-1">
                <span>{t('balance_check_parts', { parts: balanceParts.join(' · ') })}</span>
                <InfoTooltip content={t('balance_check_help', { account: status.account_number })} iconClassName="h-3 w-3" />
              </div>
            )}
          </div>
        )}
        {bridgeOpen && (
          <div className="space-y-2">
            <ReconciliationSummary status={status} kind={account.kind} specificationLabel={specificationLabel} />
            {bankReportedLine && (
              <p className="text-[12.5px] text-muted-foreground" data-ph-mask>
                {bankReportedLine}
              </p>
            )}
            {/* Where the books stood when the bank's history begins: part of
                the bridge's story, so it waits behind the bridge. */}
            {openingDifference != null && (
              <p className="text-[12.5px] text-muted-foreground" data-ph-mask>
                {Math.abs(openingDifference) < 0.005
                  ? t('before_history_opening_ok', { account: status.account_number })
                  : t('before_history_opening_diff', {
                      account: status.account_number,
                      amount: formatCurrency(Math.abs(openingDifference), currency),
                    })}
              </p>
            )}
          </div>
        )}
        {beforeCount > 0 && historyStart && (
          <p className="text-[12.5px] text-muted-foreground" data-ph-mask>
            {t('before_history_line', {
              count: beforeCount,
              date: formatDate(historyStart),
              amount: formatCurrency(bankHistory?.before_history_total ?? 0, currency),
            })}
            <button type="button" onClick={() => setBeforeOpen((v) => !v)} className={cn(QUIET_LINK_CLASS, 'ml-3')}>
              {beforeOpen ? t('hide') : t('before_history_show')}
            </button>
          </p>
        )}
        {periodBeforeHistory && historyStart && (
          <p className="text-[12.5px] text-muted-foreground">
            {t('before_history_window', { date: formatDate(historyStart) })}{' '}
            <Link href="/import?mode=bank" className={QUIET_LINK_CLASS}>
              {t('before_history_import')}
            </Link>
          </p>
        )}
      </div>

      {/* One notice at a time: stale data first, else the rows a summarised
          verifikat already covers, with the way to link them. One line: the
          why behind the "?". */}
      {status.stale ? (
        <AttnLine>{t('stale_line', { source: sourceLabel })}</AttnLine>
      ) : isSkv && status.skattekonto?.covered ? (
        <AttnLine
          action={
            proposedCount > 0
              ? { label: t('action_match_proposals', { count: proposedCount }), onClick: () => setLinkAllOpen(true) }
              : onMatchManually
                ? { label: t('mode_match'), onClick: onMatchManually }
                : undefined
          }
          trailing={
            <InfoTooltip
              variant="help"
              content={t('covered_help', { skattekonto: skattekontoAccount })}
              className="ml-1 align-middle"
              iconClassName="h-3 w-3"
            />
          }
        >
          {t('covered_line', {
            count: status.skattekonto.covered.event_count,
            date: formatDate(status.skattekonto.covered.through_date),
          })}
        </AttnLine>
      ) : null}

      {/* The sign-off rides in the top bar beside "Senast avstämt" (the
          workspace's slot), so the date is said once: whether it was signed
          with a note, when it was signed, and the way to reopen it. */}
      {headerSlot &&
        status.signoff &&
        createPortal(
          <span title={t('signed_off_line', { date: formatDate(status.signoff.through_date), when: formatDate(status.signoff.signed_at) })}>
            {status.signoff.note && <> · {t('signed_off_forced')}</>}
            {' · '}
            <button
              type="button"
              onClick={() => void reopen(status.signoff!.id)}
              disabled={busy !== null}
              className={cn(QUIET_LINK_CLASS, 'text-xs')}
            >
              {t('reopen')}
            </button>
          </span>,
          headerSlot,
        )}

      {/* Actions row: the work, then the way to the richer surfaces. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {proposedCount > 0 && (
          // Skattekonto: the proposals open as one previewed set (count, sum,
          // verifikat) with Ångra afterwards, PH 171; a bank account links
          // its proposals directly, as before. Outline: the one filled
          // button on the page is the sign-off.
          <Button
            size="sm"
            variant="outline"
            onClick={() => (isSkv ? setLinkAllOpen(true) : void matchProposals())}
            disabled={busy !== null}
          >
            {t('action_match_proposals', { count: proposedCount })}
          </Button>
        )}
        {isSkv && bookableIds.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => void bookAll()} disabled={busy !== null}>
            {t('action_book_rows', { count: bookableIds.length })}
          </Button>
        )}
        {signoffEnabled && (
          <Button size="sm" onClick={() => setSignoffOpen(true)} disabled={busy !== null}>
            {t('signoff_button', { date: formatDate(signoffDefaultDate) })}
          </Button>
        )}
        {!isSkv && !isManual && (
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => void runMatcher()} disabled={busy !== null} aria-busy={busy === 'matcher'}>
            {t('action_run_bank_matcher')}
          </button>
        )}
        {onMatchManually && (
          <button type="button" className={QUIET_LINK_CLASS} onClick={onMatchManually} disabled={busy !== null}>
            {t('mode_match')}
          </button>
        )}
        {isSkv && (
          <span className="ml-auto">
            <Link href="/skattekonto" className={QUIET_LINK_CLASS}>
              {t('action_open_skattekonto')}
            </Link>
          </span>
        )}
        {/* The account's own rows: the Konton row used to open them, and now
            opens this view, so the way there lives here (as Skattekonto and
            Huvudbok do for the other kinds). */}
        {transactionsHref && (
          <span className="ml-auto">
            <Link href={transactionsHref} className={QUIET_LINK_CLASS}>
              {t('action_open_transactions')}
            </Link>
          </span>
        )}
        {isManual && (
          <span className="ml-auto">
            <Link href={`/reports/huvudbok?account=${encodeURIComponent(status.account_number)}`} className={QUIET_LINK_CLASS}>
              {t('action_open_ledger')}
            </Link>
          </span>
        )}
      </div>

        </div>
      </div>

      {matcher !== null && !isSkv && (
        <MatcherPreview
          matches={matcher}
          currency={currency}
          busy={busy !== null}
          onApply={(pairs, strongOnly) => void applyMatches(pairs, strongOnly)}
          onClose={() => setMatcher(null)}
        />
      )}

      {/* The table: full width, banded by bucket, paired proposal rows. */}
      {isManual ? (
        <p className="max-w-[560px] text-[13px] text-muted-foreground">
          {specificationLabel ? t('manual_spec_hint', { label: specificationLabel }) : t('manual_hint')}
        </p>
      ) : items.items.length === 0 && (byBucket.get('before_history')?.length ?? 0) === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('all_clear')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <PairsHead externalLabel={isSkv ? t('v2_side_external_skv') : t('v2_side_external_bank')} />
            </thead>
            <tbody className="stagger-enter">
              {BUCKET_ORDER.map((bucket) => {
                const rows = byBucket.get(bucket) ?? []
                if (rows.length === 0) return null
                const folded = FOLDED_BY_DEFAULT.has(bucket) && !unfolded.has(bucket)
                const toggle = () =>
                  setUnfolded((prev) => {
                    const next = new Set(prev)
                    if (next.has(bucket)) next.delete(bucket)
                    else next.add(bucket)
                    return next
                  })
                return (
                  <Fragment key={bucket}>
                    <tr className="bg-muted/30">
                      <td
                        colSpan={7}
                        className="px-0 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
                      >
                        <span className="flex items-center gap-3">
                          <span>
                            {bucketLabel(bucket)}
                            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground/70" data-ph-mask>
                              {rows.length}
                            </span>
                          </span>
                          {FOLDED_BY_DEFAULT.has(bucket) && (
                            <button
                              type="button"
                              onClick={toggle}
                              className="normal-case tracking-normal text-[12.5px] font-normal text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
                            >
                              {folded ? t('show_all', { count: rows.length }) : t('hide')}
                            </button>
                          )}
                          {/* A wrong verifikat and its hand-made rättelse can be
                              linked to each other in the worksheet: offered where
                              the engine can judge it (bank accounts in SEK). */}
                          {bucket === 'unmatched_ledger' && account.kind === 'bank' && currency === 'SEK' && onMatchManually && (
                            <button
                              type="button"
                              onClick={onMatchManually}
                              disabled={busy !== null}
                              className="normal-case tracking-normal text-[12.5px] font-normal text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
                            >
                              {t('action_settle_ledger')}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {!folded &&
                      rows.map((item) => (
                        <PairRow
                          key={item.item_id}
                          item={item}
                          isSkv={isSkv}
                          sourceLabel={sourceLabel}
                          currency={currency}
                          busy={busy === item.item_id}
                          anyBusy={busy !== null}
                          onMatch={() => void matchOne(item)}
                          onUnmatch={() => void unmatchOne(item)}
                          onIgnore={() => void setIgnored(item, true)}
                          onUnignore={() => void setIgnored(item, false)}
                          onBook={() => setBookRow(item)}
                          onLinkInstead={isSkv ? onMatchManually : undefined}
                          onMarkIb={!isSkv && item.side === 'ledger' && (item.bucket === 'unmatched_ledger' || item.bucket === 'before_history') && item.ib_eligible ? () => void markOpeningBalance(item) : undefined}
                          moveTargets={!isSkv && item.item_type === 'transaction' && item.bucket === 'unmatched_external' ? otherBankAccounts : []}
                          onMove={(target) => void moveToAccount(item, target)}
                        />
                      ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {items.has_more && (
            <p className="px-4 pt-3 text-[12.5px] text-muted-foreground">{t('truncated', { count: ITEMS_LIMIT })}</p>
          )}
        </div>
      )}

      {openWork === 0 && items.items.length > 0 && (
        <p className="text-[13px] text-muted-foreground">{t('all_clear')}</p>
      )}

      <div className="space-y-2 border-t border-border pt-4">
        {items.older_unmatched_count > 0 && (
          <p className="text-[12.5px] text-muted-foreground">
            {t('older_unmatched', { count: items.older_unmatched_count })}
            {isSkv && (
              <>
                {' · '}
                <Link href="/skattekonto" className={QUIET_LINK_CLASS}>
                  {t('older_show')}
                </Link>
              </>
            )}
          </p>
        )}
        <ReconciliationUnderlag
          accountKey={account.account_key}
          throughDate={status.signoff && status.signoff.through_date >= signoffDefaultDate ? status.signoff.through_date : signoffDefaultDate}
        />
      </div>

      {isSkv && (
        <SkattekontoBookDialog
          row={bookRow ? toDialogRow(bookRow) : null}
          skattekontoAccount={skattekontoAccount}
          open={bookRow !== null}
          onOpenChange={(open) => {
            if (!open) setBookRow(null)
          }}
          onBooked={() => {
            setBookRow(null)
            void refresh()
          }}
          onMatch={() => {
            if (bookRow) setMatchRow(toDialogRow(bookRow))
            setBookRow(null)
          }}
          onLinkCovered={onMatchManually}
          onLinked={() => void refresh()}
        />
      )}

      {linkAllOpen && (
        <SkattekontoLinkProposalsDialog
          open
          onOpenChange={(o) => {
            if (!o) setLinkAllOpen(false)
          }}
          onLinked={() => void refresh()}
          onManual={onMatchManually}
          skattekontoAccount={skattekontoAccount}
        />
      )}

      {isSkv && (
        <SkattekontoMatchDialog
          row={matchRow}
          open={matchRow !== null}
          onClose={() => setMatchRow(null)}
          onMatched={() => void refresh()}
          skattekontoAccount={skattekontoAccount}
        />
      )}

      <SignoffDialog
        open={signoffOpen}
        onOpenChange={setSignoffOpen}
        accountName={account.name}
        defaultDate={signoffDefaultDate}
        maxDate={signoffMaxDate}
        unexplained={status.unexplained_difference}
        currency={currency}
        askExternalBalance={isManual && !specification}
        ledgerBalance={status.ledger_balance}
        onPreview={previewSignoff}
        onSubmit={submitSignoff}
      />
    </div>
  )
}

/**
 * The booking dialog reads six fields of a skattekonto row (id, date, text,
 * amount, booking_suggestion, booking_gate). The reconciliation item carries
 * the first four; the suggestion is left undefined on purpose, which routes
 * the dialog to its draft-confirm path (the /skattekonto page is the place
 * with full rule-based suggestions).
 */
function toDialogRow(item: ReconciliationItem): SkattekontoTransactionWithSuggestion {
  return {
    id: item.item_id,
    transaktionsdatum: item.date,
    transaktionstext: item.description,
    belopp_skatteverket: item.amount,
    booking_suggestion: undefined,
    booking_gate: null,
  } as unknown as SkattekontoTransactionWithSuggestion
}
