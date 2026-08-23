'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
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
import { SignoffDialog } from './SignoffDialog'

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
  /** The selected period: scopes the bank bridge and the item windows; its end is the default sign-off date. */
  window: ReconciliationWindow
  /** Called after any write so the rail can refresh its status dots. */
  onChanged: () => void
}

export function AccountOverview({ account, window, onChanged }: AccountOverviewProps) {
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

  const isSkv = account.kind === 'skattekonto'
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

  async function submitSignoff(input: { through_date: string; note: string | null; force: boolean }) {
    const res = await fetch(`${base}/signoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return getUserErrorMessage(json, { statusCode: res.status })
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

  // ---- render -------------------------------------------------------------

  if (loadError) {
    return (
      <AttnLine action={{ label: t('older_show'), onClick: () => void load() }}>
        {t('load_failed')}
      </AttnLine>
    )
  }

  if (!status || !items) {
    return (
      <div className="space-y-6" aria-busy>
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
    )
  }

  const currency = status.currency
  const money = (n: number | null | undefined) => (n == null ? t('tile_unknown') : formatCurrency(n, currency))
  const asOfDate = status.as_of.slice(0, 10)
  const fetchedAt = isSkv ? status.skattekonto?.fetched_at : account.source.synced_at
  const sourceLabel = isSkv ? t('source_skv') : t('source_bank')

  const tiles: Array<{ key: string; label: string; value: string; sub: string; tone?: 'ok' | 'attn' }> = [
    {
      key: 'external',
      label: isSkv ? t('tile_external_skv') : t('tile_external_bank'),
      value: money(status.external_balance),
      sub: fetchedAt ? t('tile_synced', { date: formatDate(fetchedAt) }) : t('rail_never_synced'),
    },
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
      value: money(status.unexplained_difference),
      sub: '',
      tone: status.unexplained_difference == null ? undefined : status.is_reconciled ? 'ok' : 'attn',
    },
  ]

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

  const bankRunHref = '/reports/bank-reconciliation?autorun=1'
  const bankViewHref = '/reports/bank-reconciliation'

  // Default sign-off date: the window end, never past today nor past the
  // skattekonto snapshot. The button hides when that date is already signed.
  const todayIso = new Date().toISOString().slice(0, 10)
  const signoffMaxDate = isSkv ? (asOfDate < todayIso ? asOfDate : todayIso) : todayIso
  const signoffDefaultDate = window.to < signoffMaxDate ? window.to : signoffMaxDate
  const signoffEnabled = !status.signoff || status.signoff.through_date < signoffDefaultDate

  return (
    <div className="space-y-6">
      {/* Tiles: label + number, nothing else. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border stagger-enter">
        {tiles.map((tile) => (
          <div key={tile.key} className="bg-background px-4 py-3.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">{tile.label}</div>
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
        {!isSkv && (
          <Button size="sm" variant="outline" asChild>
            <Link href={bankRunHref}>{t('action_run_bank_matcher')}</Link>
          </Button>
        )}
        {signoffEnabled && (
          <Button size="sm" variant={status.is_reconciled ? 'default' : 'outline'} onClick={() => setSignoffOpen(true)} disabled={busy !== null}>
            {t('signoff_button', { date: formatDate(signoffDefaultDate) })}
          </Button>
        )}
        <span className="ml-auto">
          <Link href={isSkv ? '/skattekonto' : bankViewHref} className={QUIET_LINK_CLASS}>
            {isSkv ? t('action_open_skattekonto') : t('action_open_bank_view')}
          </Link>
        </span>
      </div>

      {items.older_unmatched_count > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {t('older_unmatched', { count: items.older_unmatched_count })}
          {' · '}
          <Link href={isSkv ? '/skattekonto' : bankViewHref} className={QUIET_LINK_CLASS}>
            {t('older_show')}
          </Link>
        </p>
      )}

      {/* The table: full width, banded by bucket, paired proposal rows. */}
      {items.items.length === 0 ? (
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
