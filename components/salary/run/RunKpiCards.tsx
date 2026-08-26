'use client'

import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'
import type { SalaryRunEmployee } from '@/types'
import type { RunDetail } from './types'

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

  const effTax = employees.reduce((s, e) => s + (e.tax_withheld_override ?? e.tax_withheld), 0)
  const effAvgifter = employees.reduce(
    (s, e) => s + (e.avgifter_amount_override ?? e.avgifter_amount),
    0,
  )
  const effNet = employees.reduce(
    (s, e) => s + (e.net_salary + (e.tax_withheld - (e.tax_withheld_override ?? e.tax_withheld))),
    0,
  )
  const effEmployerCost = employees.reduce(
    (s, e) =>
      s +
      e.gross_salary +
      (e.avgifter_amount_override ?? e.avgifter_amount) +
      e.vacation_accrual +
      e.vacation_accrual_avgifter,
    0,
  )

  const cards = [
    { label: t('kpi_gross'), value: run.total_gross },
    { label: t('kpi_tax'), value: effTax },
    { label: t('kpi_net'), value: effNet, accent: true },
    { label: t('kpi_avgifter'), value: effAvgifter },
    { label: t('kpi_employer_cost'), value: effEmployerCost },
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
            {formatCurrency(value)}
          </p>
        </div>
      ))}
    </div>
  )
}
