'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  AUTO_STAGES,
  stageIndex,
  type SupplierInvoiceLadderStage,
  type SupplierInvoiceStage,
} from '@/lib/supplier-invoices/stages'

/**
 * The invoice page's stage strip: a cell per Inköp stage carrying the date
 * it happened or what it still needs.
 */
export function StageSteps({
  stages,
  current,
  detail,
}: {
  stages: readonly SupplierInvoiceLadderStage[]
  current: SupplierInvoiceStage
  /** Per-stage line: the date it happened, or what it still needs. */
  detail: (stage: SupplierInvoiceLadderStage, state: 'done' | 'now' | 'todo') => string
}) {
  const t = useTranslations('supplier_invoices')
  const idx = stageIndex(current)
  return (
    <div className="mb-5 flex overflow-hidden rounded-lg border border-border">
      {stages.map((s) => {
        const i = stageIndex(s)
        const state: 'done' | 'now' | 'todo' = idx < 0 ? 'todo' : i < idx ? 'done' : i === idx ? 'now' : 'todo'
        return (
          <div
            key={s}
            className={cn(
              'flex min-w-0 flex-1 flex-col justify-center gap-0.5 border-r border-border px-3 py-2 last:border-r-0',
              state === 'now' && 'bg-secondary shadow-[inset_0_-2px_0_hsl(var(--foreground))]',
            )}
          >
            <span
              className={cn(
                'truncate text-[11px] font-semibold uppercase tracking-[0.06em]',
                state === 'done' ? 'text-success' : state === 'now' ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(`stage_${s}`)}
              {AUTO_STAGES.has(s) ? ` · ${t('stage_auto')}` : ''}
            </span>
            <span className={cn('truncate text-[12.5px]', state === 'todo' ? 'text-muted-foreground/70' : 'text-foreground/80')}>
              {detail(s, state)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
