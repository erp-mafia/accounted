'use client'

import { useTranslations } from 'next-intl'
import { effectiveRunTotals } from '@/lib/salary/effective-figures'
import type { SalaryRunEmployee } from '@/types'
import { formatRunAmount, type RunDetail } from './types'

interface RunKpiCardsProps {
  run: RunDetail
  employees: SalaryRunEmployee[]
}

/**
 * Recomputed from per-employee rows so manual overrides (avancerat läge) are
 * reflected immediately, without relying on run.total_* columns which are
 * frozen at calculate-time.
 */
export function RunKpiCards({ run, employees }: RunKpiCardsProps) {
  const t = useTranslations('salary_run')

  // The shared effective-figures helper (each step rounded to whole öre)
  // applies the same override rules as the booking, including that an
  // F-skatt row ignores an avgifter override.
  const effective = effectiveRunTotals(employees)

  const cards = [
    { label: t('kpi_gross'), value: run.total_gross },
    { label: t('kpi_tax'), value: effective.total_tax },
    { label: t('kpi_net'), value: effective.total_net, accent: true },
    { label: t('kpi_avgifter'), value: effective.total_avgifter },
    { label: t('kpi_employer_cost'), value: effective.total_employer_cost },
  ]

  // Flat stat row: label/number pairs on whitespace, no boxes or rules.
  // Metrics wrap on narrow viewports.
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-4">
      {cards.map(({ label, value, accent }) => (
        <div key={label} className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
          <p
            className={`mt-1 font-display text-xl tabular-nums leading-none ${accent ? 'text-success' : ''}`}
          >
            {formatRunAmount(value)}
          </p>
        </div>
      ))}
    </div>
  )
}
