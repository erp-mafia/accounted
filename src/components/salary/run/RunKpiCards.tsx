'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { declaredAvgifterNote, effectiveRunTotals } from '@/lib/salary/effective-figures'
import { regionalSupportForRun } from '@/lib/salary/regional-support'
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
  // The whole-krona amount the AGI declares and Skatteverket draws, from the
  // function the AGI generator files with: shown under the öre-exact avgift
  // whenever the two differ, so 1 086,12 here and 1 085 on the AGI and the
  // skattekonto read as one figure, not a rounding error (crm#1149).
  const declared = declaredAvgifterNote(employees, run.calculation_params)
  // Regionalt stöd (PH 208): the FK476 avdrag the AGI subtracts and the
  // booking credits back on 7510, from the run's frozen snapshot.
  const regional = regionalSupportForRun(employees, run.calculation_params)

  const cards: Array<{ label: string; value: number; accent?: boolean; note?: ReactNode }> = [
    { label: t('kpi_gross'), value: run.total_gross },
    { label: t('kpi_tax'), value: effective.total_tax },
    { label: t('kpi_net'), value: effective.total_net, accent: true },
    {
      label: t('kpi_avgifter'),
      value: effective.total_avgifter,
      note:
        declared || regional ? (
          <>
            {declared && (
              <InfoTooltip content={t('avgifter_declared_help')}>
                {t('kpi_avgifter_declared', { amount: formatRunAmount(declared.declared) })}
              </InfoTooltip>
            )}
            {regional && (
              <p>{t('kpi_avgifter_regional_support', { amount: formatRunAmount(regional.deduction) })}</p>
            )}
          </>
        ) : undefined,
    },
    { label: t('kpi_employer_cost'), value: effective.total_employer_cost },
  ]

  // Flat stat row: label/number pairs on whitespace, no boxes or rules.
  // Metrics wrap on narrow viewports.
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-4">
      {cards.map(({ label, value, accent, note }) => (
        <div key={label} className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p
            className={`mt-1 font-display text-xl tabular-nums leading-none ${accent ? 'text-success' : ''}`}
          >
            {formatRunAmount(value)}
          </p>
          {note && <div className="mt-2 text-xs tabular-nums text-muted-foreground">{note}</div>}
        </div>
      ))}
    </div>
  )
}
