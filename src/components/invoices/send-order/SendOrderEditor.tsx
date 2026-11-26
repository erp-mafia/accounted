'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { ArrowUpIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useCustomers } from '@/lib/reference-data/hooks'
import { DIGITAL_MAILBOX_PROVIDER_NAMES } from '@/lib/digital-mailboxes/sending-status'
import { countCustomerReach } from '@/lib/invoices/send-order-reach'
import {
  initialSendOrderRows,
  moveSendOrderRowUp,
  orderOfRows,
  splitCustomers,
  toggleSendOrderRow,
  type SendOrderRow,
  type SendOrderWay,
} from '@/lib/invoices/send-order'
import { useSaveSendOrder, useSendOrderWays } from './use-send-order'

/** The bar's segments by position: ink tiers, the lowest tier last. */
const SEGMENT_CLASSES = ['bg-foreground/80', 'bg-foreground/55', 'bg-foreground/35', 'bg-foreground/20'] as const

interface SendOrderListProps {
  rows: readonly SendOrderRow[]
  perWay: Record<SendOrderWay, number> | null
  /** Whether any customer is here: with none, no count is printed. */
  hasCustomers: boolean
  onMoveUp: (way: SendOrderWay) => void
  onToggle: (way: SendOrderWay) => void
}

/** The ways as a list: position, name, what it is, who it reaches first, move up, switch. */
function SendOrderList({ rows, perWay, hasCustomers, onMoveUp, onToggle }: SendOrderListProps) {
  const t = useTranslations('invoice_send_order')
  const wayName = (way: SendOrderWay) =>
    way === 'peppol' ? t('way_peppol') : way === 'email' ? t('way_email') : DIGITAL_MAILBOX_PROVIDER_NAMES[way]
  const wayLine = (way: SendOrderWay) =>
    way === 'peppol' ? t('line_peppol') : way === 'email' ? t('line_email') : t('line_mailbox')
  return (
    <ul className="m-0 list-none p-0">
      {rows.map((row, index) => {
        const position = rows.slice(0, index + 1).filter((other) => other.on).length
        const name = wayName(row.way)
        return (
          <li key={row.way} className="flex min-h-11 items-center gap-3 border-b-hairline py-2">
            <span
              className={cn('w-5 shrink-0 text-center text-[13px] tabular-nums', row.on ? 'text-strong' : 'text-muted-foreground')}
              aria-hidden="true"
            >
              {row.on ? position : '-'}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-[13px] font-medium', row.on ? 'text-strong' : 'text-muted-foreground')}>{name}</div>
              <div className="text-xs text-muted-foreground">{wayLine(row.way)}</div>
            </div>
            {perWay && row.on && hasCustomers ? (
              <span className="shrink-0 text-xs tabular-nums text-foreground/80">{t('reach_count', { count: perWay[row.way] })}</span>
            ) : null}
            {index === 0 ? (
              <span className="h-7 w-7 shrink-0 pointer-coarse:min-w-10" aria-hidden="true" />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('move_up', { way: name })}
                onClick={() => onMoveUp(row.way)}
              >
                <ArrowUpIcon className="h-4 w-4" />
              </Button>
            )}
            <Switch
              checked={row.on}
              onCheckedChange={() => onToggle(row.way)}
              aria-label={t('use_way', { way: name })}
            />
          </li>
        )
      })}
    </ul>
  )
}

interface SendOrderSplitProps {
  rows: readonly SendOrderRow[]
  perWay: Record<SendOrderWay, number>
  none: number
  total: number
}

