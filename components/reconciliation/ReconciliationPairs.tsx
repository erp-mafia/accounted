'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { ReconciliationAccount, ReconciliationItem } from '@/lib/reconciliation/schemas'

/**
 * Shell v2 rows of the reconciliation flow (concept reconflow, the pairs):
 * the outside on the left, the ledger on the right, and between them the
 * sign that says whether they agree. A row with nothing on one side is the
 * work: a bank row with no verifikat, or a verifikat with no bank row. One
 * button carries the row's main action; the rest sit behind a menu.
 */

export interface PairRowProps {
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

const NUM = 'whitespace-nowrap text-right tabular-nums'
const DATE = 'whitespace-nowrap tabular-nums text-muted-foreground'

export function PairsHead({ externalLabel }: { externalLabel: string }) {
  const t = useTranslations('reconciliation')
  return (
    <tr>
      <th className={cn(TH_CLASS, '!pl-0 w-[96px]')}>{t('col_date')}</th>
      <th className={cn(TH_CLASS, 'w-[30%]')}>{externalLabel}</th>
      <th className={cn(TH_CLASS, 'w-[120px] text-right')}>{t('col_amount')}</th>
      <th className={cn(TH_CLASS, 'w-8 text-center')} aria-hidden="true"></th>
      <th className={cn(TH_CLASS, 'w-[96px]')}>{t('col_date')}</th>
      <th className={TH_CLASS}>{t('v2_side_ledger')}</th>
      <th className={cn(TH_CLASS, 'w-[120px] text-right')}>{t('col_amount')}</th>
      <th className={cn(TH_CLASS, '!pr-0 w-[150px]')} aria-hidden="true"></th>
    </tr>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">
      {children}
    </span>
  )
}

export function PairRow({
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
}: PairRowProps) {
  const t = useTranslations('reconciliation')
  const can = (a: ReconciliationItem['actions'][number]) => item.actions.includes(a)
  const voucherOf = (e: { voucher_series?: string | null; voucher_number?: number | null }) =>
    e.voucher_number != null ? formatVoucher({ voucher_series: e.voucher_series, voucher_number: e.voucher_number }) : null
  const money = (n: number) => formatCurrency(n, currency)
  const external = item.side === 'external'

  // ---- the ledger side -----------------------------------------------------
  let ledgerDate: string | null = null
  let ledgerText: React.ReactNode = null
  let ledgerAmount: number | null = null
  if (!external) {
    ledgerDate = item.date
    ledgerAmount = item.amount
    ledgerText = (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate" data-ph-mask title={item.description}>
          {item.description}
        </span>
        <Link href={`/bookkeeping/${item.item_id}`} className={cn(QUIET_LINK_CLASS, 'shrink-0')} data-ph-mask>
          {voucherOf(item) ?? item.item_id.slice(0, 8)}
        </Link>
        {item.entry_status === 'draft' && <Chip>{t('chip_draft')}</Chip>}
        {item.entry_status === 'reversed' && <Chip>{t('chip_reversed')}</Chip>}
        {item.awaiting_external && <Chip>{t('chip_awaiting', { source: sourceLabel })}</Chip>}
      </span>
    )
  } else if (item.proposal && item.proposal.vouchers && item.proposal.vouchers.length > 1) {
    // An explaining set (#2293): the row equals several verifikat together.
    const set = item.proposal.vouchers
    ledgerAmount = set.reduce((s, v) => s + v.amount, 0)
    ledgerText = (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5" title={t('proposal_set_title', { count: set.length })}>
        {set.map((v, i) => (
          <span key={v.journal_entry_id} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-muted-foreground" aria-hidden>
                +
              </span>
            )}
            <Link href={`/bookkeeping/${v.journal_entry_id}`} className={QUIET_LINK_CLASS} data-ph-mask>
              {voucherOf(v) ?? v.journal_entry_id.slice(0, 8)}
            </Link>
          </span>
        ))}
        <span className="text-[11px] text-muted-foreground">
          {t('confidence', { percent: Math.round(item.proposal.confidence * 100) })}
        </span>
      </span>
    )
  } else if (item.proposal) {
    const p = item.proposal
    ledgerDate = p.entry_date
    ledgerAmount = item.amount
    ledgerText = (
      <span className="flex min-w-0 items-center gap-2">
        {p.description && (
          <span className="truncate" data-ph-mask title={p.description}>
            {p.description}
          </span>
        )}
        <Link href={`/bookkeeping/${p.journal_entry_id}`} className={cn(QUIET_LINK_CLASS, 'shrink-0')} data-ph-mask>
          {voucherOf(p) ?? p.journal_entry_id.slice(0, 8)}
        </Link>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t('confidence', { percent: Math.round(p.confidence * 100) })}
        </span>
      </span>
    )
  } else if (item.linked_journal_entry_id) {
    ledgerAmount = item.amount
    ledgerText = (
      <span className="flex items-center gap-2">
        <Link href={`/bookkeeping/${item.linked_journal_entry_id}`} className={QUIET_LINK_CLASS} data-ph-mask>
          {item.linked_journal_entry_id.slice(0, 8)}
        </Link>
        {item.link_problem === 'entry_draft' && <Chip>{t('chip_draft')}</Chip>}
        {item.link_problem === 'entry_reversed' && <Chip>{t('chip_reversed')}</Chip>}
        {item.link_problem === 'entry_missing' && <Chip>{t('chip_missing')}</Chip>}
      </span>
    )
  } else if (item.bucket === 'ignored') {
    ledgerText = <Chip>{t('v2_chip_ignored')}</Chip>
  } else if (item.bucket === 'upcoming') {
    ledgerText = <Chip>{t('bucket_upcoming')}</Chip>
  } else {
    ledgerText = <Chip>{t('v2_chip_not_booked')}</Chip>
  }

  // ---- the sign between the sides -------------------------------------------
  const sign =
    item.bucket === 'matched'
      ? '='
      : item.bucket === 'proposed'
        ? '≈'
        : item.bucket === 'ignored' || item.bucket === 'upcoming'
          ? '·'
          : '≠'
  const signTone =
    item.bucket === 'matched' ? 'text-success' : item.bucket === 'proposed' ? 'text-foreground' : 'text-warning'

  // ---- actions: one button, the rest behind the menu -----------------------
  const openHref = item.item_type === 'transaction' ? `/transactions?highlight=${item.item_id}` : null
  let primary: React.ReactNode = null
  if (can('match') && item.proposal) {
    primary = (
      <Button size="sm" variant="outline" className="h-7 px-3.5 text-xs" onClick={onMatch} disabled={anyBusy} aria-busy={busy}>
        {t('row_match')}
      </Button>
    )
  } else if (can('book') && isSkv) {
    primary = (
      <Button size="sm" variant="outline" className="h-7 px-3.5 text-xs" onClick={onBook} disabled={anyBusy}>
        {t('row_book')}
      </Button>
    )
  } else if (can('book') && openHref) {
    primary = (
      <Button size="sm" variant="outline" className="h-7 px-3.5 text-xs" asChild>
        <Link href={openHref}>{t('row_book')}</Link>
      </Button>
    )
  } else if (can('unignore')) {
    primary = (
      <button type="button" onClick={onUnignore} disabled={anyBusy} className={QUIET_LINK_CLASS}>
        {t('row_unignore')}
      </button>
    )
  } else if (can('review') && !external) {
    primary = (
      <Link href={`/bookkeeping/${item.item_id}`} className={QUIET_LINK_CLASS}>
        {t('row_review')}
      </Link>
    )
  }
  const menu: Array<{ key: string; label: string; onSelect: () => void }> = []
  if (can('unmatch')) menu.push({ key: 'unmatch', label: t('row_unmatch'), onSelect: onUnmatch })
  if (can('ignore')) menu.push({ key: 'ignore', label: t('row_ignore'), onSelect: onIgnore })
  if (onMarkIb) menu.push({ key: 'ib', label: t('row_mark_ib'), onSelect: onMarkIb })
  for (const target of moveTargets) {
    menu.push({
      key: `move:${target.account_key}`,
      label: t('v2_move_to', { account: `${target.name} (${target.account_number})` }),
      onSelect: () => onMove(target),
    })
  }

  return (
    <tr className="group transition-colors duration-150 hover:bg-secondary/35">
      <td className={cn(TD_CLASS, '!pl-0', DATE)}>{external ? formatDate(item.date) : ''}</td>
      <td className={cn(TD_CLASS, 'max-w-0')}>
        {external && (
          <span className="block truncate" data-ph-mask title={item.description}>
            {item.description}
          </span>
        )}
      </td>
      <td className={cn(TD_CLASS, NUM)} data-ph-mask>
        {external ? money(item.amount) : ''}
      </td>
      <td className={cn(TD_CLASS, 'text-center', signTone)} aria-label={t(`v2_sign_${item.bucket}`)}>
        <span aria-hidden>{sign}</span>
      </td>
      <td className={cn(TD_CLASS, DATE)}>{ledgerDate ? formatDate(ledgerDate) : ''}</td>
      <td className={cn(TD_CLASS, 'max-w-0')}>{ledgerText}</td>
      <td className={cn(TD_CLASS, NUM)} data-ph-mask>
        {ledgerAmount != null ? money(ledgerAmount) : ''}
      </td>
      <td className={cn(TD_CLASS, '!pr-0 text-right')}>
        <span className="inline-flex items-center justify-end gap-2">
          {primary}
          {menu.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 hover:text-foreground"
                  aria-label={t('v2_more')}
                  disabled={anyBusy}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {menu.map((m) => (
                  <DropdownMenuItem key={m.key} onSelect={m.onSelect}>
                    {m.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </td>
    </tr>
  )
}
