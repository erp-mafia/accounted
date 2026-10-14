'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { proposalPairsOf, type ProposalPairsSummary } from '@/lib/reconciliation/proposal-pairs'
import type { ReconciliationItem } from '@/lib/reconciliation/schemas'
import { formatCurrency, formatDate } from '@/lib/utils'

const BASE = '/api/reconciliation/accounts/skattekonto'
/** Where rows no proposal covers are linked by hand. */
const MANUAL_MATCH_HREF = '/reconciliation?account=skattekonto&mode=match'
/** The items route's page size (MAX_ITEMS_LIMIT). */
const PAGE = 200
/** Pairs per link request: each pair is its own all-or-nothing write. */
const PAIRS_PER_REQUEST = 25
const SHOWN_VOUCHERS = 6

/** Every skattekonto proposal, paged through the items route. */
async function loadProposedItems(): Promise<ReconciliationItem[]> {
  const items: ReconciliationItem[] = []
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${BASE}/items?bucket=proposed&limit=${PAGE}&offset=${offset}`)
    if (!res.ok) throw new Error(String(res.status))
    const json = (await res.json()) as { data?: { items?: ReconciliationItem[]; has_more?: boolean } }
    items.push(...(json.data?.items ?? []))
    if (!json.data?.has_more) return items
  }
}

/**
 * "Koppla N händelser": every skattekonto row a verifikat already holds,
 * linked in one action (PH 171). Opens on the exact set it will link, as
 * count, sum and the verifikat, and sends exactly that set as explicit pairs
 * through the same link route as a single Koppla (matchPairs), so no
 * verifikat is created or changed and a period lock does not matter. The
 * toast's Ångra unlinks what this action linked; each link also stays
 * undoable per row under Avstämning.
 */
export function SkattekontoLinkProposalsDialog({
  open,
  onOpenChange,
  onLinked,
  focusRowId,
  onManual,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after links were made or undone, so the caller reloads its rows. */
  onLinked?: () => void
  /** The row the person came from: said so when no proposal holds it. */
  focusRowId?: string | null
  /** Opens the manual match view; omitted, the dialog navigates there. */
  onManual?: () => void
}) {
  const t = useTranslations('skv_link_proposals')
  const { toast } = useToast()
  const router = useRouter()
  const [summary, setSummary] = useState<ProposalPairsSummary | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSummary(null)
    setLoadFailed(false)
    void (async () => {
      try {
        const items = await loadProposedItems()
        if (!cancelled) setSummary(proposalPairsOf(items))
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  async function undo(ids: string[]) {
    let failed = 0
    for (const id of ids) {
      const res = await fetch(`${BASE}/links/${id}`, { method: 'DELETE' }).catch(() => null)
      if (!res?.ok) failed++
    }
    toast(
      failed === 0
        ? { title: t('undone_title') }
        : { title: t('undone_title'), description: t('undo_partial', { failed }), variant: 'destructive' },
    )
    onLinked?.()
  }

  async function linkAll() {
    if (!summary || summary.pairs.length === 0) return
    setLinking(true)
    const applied: string[] = []
    const entries = new Set<string>()
    // Why the first pair that did not link was refused (a row linked or
    // booked meanwhile), or why a request failed.
    let reason: string | null = null
    try {
      for (let i = 0; i < summary.pairs.length; i += PAIRS_PER_REQUEST) {
        const pairs = summary.pairs.slice(i, i + PAIRS_PER_REQUEST).map((p) => ({
          external_ids: p.external_ids,
          journal_entry_ids: [p.journal_entry_id],
        }))
        const res = await fetch(`${BASE}/links`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairs }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          reason = getErrorMessage(json, { statusCode: res.status })
          break
        }
        const data = json.data as {
          applied?: Array<{ external_id: string; journal_entry_id: string }>
          skipped?: Array<{ message: string }>
        }
        for (const a of data.applied ?? []) {
          applied.push(a.external_id)
          entries.add(a.journal_entry_id)
        }
        reason ??= data.skipped?.[0]?.message ?? null
      }
    } catch (err) {
      reason = getErrorMessage(err)
    } finally {
      setLinking(false)
    }

    const notLinked = summary.row_count - applied.length
    toast({
      title: applied.length > 0 ? t('done_title', { count: applied.length }) : t('link_failed'),
      description:
        notLinked > 0
          ? reason
            ? t('partial_description', { failed: notLinked, reason })
            : t('partial_description_plain', { failed: notLinked })
          : t('done_description', { vouchers: entries.size }),
      variant: applied.length === 0 ? 'destructive' : undefined,
      action:
        applied.length > 0 ? (
          <ToastAction altText={t('undo')} onClick={() => void undo(applied)}>
            {t('undo')}
          </ToastAction>
        ) : undefined,
    })
    onOpenChange(false)
    if (applied.length > 0) onLinked?.()
  }

  function openManual() {
    onOpenChange(false)
    if (onManual) onManual()
    else router.push(MANUAL_MATCH_HREF)
  }

  const empty = summary !== null && summary.pairs.length === 0
  const focusOutside =
    !!focusRowId && summary !== null && !summary.pairs.some((p) => p.external_ids.includes(focusRowId))

  return (
    <Dialog open={open} onOpenChange={(next) => !linking && onOpenChange(next)}>
      <DialogContent className="sm:min-w-[460px] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle data-ph-mask="" className="font-display text-lg tracking-tight">
            {summary && !empty ? t('title', { count: summary.row_count }) : t('empty_title')}
          </DialogTitle>
          {summary && !empty && (
            <DialogDescription data-ph-mask="" className="text-[13px] leading-relaxed">
              {t('body', {
                count: summary.row_count,
                total: formatCurrency(summary.total),
                vouchers: summary.entry_count,
              })}
            </DialogDescription>
          )}
          {empty && (
            <DialogDescription className="text-[13px] leading-relaxed">{t('empty_body')}</DialogDescription>
          )}
        </DialogHeader>

        {loadFailed ? (
          <p className="text-[13px] text-destructive">{t('load_failed')}</p>
        ) : summary === null ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-3/4 rounded-sm" />
            <Skeleton className="h-4 w-2/3 rounded-sm" />
            <Skeleton className="h-4 w-1/2 rounded-sm" />
          </div>
        ) : !empty ? (
          <div className="space-y-3 text-[13px]">
            <ul className="divide-y divide-border rounded-lg border border-border">
              {summary.pairs.slice(0, SHOWN_VOUCHERS).map((p) => (
                <li
                  key={`${p.journal_entry_id}:${p.external_ids[0]}`}
                  className="flex items-baseline justify-between gap-4 px-3 py-2"
                >
                  <span className="shrink-0 font-medium tabular-nums">
                    {p.voucher_number != null ? formatVoucher(p) : formatDate(p.entry_date)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" data-ph-mask>
                    {p.description}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {t('voucher_rows', { count: p.external_ids.length })}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground" data-ph-mask>
                    {formatCurrency(p.total)}
                  </span>
                </li>
              ))}
            </ul>
            {summary.pairs.length > SHOWN_VOUCHERS && (
              <p className="text-[12.5px] text-muted-foreground">
                {t('more_pairs', { count: summary.pairs.length - SHOWN_VOUCHERS })}
              </p>
            )}
            {focusOutside && (
              <p className="text-[12.5px] leading-5 text-muted-foreground">
                {t('focus_outside')}{' '}
                <button type="button" onClick={openManual} className={QUIET_LINK_CLASS}>
                  {t('manual_cta')}
                </button>
              </p>
            )}
            <p className="text-[12.5px] leading-5 text-muted-foreground">{t('undo_hint')}</p>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={linking}>
            {t('cancel')}
          </Button>
          {empty || loadFailed ? (
            <Button variant="outline" onClick={openManual}>
              {t('manual_cta')}
            </Button>
          ) : (
            <Button onClick={() => void linkAll()} loading={linking} disabled={summary === null}>
              {t('confirm', { count: summary?.row_count ?? 0 })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
