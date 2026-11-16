'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  stageIndex,
  type SupplierInvoiceLadderStage,
  type SupplierInvoiceStage,
} from '@/lib/supplier-invoices/stages'

/**
 * The invoice page's stage strip: one line per Inköp stage, the stage name
 * and, on a done or current cell, the date it happened. A future cell is
 * the name alone; what each step takes lives behind the page's "?".
 */
export function StageSteps({
  stages,
  current,
  dateOf,
}: {
  stages: readonly SupplierInvoiceLadderStage[]
  current: SupplierInvoiceStage
  /** The date a done or current stage happened, or null when there is none. */
  dateOf: (stage: SupplierInvoiceLadderStage) => string | null
}) {
  const t = useTranslations('supplier_invoices')
  const idx = stageIndex(current)
  return (
    <div className="mb-5 flex overflow-hidden">
      {stages.map((s) => {
        const i = stageIndex(s)
        const state: 'done' | 'now' | 'todo' = idx < 0 ? 'todo' : i < idx ? 'done' : i === idx ? 'now' : 'todo'
        const date = state === 'todo' ? null : dateOf(s)
        return (
          <div
            key={s}
            className={cn(
              'flex min-w-0 flex-1 items-baseline gap-2 border-r-hairline px-3 py-2 last:border-r-0',
              state === 'now' && 'bg-secondary shadow-[inset_0_-2px_0_hsl(var(--foreground))]',
            )}
          >
            <span
              className={cn(
                'truncate text-xs font-semibold',
                state === 'done' ? 'text-success' : state === 'now' ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(`stage_${s}`)}
            </span>
            {date && <span className="min-w-0 truncate text-xs tabular-nums text-foreground/80">{date}</span>}
          </div>
        )
      })}
    </div>
  )
}
