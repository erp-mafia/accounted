'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type {
  ReconciliationAccount,
  ReconciliationItem,
  ReconciliationItemBucket,
  ReconciliationStatus,
} from '@/lib/reconciliation/schemas'
import type { SkattekontoBatchRowResult, SkattekontoTransactionWithSuggestion } from '@/types/skatteverket'
import { SignoffDialog, type SignoffPreviewResult, type SignoffSubmitInput } from './SignoffDialog'
import { ReconciliationUnderlag } from './ReconciliationUnderlag'
import { MatcherPreview, type MatcherMatch } from './MatcherPreview'
import { InfoTooltip } from '@/components/ui/info-tooltip'

const SkattekontoBookDialog = dynamic(
  () => import('@/components/skattekonto/SkattekontoBookDialog'),
  { loading: DialogLoadingSkeleton },
)

/**
 * The body of the Avstämning page for one selected account: the four tiles
 * (outside, ledger, difference, unexplained), the bridge that explains the
 * difference, the actions row, and the full-width banded table of the rows
 * behind the bridge. Everything comes from the PR 2 dashboard routes; the
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
  /** The other bank accounts in the rail: targets for "Flytta till konto". */
  otherBankAccounts?: ReconciliationAccount[]
  /** The account rail. Rendered inside the summary grid so the items table below can span the full page width (the approved layout). */
  rail: ReactNode
  /** The selected period: scopes the bank bridge and the item windows; its end is the default sign-off date. */
  window: ReconciliationWindow
  /** Called after any write so the rail can refresh its status dots. */
  onChanged: () => void
}

