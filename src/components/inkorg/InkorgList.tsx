'use client'

import { useEffect, useRef } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { DocumentMagnifyingGlassIcon, InboxIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { RowSelectCheckbox } from '@/components/ui/dry-table'
import { BrandMark, GlyphMark } from '@/components/parties/BrandMark'
import { cn, formatCurrency } from '@/lib/utils'
import { OVERDUE_CHIP } from '@/lib/status-display'
import type { BankMatch } from '@/lib/documents/inbox-bank-match'
import { inboxKindLabelKey } from '@/lib/documents/inbox-kind'
import { shortDate, shortDateTime } from '@/lib/inkorg/dates'
import { rowStatus } from '@/lib/inkorg/decision'
import { doorOf, itemHeadline, type InkorgItem, type InkorgView } from '@/lib/inkorg/items'
import { useDoorName } from './door-icon'
import { ROW_CLASS, RowChevron, RowTitle } from './row-parts'
import type { LoadState } from './use-inkorg-data'
import type { BulkSelection } from '@/lib/hooks/use-bulk-selection'

/**
 * The selected view as rows: the sender's mark, its name over the door and
 * the time it came, the document's own line (the mail subject, else its
 * number), where it stands and the amount. A row opens the focus view.
 * With a `selection`, the rows in `selectableIds` carry the lists' shared
 * selection checkbox (shift-click extends the range), for removing several.
 */
export function InkorgList({
  view,
  items,
  state,
  onOpen,
  onRetry,
  lastOpenedId,
  bankMatches,
  selection,
  selectableIds,
}: {
  view: InkorgView
  items: InkorgItem[]
  state: LoadState
  onOpen: (id: string) => void
  onRetry: () => void
  /** The row the focus view was left on, scrolled into view and marked. */
  lastOpenedId: string | null
  /** What the focus view read since about each item's bank row (a match, null for none); it wins over the list's own. */
  bankMatches: ReadonlyMap<string, BankMatch | null>
  /** The list's bulk selection; left out, no row can be picked (a viewer). */
  selection?: BulkSelection
  /** The rows that can be picked: those the focus view would let a person remove. */
  selectableIds?: ReadonlySet<string>
}) {
  const t = useTranslations('inkorg')

  // Back from the focus view: the row it was left on comes into view, once.
  useEffect(() => {
    if (lastOpenedId) document.getElementById(`inkorg-row-${lastOpenedId}`)?.scrollIntoView({ block: 'nearest' })
  }, [lastOpenedId])

  if (state === 'loading') {
    return (
      <LateReveal>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex h-11 items-center gap-4 border-b-hairline px-2">
            <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="ml-auto h-3.5 w-20" />
          </div>
        ))}
      </LateReveal>
    )
  }

  if (state === 'failed') {
    return <LoadError title={t('load_failed')} onRetry={onRetry} />
  }

  if (items.length === 0) {
    return view.kind === 'need' ? (
      <EmptyState icon={InboxIcon} title={t('empty_need_title')} description={t('empty_need_body')} />
    ) : (
      <EmptyState icon={InboxIcon} title={t('empty_door_title')} description={t('empty_door_body')} />
    )
  }

  return (
    <ul className="stagger-enter border-t-hairline">
      {items.map((item) => (
        <InkorgRow
          key={item.id}
          item={item}
          onOpen={onOpen}
          marked={item.id === lastOpenedId}
          bankMatch={bankMatches.get(item.id)}
          selected={selection?.selectedIds.has(item.id) ?? false}
          anySelected={(selection?.selectedIds.size ?? 0) > 0}
          onToggleSelect={selection && selectableIds?.has(item.id) ? selection.toggle : undefined}
        />
      ))}
    </ul>
  )
}

