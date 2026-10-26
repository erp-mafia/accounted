'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarDaysIcon } from '@/components/icons'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  AccrualReplanDialog,
  canReplanSchedule,
  type ReplannableSchedule,
} from '@/components/bookkeeping/AccrualReplanDialog'
import type { AccrualSchedule, AccrualScheduleInstallment } from '@/types'

type InvoiceSchedule = AccrualSchedule & { installments: AccrualScheduleInstallment[] }

/**
 * The periodisering schedules of one customer or supplier invoice, by
 * invoice line, and the one "Ändra periodisering" dialog for its page.
 * Place `replanDialog` once on the page; `openReplan` opens it for a line's
 * schedule.
 */
export function useInvoiceAccrualSchedules(
  source: { supplierInvoiceId?: string; invoiceId?: string },
  enabled: boolean,
) {
  const [schedules, setSchedules] = useState<InvoiceSchedule[]>([])
  const [target, setTarget] = useState<ReplannableSchedule | null>(null)
  const { supplierInvoiceId, invoiceId } = source

  const load = useCallback(async () => {
    const filter = supplierInvoiceId
      ? `supplier_invoice_id=${supplierInvoiceId}`
      : invoiceId
        ? `invoice_id=${invoiceId}`
        : null
    if (!filter) return
    try {
      const res = await fetch(`/api/bookkeeping/accruals?status=all&${filter}`)
      if (!res.ok) return
      const json = await res.json()
      setSchedules((json.data ?? []) as InvoiceSchedule[])
    } catch {
      // The line falls back to the invoice row's own period; nothing to edit.
    }
  }, [supplierInvoiceId, invoiceId])

  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])

  const byItem = useMemo(() => {
    const map = new Map<string, InvoiceSchedule>()
    for (const schedule of schedules) {
      const itemId = schedule.supplier_invoice_item_id ?? schedule.invoice_item_id
      // A credited and re-planned line can carry more than one: the active one wins.
      if (itemId && (!map.has(itemId) || schedule.status === 'active')) map.set(itemId, schedule)
    }
    return map
  }, [schedules])

  return {
    scheduleForItem: (itemId: string | undefined | null) => (itemId ? byItem.get(itemId) ?? null : null),
    openReplan: setTarget,
    replanDialog: (
      <AccrualReplanDialog
        schedule={target}
        onOpenChange={(open) => !open && setTarget(null)}
        onReplanned={() => {
          setTarget(null)
          void load()
        }}
      />
    ),
  }
}

interface AccrualLineInfoProps {
  /** The invoice row's own period, shown when its schedule is not loaded. */
  start: string
  end: string
  balanceAccount?: string | null
  /** The row's schedule: its period is the current plan once one exists. */
  schedule?: ReplannableSchedule | null
  canWrite?: boolean
  onReplan?: (schedule: ReplannableSchedule) => void
}

/**
 * The "Periodiseras 2026-09 till 2027-03 · 1710" line under a periodiserad
 * invoice row, the same on customer and supplier invoices, with "Ändra
 * periodisering" while the schedule has months left to book.
 */
export function AccrualLineInfo({ start, end, balanceAccount, schedule, canWrite, onReplan }: AccrualLineInfoProps) {
  const t = useTranslations('accruals')
  const from = (schedule?.period_start ?? start).slice(0, 7)
  const to = (schedule?.period_end ?? end).slice(0, 7)
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground tabular-nums">
      <CalendarDaysIcon className="h-3 w-3 shrink-0" />
      {t('line_info', { from, to })}
      {balanceAccount && ` · ${balanceAccount}`}
      {canWrite && onReplan && schedule && canReplanSchedule(schedule) && (
        <button
          type="button"
          className={QUIET_LINK_CLASS}
          onClick={(e) => {
            e.stopPropagation()
            onReplan(schedule)
          }}
        >
          · {t('replan_action')}
        </button>
      )}
    </span>
  )
}