export function AccountOverview({ account, rail, otherBankAccounts = [], window, onChanged }: AccountOverviewProps) {
  const t = useTranslations('reconciliation')
  const locale = useLocale()
  const { toast } = useToast()
  const [status, setStatus] = useState<ReconciliationStatus | null>(null)
  const [items, setItems] = useState<ItemsPayload | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState<Set<ReconciliationItemBucket>>(new Set())
  const [bookRow, setBookRow] = useState<ReconciliationItem | null>(null)
  const [signoffOpen, setSignoffOpen] = useState(false)
  const [matcher, setMatcher] = useState<MatcherMatch[] | null>(null)
  const searchParams = useSearchParams()
  const autorunRequested = searchParams.get('autorun') === '1'
  const autorunDone = useRef(false)

  const isSkv = account.kind === 'skattekonto'
  // Manual accounts have no rows to match or book: the body is the balance
  // bridge (IB, movement, UB against a specification or the signer's
  // underlag) and the sign-off.
  const isManual = account.kind === 'manual'
  const base = `/api/reconciliation/accounts/${encodeURIComponent(account.account_key)}`

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

  const byBucket = useMemo(() => {
    const map = new Map<ReconciliationItemBucket, ReconciliationItem[]>()
    for (const b of BUCKET_ORDER) map.set(b, [])
    for (const item of items?.items ?? []) map.get(item.bucket)?.push(item)
    return map
  }, [items])

  const proposedCount = status?.counts.proposed ?? 0
  const bookableIds = useMemo(
    () =>
      (byBucket.get('unmatched_external') ?? [])
        .filter((i) => i.item_type === 'skattekonto_transaction' && i.actions.includes('book'))
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
      const data = await postJson(`${base}/links`, { use_proposals: true })
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
      const data = await postJson(`${base}/links`, {
        pairs: [{ external_ids: [item.item_id], journal_entry_ids: [item.proposal.journal_entry_id] }],
      })
      if (data) {
        const skipped = data.skipped as Array<{ message: string }>
        if (skipped.length > 0) {
          toast({ title: t('toast_failed'), description: skipped[0].message, variant: 'destructive' })
        } else {
          toast({ title: t('toast_matched', { applied: 1 }) })
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
      const data = await postJson(`${base}/links/${item.item_id}`, undefined, 'DELETE')
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
        toast({
          title: failed > 0 ? t('toast_book_partial', { ok, failed }) : t('toast_booked', { count: ok }),
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
      <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
        {rail}
        <div className="min-w-0">
          <AttnLine action={{ label: t('older_show'), onClick: () => void load() }}>
            {t('load_failed')}
          </AttnLine>
        </div>
      </div>
    )
  }

  if (!status || !items) {
    return (
      <div className="grid gap-8 lg:grid-cols-[220px_1fr]" aria-busy>
        {rail}
        <div className="min-w-0 space-y-6">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-background p-4">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-3 h-6 w-28" />
            </div>
          ))}
        </div>
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-40 w-full" />
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
      sub: t('tile_per', { date: formatDate(asOfDate) }),
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

  const unexplained = status.unexplained_difference
  const attn = status.stale
    ? t('stale_line', { source: sourceLabel })
    : unexplained != null && Math.abs(unexplained) >= 0.005
      ? t('unexplained_line', { amount: formatCurrency(unexplained, currency) })
      : null

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
    }
  }

  const openWork =
    (byBucket.get('proposed')?.length ?? 0) +
    (byBucket.get('unmatched_external')?.length ?? 0) +
    (byBucket.get('unmatched_ledger')?.length ?? 0)


  // Default sign-off date: the window end, never past today nor past the
  // skattekonto snapshot. The button hides when that date is already signed.
  const todayIso = new Date().toISOString().slice(0, 10)
  const signoffMaxDate = isSkv ? (asOfDate < todayIso ? asOfDate : todayIso) : todayIso
  const signoffDefaultDate = window.to < signoffMaxDate ? window.to : signoffMaxDate
  const signoffEnabled = !status.signoff || status.signoff.through_date < signoffDefaultDate

  return (
    <div className="space-y-6">
      <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
        {rail}
        <div className="min-w-0 space-y-6">
      {/* Tiles: label + number, nothing else. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border stagger-enter">
        {tiles.map((tile) => (
          <div key={tile.key} className="bg-background px-4 py-3.5">
            <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              {tile.label}
              {tile.help && <InfoTooltip content={tile.help} iconClassName="h-3 w-3" />}
            </div>
            <div
              className={cn(
                'mt-1 text-[22px] font-semibold leading-tight tabular-nums',
                tile.tone === 'ok' && 'text-success',
                tile.tone === 'attn' && 'text-warning',
              )}
              data-ph-mask
            >
              {tile.value}
            </div>
            {tile.sub && <div className="mt-0.5 text-[11.5px] text-muted-foreground">{tile.sub}</div>}
          </div>
        ))}
      </div>

      {bankReportedLine && (
        <p className="text-[12.5px] text-muted-foreground" data-ph-mask>
          {bankReportedLine}
        </p>
      )}

      {attn ? (
        <AttnLine>{attn}</AttnLine>
      ) : status.is_reconciled ? (
        <p className="text-[13px] text-muted-foreground">{t('reconciled_line')}</p>
      ) : null}

      {status.signoff && (
        <p className="group flex items-center gap-2 text-[13px] text-muted-foreground">
          <span>
            {t('signed_off_line', { date: formatDate(status.signoff.through_date), when: formatDate(status.signoff.signed_at) })}
            {status.signoff.note && <span className="ml-1">· {t('signed_off_forced')}</span>}
          </span>
          <button
            type="button"
            onClick={() => void reopen(status.signoff!.id)}
            disabled={busy !== null}
            className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
          >
            {t('reopen')}
          </button>
        </p>
      )}

      {/* Bridge: how the difference is explained. */}
      {status.bridge.length > 0 && (
        <dl className="max-w-[520px] text-[13px]">
          {status.bridge.map((line) => (
            <div
              key={line.key}
              className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 last:border-b-0"
            >
              <dt className="text-muted-foreground">
                {locale === 'en' ? line.label_en : line.label_sv}
                {line.count != null && line.count > 0 && (
                  <span className="ml-1.5 tabular-nums text-muted-foreground/70" data-ph-mask>
                    ({line.count})
                  </span>
                )}
              </dt>
              <dd className="tabular-nums" data-ph-mask>
                {formatCurrency(line.amount, currency)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Actions row: the work, then the way to the richer surfaces. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {proposedCount > 0 && (
          <Button size="sm" onClick={() => void matchProposals()} disabled={busy !== null}>
            {t('action_match_proposals', { count: proposedCount })}
          </Button>
        )}
        {isSkv && bookableIds.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => void bookAll()} disabled={busy !== null}>
            {t('action_book_rows', { count: bookableIds.length })}
          </Button>
        )}
        {!isSkv && !isManual && (
          <Button size="sm" variant="outline" onClick={() => void runMatcher()} disabled={busy !== null} aria-busy={busy === 'matcher'}>
            {t('action_run_bank_matcher')}
          </Button>
        )}
        {signoffEnabled && (
          <Button size="sm" variant={status.is_reconciled ? 'default' : 'outline'} onClick={() => setSignoffOpen(true)} disabled={busy !== null}>
            {t('signoff_button', { date: formatDate(signoffDefaultDate) })}
          </Button>
        )}
        {isSkv && (
          <span className="ml-auto">
            <Link href="/skattekonto" className={QUIET_LINK_CLASS}>
              {t('action_open_skattekonto')}
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

      {/* Underlag for the balansdag in play: the signed date, else the date the next sign-off would cover. */}
      <ReconciliationUnderlag
        accountKey={account.account_key}
        throughDate={status.signoff && status.signoff.through_date >= signoffDefaultDate ? status.signoff.through_date : signoffDefaultDate}
      />

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
      ) : items.items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('all_clear')}</p>
      ) : (
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-[110px]')}>{t('col_date')}</th>
                <th className={TH_CLASS}>{t('col_event')}</th>
                <th className={cn(TH_CLASS, 'w-[140px] text-right')}>{t('col_amount')}</th>
                <th className={cn(TH_CLASS, 'w-[34%]')}>{t('col_voucher')}</th>
                <th className={cn(TH_CLASS, 'w-[170px]')} />
              </tr>
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
                        colSpan={5}
                        className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
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
                              className="normal-case tracking-normal text-[12px] font-normal text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
                            >
                              {folded ? t('show_all', { count: rows.length }) : t('hide')}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {!folded &&
                      rows.map((item) => (
                        <ItemRow
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
                          onMarkIb={!isSkv && item.side === 'ledger' && item.bucket === 'unmatched_ledger' ? () => void markOpeningBalance(item) : undefined}
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
            <p className="px-4 pt-3 text-[12px] text-muted-foreground">{t('truncated', { count: ITEMS_LIMIT })}</p>
          )}
        </div>
      )}

      {openWork === 0 && items.items.length > 0 && (
        <p className="text-[13px] text-muted-foreground">{t('all_clear')}</p>
      )}

      {isSkv && (
        <SkattekontoBookDialog
          row={bookRow ? toDialogRow(bookRow) : null}
          open={bookRow !== null}
          onOpenChange={(open) => {
            if (!open) setBookRow(null)
          }}
          onBooked={() => {
            setBookRow(null)
            void refresh()
          }}
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

interface ItemRowProps {
  item: ReconciliationItem
  isSkv: boolean
  sourceLabel: string
  currency: string
  busy: boolean
  anyBusy: boolean
  onMatch: () => void
  onUnmatch: () => void
  onIgnore: () => void
  onUnignore: () => void
  onBook: () => void
  /** "Märk som IB" for a ledger row without a bank counterpart (bank accounts). */
  onMarkIb?: () => void
  /** Other bank accounts a stray transaction can be moved to. */
  moveTargets: ReconciliationAccount[]
  onMove: (target: ReconciliationAccount) => void
}

function ItemRow({
  item,
  isSkv,
  sourceLabel,
  currency,
  busy,
  anyBusy,
  onMatch,
  onUnmatch,
  onIgnore,
  onUnignore,
  onBook,
  onMarkIb,
  moveTargets,
  onMove,
}: ItemRowProps) {
  const t = useTranslations('reconciliation')
  const can = (a: ReconciliationItem['actions'][number]) => item.actions.includes(a)
  const voucherOf = (e: { voucher_series?: string | null; voucher_number?: number | null }) =>
    e.voucher_number != null ? formatVoucher({ voucher_series: e.voucher_series, voucher_number: e.voucher_number }) : null

  // The voucher column: for a ledger item, its own voucher; for an external
  // item, the linked or proposed verifikat.
  let voucherCell: React.ReactNode = null
  if (item.side === 'ledger') {
    const v = voucherOf(item)
    voucherCell = (
      <span className="flex items-center gap-2">
        <Link href={`/bookkeeping/${item.item_id}`} className={QUIET_LINK_CLASS} data-ph-mask>
          {v ?? item.item_id.slice(0, 8)}
        </Link>
        {item.entry_status === 'draft' && <Chip>{t('chip_draft')}</Chip>}
        {item.entry_status === 'reversed' && <Chip>{t('chip_reversed')}</Chip>}
        {item.awaiting_external && <Chip>{t('chip_awaiting', { source: sourceLabel })}</Chip>}
      </span>
    )
  } else if (item.proposal) {
    const p = item.proposal
    voucherCell = (
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <Link href={`/bookkeeping/${p.journal_entry_id}`} className={QUIET_LINK_CLASS} data-ph-mask>
            {voucherOf(p) ?? p.journal_entry_id.slice(0, 8)}
          </Link>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{formatDate(p.entry_date)}</span>
          <span className="text-[11px] text-muted-foreground">
            {t('confidence', { percent: Math.round(p.confidence * 100) })}
          </span>
        </span>
        <span className="truncate text-[12px] text-muted-foreground" data-ph-mask>
          {p.description}
        </span>
      </span>
    )
  } else if (item.linked_journal_entry_id) {
    voucherCell = (
      <span className="flex items-center gap-2">
        <Link href={`/bookkeeping/${item.linked_journal_entry_id}`} className={QUIET_LINK_CLASS} data-ph-mask>
          {item.linked_journal_entry_id.slice(0, 8)}
        </Link>
        {item.link_problem === 'entry_draft' && <Chip>{t('chip_draft')}</Chip>}
        {item.link_problem === 'entry_reversed' && <Chip>{t('chip_reversed')}</Chip>}
        {item.link_problem === 'entry_missing' && <Chip>{t('chip_missing')}</Chip>}
      </span>
    )
  }

  const openHref = item.item_type === 'transaction' ? `/transactions?highlight=${item.item_id}` : null

  return (
    <tr className="group">
      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>{formatDate(item.date)}</td>
      <td className={cn(TD_CLASS, 'max-w-0')}>
        <span className="block truncate" data-ph-mask title={item.description}>
          {item.description}
        </span>
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
        {formatCurrency(item.amount, currency)}
      </td>
      <td className={cn(TD_CLASS, 'max-w-0')}>{voucherCell}</td>
      <td className={cn(TD_CLASS, 'text-right')}>
        <span className="flex items-center justify-end gap-1.5">
          {can('match') && item.proposal && (
            <Button size="sm" variant="outline" onClick={onMatch} disabled={anyBusy} aria-busy={busy}>
              {t('row_match')}
            </Button>
          )}
          {can('book') && isSkv && (
            <Button size="sm" variant="outline" onClick={onBook} disabled={anyBusy}>
              {t('row_book')}
            </Button>
          )}
          {can('book') && !isSkv && openHref && (
            <Button size="sm" variant="outline" asChild>
              <Link href={openHref}>{t('row_open')}</Link>
            </Button>
          )}
          {can('review') && item.side === 'ledger' && (
            <Link href={`/bookkeeping/${item.item_id}`} className={QUIET_LINK_CLASS}>
              {t('row_review')}
            </Link>
          )}
          {can('unmatch') && (
            <button
              type="button"
              onClick={onUnmatch}
              disabled={anyBusy}
              className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
            >
              {t('row_unmatch')}
            </button>
          )}
          {can('ignore') && (
            <button
              type="button"
              onClick={onIgnore}
              disabled={anyBusy}
              className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
            >
              {t('row_ignore')}
            </button>
          )}
          {can('unignore') && (
            <button type="button" onClick={onUnignore} disabled={anyBusy} className={QUIET_LINK_CLASS}>
              {t('row_unignore')}
            </button>
          )}
          {onMarkIb && (
            <button type="button" onClick={onMarkIb} disabled={anyBusy} className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}>
              {t('row_mark_ib')}
            </button>
          )}
          {moveTargets.length > 0 && (
            <select
              aria-label={t('row_move')}
              value=""
              disabled={anyBusy}
              onChange={(e) => {
                const target = moveTargets.find((a) => a.account_key === e.target.value)
                if (target) onMove(target)
              }}
              className={cn('h-7 rounded-full border border-border bg-background px-2 text-[11.5px] text-muted-foreground', HOVER_REVEAL_CLASS)}
            >
              <option value="">{t('row_move')}</option>
              {moveTargets.map((a) => (
                <option key={a.account_key} value={a.account_key}>
                  {a.name} ({a.account_number})
                </option>
              ))}
            </select>
          )}
        </span>
      </td>
    </tr>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-full bg-muted px-1.5 py-px text-[10.5px] text-muted-foreground">
      {children}
    </span>
  )
}