function InkorgRow({
  item,
  onOpen,
  marked,
  bankMatch,
  selected,
  anySelected,
  onToggleSelect,
}: {
  item: InkorgItem
  onOpen: (id: string) => void
  marked: boolean
  bankMatch: BankMatch | null | undefined
  selected: boolean
  /** Something in the list is picked: every checkbox shows solid. */
  anySelected: boolean
  /** Picks or unpicks the row (true extends the range); left out, the row has no checkbox. */
  onToggleSelect?: (id: string, extend?: boolean) => void
}) {
  const t = useTranslations('inkorg')
  const tKind = useTranslations('inbox_workspace')
  const doorName = useDoorName(item.channel_context?.mail_provider ?? null)
  const locale = useLocale()
  const shiftHeld = useRef(false)
  const headline = itemHeadline(item)
  const status = rowStatus(item, bankMatch)
  const invoiceNumber = item.extracted_data?.invoice?.invoiceNumber?.trim() || null
  const subject = item.email_subject?.trim() || null

  // The document's own line: what the mail said, else its kind and number.
  const kindLabelKey = inboxKindLabelKey(headline.kind, item.extracted_data)
  const ownLine =
    subject && subject !== headline.name
      ? subject
      : invoiceNumber && kindLabelKey
        ? t('row_doc_number', { kind: tKind(kindLabelKey), number: invoiceNumber })
        : kindLabelKey
          ? tKind(kindLabelKey)
          : null
  // An invoice whose receipt came with it carries it on this row: the receipt has none of its own.
  // The marker sits beside the line, never inside it, so a long subject truncates without hiding it.
  const withReceipt = item.pairing?.role === 'invoice'

  const pill =
    status.kind === 'looks_paid' ? (
      <Badge variant="warning">{t('q_already_paid')}</Badge>
    ) : status.kind === 'paid_by_receipt' ? (
      <Badge variant="secondary">{t('status_paid_by_receipt')}</Badge>
    ) : status.kind === 'to_pay' ? (
      status.overdue ? (
        <Badge variant={OVERDUE_CHIP}>{t('status_overdue', { date: shortDate(status.dueDate, locale) })}</Badge>
      ) : (
        <Badge variant="secondary">{t('status_to_pay', { date: shortDate(status.dueDate, locale) })}</Badge>
      )
    ) : status.kind === 'unreadable' ? (
      <Badge variant="destructive">{t('row_unreadable')}</Badge>
    ) : status.kind === 'no_file' ? (
      <Badge variant="warning">{t('row_no_file')}</Badge>
    ) : status.kind === 'linked' ? (
      <Badge variant="secondary">{t('status_linked')}</Badge>
    ) : status.kind === 'booked_with' ? (
      <Badge variant="secondary">{status.voucher ? t('status_booked_with', { voucher: status.voucher }) : t('status_booked_with_no_voucher')}</Badge>
    ) : status.kind === 'waiting' ? (
      // The normal state, on nearly every row of Behöver dig: muted text,
      // so the chips mark the rows that deviate.
      <span className="text-xs text-muted-foreground">{t('status_waiting')}</span>
    ) : status.kind === 'reading' ? (
      <span className="text-xs text-muted-foreground">{t('row_reading')}</span>
    ) : null

  const amount = headline.amount != null ? formatCurrency(headline.amount, headline.currency) : ''

  return (
    <li id={`inkorg-row-${item.id}`} className="group relative">
      {/* The lists' selection checkbox (transactions-page pattern): it hangs in
          the left margin, beside the row and never inside its button, so the
          row keeps its columns and a click on the box never opens the item. */}
      {onToggleSelect && (
        <RowSelectCheckbox
          checked={selected}
          revealed={anySelected}
          onClick={(e) => {
            shiftHeld.current = e.shiftKey
          }}
          onCheckedChange={() => onToggleSelect(item.id, shiftHeld.current)}
          aria-label={t('bulk_select_row', { name: headline.name ?? t('row_unknown') })}
          className="absolute -left-4 top-1/2 -translate-y-1/2 md:-left-6"
        />
      )}
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className={cn(
          ROW_CLASS,
          'grid-cols-[28px_minmax(0,1fr)_auto] sm:grid-cols-[28px_minmax(8rem,15rem)_minmax(0,1fr)_auto_7.5rem_1rem]',
          (marked || selected) && 'bg-secondary/35',
        )}
      >
        {headline.name ? (
          <BrandMark name={headline.name} variant="mark" size={28} logoUrl={item.logo_url} />
        ) : (
          <GlyphMark size={28}>
            <DocumentMagnifyingGlassIcon aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          </GlyphMark>
        )}
        <RowTitle
          name={headline.name ?? t('row_unknown')}
          meta={`${doorName(doorOf(item))} · ${shortDateTime(item.created_at, locale)}`}
        />
        <span className="hidden min-w-0 items-baseline gap-1 text-muted-foreground sm:flex">
          {ownLine && (
            <span data-ph-mask="" className="min-w-0 truncate">
              {ownLine}
            </span>
          )}
          {withReceipt && (
            <span className="shrink-0 whitespace-nowrap">{ownLine ? t('row_with_receipt_after_line') : t('row_with_receipt')}</span>
          )}
        </span>
        {/* On a phone the status rides under the amount. */}
        <span className="hidden justify-end sm:flex">{pill}</span>
        <span className="flex flex-col items-end gap-1">
          <span data-ph-mask="" className="font-medium tabular-nums">
            {amount}
          </span>
          <span className="sm:hidden">{pill}</span>
        </span>
        <RowChevron />
      </button>
    </li>
  )
}
