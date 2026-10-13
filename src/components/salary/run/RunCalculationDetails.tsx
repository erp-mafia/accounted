'use client'

import { useTranslations } from 'next-intl'
import { DetailSection } from '@/components/ui/detail-section'
import { TaxTableStatus } from '@/components/salary/TaxTableStatus'
import { declaredAvgifterNote } from '@/lib/salary/effective-figures'
import { formatCurrency } from '@/lib/utils'
import type { SalaryRunEmployee } from '@/types'
import { formatRunAmount } from './types'

type SreWithEmployee = SalaryRunEmployee & {
  employee?: { first_name: string; last_name: string }
}

interface RunCalculationDetailsProps {
  periodYear: number
  employees: SalaryRunEmployee[]
  /** The run's frozen payroll-config snapshot (sats and caps for the AGI figure). */
  calculationParams: Record<string, unknown> | null
}

export function RunCalculationDetails({ periodYear, employees, calculationParams }: RunCalculationDetailsProps) {
  const t = useTranslations('salary_run')
  const withBreakdown = employees.filter(e => e.calculation_breakdown)
  if (withBreakdown.length === 0) return null
  // The per-employee steps end in öre-exact avgifter; the AGI declares the
  // run's avgift in whole kronor (Skatteverket's computation, the function
  // the AGI generator files with). When they differ, close the trace with
  // both so the declared amount is explained where the math is read
  // (crm#1149).
  const declared = declaredAvgifterNote(employees, calculationParams)

  return (
    <DetailSection kicker={t('calculation_details_title')}>
      <div className="space-y-6">
        <TaxTableStatus year={periodYear} compact />
        {withBreakdown.map(sre => {
          const breakdown = sre.calculation_breakdown as {
            steps?: Array<{ label: string; formula: string; output: number | null }>
          }
          const employee = (sre as SreWithEmployee).employee
          return (
            <div key={sre.id}>
              <h4 className="text-sm font-medium">
                {employee
                  ? `${employee.first_name} ${employee.last_name}`
                  : sre.employee_id.slice(0, 8)}
              </h4>
              {/* Flat calculation steps: one hairline per step, no box. */}
              <div className="mt-1 divide-y divide-border text-xs">
                {(breakdown?.steps || []).map((step, i) => (
                  <div key={i} className="flex justify-between gap-4 py-1">
                    <span className="min-w-0 text-muted-foreground">
                      {step.label}: <span className="font-mono">{step.formula}</span>
                    </span>
                    {step.output !== null && (
                      <span className="shrink-0 tabular-nums">{formatRunAmount(step.output)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
        {declared && (
          <div>
            <h4 className="text-sm font-medium">{t('calculation_declared_title')}</h4>
            <div className="mt-1 divide-y divide-border text-xs">
              <div className="flex justify-between gap-4 py-1">
                <span className="min-w-0 text-muted-foreground">{t('calculation_computed_label')}</span>
                <span className="shrink-0 tabular-nums">{formatRunAmount(declared.computed)}</span>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <span className="min-w-0 text-muted-foreground">
                  {t('calculation_declared_label')}:{' '}
                  <span className="font-mono">
                    {t('calculation_declared_formula', { underlag: formatCurrency(declared.declaredUnderlag) })}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatRunAmount(declared.declared)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </DetailSection>
  )
}
