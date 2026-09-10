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
 * The Inköp flow as one flat bar (UI v2 PR 6): a cell per stage with the
 * number of invoices sitting there. Clicking a cell filters the list. The
 * same component renders the invoice page's strip in `steps` mode, where
 * each cell carries the date or what is still needed.
 */
export function StagePipeline({
  stages,
  counts,
  active,
  onSelect,
}: {
  stages: readonly SupplierInvoiceLadderStage[]
  counts: Partial<Record<SupplierInvoiceStage, number>>
  active: SupplierInvoiceStage | null
  onSelect: (stage: SupplierInvoiceLadderStage | null) => void
}) {
  const t = useTranslations('supplier_invoices')
  return (
    <div className="mb-3 flex overflow-hidden rounded-lg border border-border" role="tablist" aria-label={t('pipeline_aria')}>
      {stages.map((s) => {
        const n = counts[s] ?? 0
        const on = active === s
        return (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={on}
            title={t(`stage_${s}_help`)}
            onClick={() => onSelect(on ? null : s)}
            className={cn(
              'flex h-10 min-w-0 flex-1 items-center justify-center gap-2 border-r border-border px-2 text-[12.5px] transition-colors duration-150 last:border-r-0',
              on ? 'bg-secondary text-foreground shadow-[inset_0_-2px_0_hsl(var(--foreground))]' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <span className="truncate">{t(`stage_${s}`)}</span>
            {AUTO_STAGES.has(s) && <span className="text-[10.5px] text-muted-foreground">{t('stage_auto')}</span>}
            <span className="font-medium tabular-nums text-foreground" data-ph-mask>
              {n || '–'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

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
                'truncate text-[10.5px] font-semibold uppercase tracking-[0.06em]',
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
