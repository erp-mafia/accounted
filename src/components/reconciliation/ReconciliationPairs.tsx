'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { VoucherPeekLink } from '@/components/bookkeeping/VoucherPeekLink'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { ReconciliationAccount, ReconciliationItem } from '@/lib/reconciliation/schemas'

/**
 * Rows of the reconciliation flow (concept reconflow, the pairs):
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
  /**
   * Skattekonto: opens the manual match view. A row the ledger already holds
   * (covered_by_ledger) is linked there, so it becomes the row's main action
   * and booking moves behind the menu.
   */
  onLinkInstead?: () => void
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
      <th className={cn(TH_CLASS, 'w-[96px] pl-6')}>{t('col_date')}</th>
      <th className={TH_CLASS}>{t('v2_side_ledger')}</th>
      <th className={cn(TH_CLASS, 'w-[120px] text-right')}>{t('col_amount')}</th>
      <th className={cn(TH_CLASS, '!pr-0 w-[150px]')} aria-hidden="true"></th>
    </tr>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border px-2 py-px text-xs text-muted-foreground">
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
  onLinkInstead,
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
  // The ledger already holds this event inside an unlinked verifikat on 1630
  // (a summarised one): link it, never book it a second time.
  const covered = external && isSkv && item.covered_by_ledger === true

  // ---- the ledger side -----------------------------------------------------
  let ledgerDate: string | null = null
  let ledgerText: React.ReactNode = null
  let ledgerAmount: number | null = null
  if (!external) {
    ledgerDate = item.date
    ledgerAmount = item.amount
    // Verifikat linked to each other (a wrong verifikat and its rättelse):
    // the chip names the others, so the row reads as explained, by what.
    const settlement = item.settlement ?? null
    const settledWith = settlement
      ? settlement.counterparts.map((c) => voucherOf(c) ?? c.journal_entry_id.slice(0, 8)).join(', ')
      : ''
    ledgerText = (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate" data-ph-mask title={item.description}>
          {item.description}
        </span>
        <VoucherPeekLink entryId={item.item_id} className={cn(QUIET_LINK_CLASS, 'shrink-0')} data-ph-mask>
          {voucherOf(item) ?? item.item_id.slice(0, 8)}
        </VoucherPeekLink>
        {item.entry_status === 'draft' && <Chip>{t('chip_draft')}</Chip>}
        {item.entry_status === 'reversed' && <Chip>{t('chip_reversed')}</Chip>}
        {item.awaiting_external && <Chip>{t('chip_awaiting', { source: sourceLabel })}</Chip>}
        {item.partially_linked && (
          <Chip>
            {t('chip_remainder', {
              total: money(item.partially_linked.entry_amount),
              count: item.partially_linked.linked_count,
            })}
          </Chip>
        )}
        {settlement && (
          <span className="shrink-0" data-ph-mask title={t('settled_title', { date: formatDate(settlement.settled_at) })}>
            <Chip>
              {settlement.state === 'broken'
                ? t('chip_settlement_broken', { vouchers: settledWith })
                : t('chip_settled_with', { vouchers: settledWith })}
            </Chip>
          </span>
        )}
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
            <VoucherPeekLink entryId={v.journal_entry_id} className={QUIET_LINK_CLASS} data-ph-mask>
              {voucherOf(v) ?? v.journal_entry_id.slice(0, 8)}
            </VoucherPeekLink>
          </span>
        ))}
        <span className="text-xs text-muted-foreground">
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
        <VoucherPeekLink entryId={p.journal_entry_id} className={cn(QUIET_LINK_CLASS, 'shrink-0')} data-ph-mask>
          {voucherOf(p) ?? p.journal_entry_id.slice(0, 8)}
        </VoucherPeekLink>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('confidence', { percent: Math.round(p.confidence * 100) })}
        </span>
      </span>
    )
  } else if (item.linked_journal_entry_id) {
    const linked = item.linked_entry ?? null
    ledgerAmount = item.amount
    ledgerDate = linked?.entry_date ?? null
    ledgerText = (
      <span className="flex min-w-0 items-center gap-2">
        <VoucherPeekLink entryId={item.linked_journal_entry_id} className={cn(QUIET_LINK_CLASS, 'shrink-0')} data-ph-mask>
          {(linked ? voucherOf(linked) : null) ?? item.linked_journal_entry_id.slice(0, 8)}
        </VoucherPeekLink>
        {linked?.description ? <span className="truncate text-muted-foreground">{linked.description}</span> : null}
        {item.link_problem === 'entry_draft' && <Chip>{t('chip_draft')}</Chip>}
        {item.link_problem === 'entry_reversed' && <Chip>{t('chip_reversed')}</Chip>}
        {item.link_problem === 'entry_missing' && <Chip>{t('chip_missing')}</Chip>}
      </span>
    )
  } else if (covered) {
    ledgerText = <Chip>{t('chip_covered')}</Chip>
  } else if (item.bucket === 'ignored') {
    ledgerText = <Chip>{t('v2_chip_ignored')}</Chip>
  } else if (item.bucket === 'upcoming') {
    ledgerText = <Chip>{t('bucket_upcoming')}</Chip>
  }
  // A bank row with nothing on the ledger side says so by being empty: the
  // group header above it already reads "saknas i bokföringen".

  // ---- actions: one button, the rest behind the menu -----------------------
  const openHref = item.item_type === 'transaction' ? `/transactions?highlight=${item.item_id}` : null
  let primary: React.ReactNode = null
  if (can('match') && item.proposal) {
    primary = (
      <Button variant="outline" onClick={onMatch} disabled={anyBusy} aria-busy={busy}>
        {t('row_match')}
      </Button>
    )
  } else if (covered && onLinkInstead) {
    primary = (
      <Button variant="outline" onClick={onLinkInstead} disabled={anyBusy}>
        {t('row_match')}
      </Button>
    )
  } else if (can('book') && isSkv) {
    primary = (
      <Button variant="outline" onClick={onBook} disabled={anyBusy}>
        {t('row_book')}
      </Button>
    )
  } else if (can('book') && openHref) {
    primary = (
      <Button variant="outline" asChild>
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
      <VoucherPeekLink entryId={item.item_id} className={QUIET_LINK_CLASS}>
        {t('row_review')}
      </VoucherPeekLink>
    )
  }
  const menu: Array<{ key: string; label: string; onSelect: () => void }> = []
  // Booking a covered row stays possible, as the deliberate second choice:
  // the dialog it opens explains what already covers the row.
  if (covered && onLinkInstead && can('book')) menu.push({ key: 'book', label: t('row_book_anyway'), onSelect: onBook })
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
      <td className={cn(TD_CLASS, '!pl-0 date-figures', DATE)}>{external ? formatDate(item.date) : ''}</td>
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
      <td className={cn(TD_CLASS, DATE, 'pl-6 date-figures')}>{ledgerDate ? formatDate(ledgerDate) : ''}</td>
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
                  className={cn('text-muted-foreground hover:text-foreground data-[state=open]:opacity-100', HOVER_REVEAL_CLASS)}
                  aria-label={t('v2_more')}
                  disabled={anyBusy}
                >
                  <EllipsisHorizontalIcon className="h-4 w-4" />
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