/** A thin bar and its legend: how the customers split over the ways in the current order. */
function SendOrderSplit({ rows, perWay, none, total }: SendOrderSplitProps) {
  const t = useTranslations('invoice_send_order')
  const wayName = (way: SendOrderWay) =>
    way === 'peppol' ? t('way_peppol') : way === 'email' ? t('way_email') : DIGITAL_MAILBOX_PROVIDER_NAMES[way]
  const segments = rows
    .filter((row) => row.on && perWay[row.way] > 0)
    .map((row, index) => ({ way: row.way, count: perWay[row.way], className: SEGMENT_CLASSES[Math.min(index, SEGMENT_CLASSES.length - 1)] }))
  return (
    <div className="space-y-2">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="img" aria-label={t('split_label')}>
        {segments.map((segment) => (
          <div key={segment.way} className={segment.className} style={{ width: `${(segment.count / total) * 100}%` }} />
        ))}
        {none > 0 ? <div className="bg-warning" style={{ width: `${(none / total) * 100}%` }} /> : null}
      </div>
      <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs text-foreground/80">
        {segments.map((segment) => (
          <li key={segment.way} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full', segment.className)} aria-hidden="true" />
            <span>{wayName(segment.way)}</span>
            <span className="tabular-nums">{segment.count}</span>
          </li>
        ))}
        {none > 0 ? (
          <li className="flex items-center gap-1.5 text-attn">
            <StatusGlyph tone="warning" />
            <span className="tabular-nums">{t('without_way', { count: none })}</span>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

interface SendOrderFormProps {
  available: readonly SendOrderWay[]
  saved: readonly SendOrderWay[] | null
  /** The one line above the list; the setup block says how many customers are here. */
  lead?: (customerCount: number | null) => ReactNode
  onSaved: () => void
  onCancel?: () => void
}

function SendOrderForm({ available, saved, lead, onSaved, onCancel }: SendOrderFormProps) {
  const t = useTranslations('invoice_send_order')
  const [rows, setRows] = useState<SendOrderRow[]>(() => initialSendOrderRows(available, saved))
  const [isSaving, setIsSaving] = useState(false)
  const saveOrder = useSaveSendOrder()
  const { customers, isLoading: customersLoading, error: customersError } = useCustomers()
  const counts = useMemo(() => countCustomerReach(customers), [customers])
  const customersKnown = !customersLoading && !customersError
  const order = orderOfRows(rows)
  const split = useMemo(() => splitCustomers(counts, order), [counts, order])
  const perWay = customersKnown ? split.perWay : null

  async function handleSave() {
    if (order.length === 0 || isSaving) return
    setIsSaving(true)
    const ok = await saveOrder(order)
    setIsSaving(false)
    if (ok) onSaved()
  }

  return (
    <div className="space-y-4">
      {lead ? lead(customersKnown ? split.total : null) : null}
      <SendOrderList
        rows={rows}
        perWay={perWay}
        hasCustomers={customersKnown && split.total > 0}
        onMoveUp={(way) => setRows((current) => moveSendOrderRowUp(current, way))}
        onToggle={(way) => setRows((current) => toggleSendOrderRow(current, way))}
      />
      {customersKnown && split.total > 0 ? (
        <SendOrderSplit rows={rows} perWay={split.perWay} none={split.none} total={split.total} />
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="button" onClick={handleSave} disabled={order.length === 0} loading={isSaving}>
          {t('apply')}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
            {t('cancel')}
          </Button>
        ) : null}
        {order.length === 0 ? <span className="text-xs text-muted-foreground">{t('turn_one_on')}</span> : null}
      </div>
    </div>
  )
}

type SendOrderEditorProps = Omit<SendOrderFormProps, 'available'> & {
  /** The company's ways when the caller already has them; otherwise they are read here. */
  available?: readonly SendOrderWay[]
}

/**
 * The order of the ways invoices go out, with what each would reach: the
 * list, the split of the customers and the one primary. The setup block on
 * the invoices page and the row in the invoice settings both show it.
 * Renders nothing until the company's ways are known.
 */
export function SendOrderEditor({ available: given, ...props }: SendOrderEditorProps) {
  const read = useSendOrderWays(given === undefined)
  const available = given ?? read
  if (!available) return null
  return <SendOrderForm {...props} available={available} />
}
