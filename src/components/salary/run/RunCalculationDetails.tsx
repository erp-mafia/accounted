'use client'

import { useTranslations } from 'next-intl'
import { DetailSection } from '@/components/ui/detail-section'
import { TaxTableStatus } from '@/components/salary/TaxTableStatus'
import { formatCurrency } from '@/lib/utils'
import type { SalaryRunEmployee } from '@/types'

type SreWithEmployee = SalaryRunEmployee & {
  employee?: { first_name: string; last_name: string }
}

interface RunCalculationDetailsProps {
  periodYear: number
  employees: SalaryRunEmployee[]
}

export function RunCalculationDetails({ periodYear, employees }: RunCalculationDetailsProps) {
  const t = useTranslations('salary_run')
  const withBreakdown = employees.filter(e => e.calculation_breakdown)
  if (withBreakdown.length === 0) return null

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
                      <span className="shrink-0 tabular-nums">{formatCurrency(step.output)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </DetailSection>
  )
}
