'use client'

import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('calculation_details_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <TaxTableStatus year={periodYear} compact />
        {withBreakdown.map(sre => {
          const breakdown = sre.calculation_breakdown as {
            steps?: Array<{ label: string; formula: string; output: number | null }>
          }
          const employee = (sre as SreWithEmployee).employee
          return (
            <div key={sre.id} className="space-y-2">
              <h4 className="text-sm font-medium">
                {employee
                  ? `${employee.first_name} ${employee.last_name}`
                  : sre.employee_id.slice(0, 8)}
              </h4>
              <div className="text-xs space-y-1 bg-muted/50 rounded-lg p-3">
                {(breakdown?.steps || []).map((step, i) => (
                  <div key={i} className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {step.label}: <span className="font-mono">{step.formula}</span>
                    </span>
                    {step.output !== null && (
                      <span className="font-medium tabular-nums">{formatCurrency(step.output)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
