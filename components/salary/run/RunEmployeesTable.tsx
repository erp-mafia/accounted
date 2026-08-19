'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronRight, FileDown, Loader2, Trash2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { EmployeeMasked, SalaryRunEmployee } from '@/types'
import type { RunDetail } from './types'

type SreWithEmployee = SalaryRunEmployee & {
  employee?: {
    first_name: string
    last_name: string
    // The run detail endpoint returns the masked display form under this key;
    // the encrypted `personnummer` column never reaches the client.
    personnummer_masked: string
    default_dimensions?: Record<string, string>
  }
}

interface RunEmployeesTableProps {
  run: RunDetail
  runId: string
  employees: SalaryRunEmployee[]
  availableEmployees: EmployeeMasked[]
  canWrite: boolean
  actionLoading: string | null
  dimensionsEnabled: boolean
  isCalculated: boolean
  onAddEmployee: (employeeId: string) => void
  onRemoveEmployee: (employeeId: string, name: string) => void
  onSalaryEdit: (employeeId: string, raw: string, previous: number) => void
}

export function RunEmployeesTable({
  run,
  runId,
  employees,
  availableEmployees,
  canWrite,
  actionLoading,
  dimensionsEnabled,
  isCalculated,
  onAddEmployee,
  onRemoveEmployee,
  onSalaryEdit,
}: RunEmployeesTableProps) {
  const t = useTranslations('salary_run')
  const router = useRouter()
  const [addEmployeeKey, setAddEmployeeKey] = useState(0)

  const addedEmployeeIds = new Set(employees.map(e => e.employee_id))
  const notAdded = availableEmployees.filter(e => !addedEmployeeIds.has(e.id))
  const canRemoveEmployee = run.status === 'draft' && canWrite
  const isDraft = run.status === 'draft'

  // Δ vs the latest booked run — hidden on the first-ever run and before
  // calculation (gross is 0 until then, the diff would be noise).
  const previous = run.previous_run ?? null
  const showDiff = previous != null && isCalculated

  function diffNode(sre: SalaryRunEmployee) {
    if (!previous) return null
    const prev = previous.by_employee[sre.employee_id]
    if (!prev) {
      return (
        <Badge variant="secondary" className="font-normal">
          {t('diff_new_employee')}
        </Badge>
      )
    }
    const delta = roundOre(sre.gross_salary - prev.gross)
    if (delta === 0) return null
    const sign = delta > 0 ? '+' : '−'
    return (
      <span className="text-xs text-muted-foreground tabular-nums">
        {sign}
        {formatCurrency(Math.abs(delta))}
      </span>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
          {t('employees_title', { count: employees.length })}
        </h2>
        {isDraft && canWrite && notAdded.length > 0 && (
          <Select
            key={addEmployeeKey}
            onValueChange={value => {
              onAddEmployee(value)
              setAddEmployeeKey(k => k + 1)
            }}
          >
            <SelectTrigger className="w-[200px] h-8 text-sm">
              <SelectValue placeholder={t('add_employee_placeholder')} />
            </SelectTrigger>
            <SelectContent>
              {notAdded.map(emp => (
                <SelectItem key={emp.id} value={emp.id}>
                  {emp.first_name} {emp.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {employees.length === 0 ? (
        <div className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t('no_employees_yet')}
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {employees.map(sre => {
            const employee = (sre as SreWithEmployee).employee
            const name = employee
              ? `${employee.first_name} ${employee.last_name}`
              : `${t('employee_fallback')} ${sre.employee_id.slice(0, 8)}...`
            const dims = employee?.default_dimensions ?? {}
            const dimLabel = Object.keys(dims)
              .sort((a, b) => Number(a) - Number(b))
              .map(k => dims[k])
              .join(' · ')
            const taxValue = sre.tax_withheld_override ?? sre.tax_withheld
            const avgifterValue = sre.avgifter_amount_override ?? sre.avgifter_amount
            const netValue = sre.net_salary + (sre.tax_withheld - taxValue)
            const editableSalary = isDraft && canWrite && sre.salary_type === 'monthly'
            const primaryNumber = isDraft ? sre.monthly_salary : sre.gross_salary
            // In a draft the number on the row is the full-time monthly salary
            // the engine multiplies by the employee's sysselsättningsgrad. Below
            // 100 % that product is not obvious from the input alone (a 10 %
            // employee typed 45 310 to get a 4 531 kr gross), so spell it out
            // right under the number instead of only in Beräkningsdetaljer.
            const degree = Number(sre.employment_degree)
            const showDegreeHint =
              isDraft && sre.salary_type === 'monthly' && Number.isFinite(degree) && degree < 100
            const degreeHint = showDegreeHint ? (
              <span className="text-[11px] leading-tight text-muted-foreground tabular-nums whitespace-nowrap">
                {t('degree_hint', {
                  degree: degree.toLocaleString('sv-SE'),
                  amount: formatCurrency(roundOre((sre.monthly_salary || 0) * (degree / 100))),
                })}
              </span>
            ) : null

            return (
              <div
                key={sre.id}
                className="group flex items-center gap-3 px-4 py-3 hover:bg-secondary/60 transition-colors cursor-pointer"
                onClick={() => router.push(`/salary/runs/${runId}/employees/${sre.employee_id}`)}
              >
                {/* Name + inline meta + (once calculated) a breakdown sub-line */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/salary/runs/${runId}/employees/${sre.employee_id}`}
                      className="font-medium truncate hover:underline"
                      onClick={e => e.stopPropagation()}
                    >
                      {name}
                    </Link>
                    {dimensionsEnabled && dimLabel && (
                      <Badge data-ph-mask="" variant="secondary">{dimLabel}</Badge>
                    )}
                    {showDiff && diffNode(sre)}
                  </div>
                  {isCalculated && (
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                      {t('th_tax')} {formatCurrency(taxValue)} · {t('th_net')}{' '}
                      {formatCurrency(netValue)} · {t('th_avgifter')}{' '}
                      {formatCurrency(avgifterValue)} · {t('th_vacation')}{' '}
                      {formatCurrency(sre.vacation_accrual)}
                    </p>
                  )}
                </div>

                {/* Right side: editable monthly salary (draft) or the number */}
                {editableSalary ? (
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={sre.monthly_salary}
                      onClick={e => e.stopPropagation()}
                      onBlur={e => onSalaryEdit(sre.employee_id, e.target.value, sre.monthly_salary)}
                      disabled={actionLoading === `salary-${sre.employee_id}`}
                      aria-label={t('salary_input_aria', { name })}
                      className="h-8 w-28 text-right tabular-nums"
                    />
                    {degreeHint}
                  </div>
                ) : (
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <span className="text-right tabular-nums font-medium">
                      {formatCurrency(primaryNumber)}
                    </span>
                    {degreeHint}
                  </div>
                )}

                {/* Payslip PDF */}
                <a
                  href={`/api/salary/runs/${runId}/payslips/${sre.employee_id}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  title={t('view_payslip_title')}
                  aria-label={t('view_payslip_title')}
                >
                  <FileDown className="h-4 w-4" />
                </a>

                {canRemoveEmployee && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={e => {
                      e.stopPropagation()
                      onRemoveEmployee(sre.employee_id, name)
                    }}
                    disabled={actionLoading === `remove-${sre.employee_id}`}
                    aria-label={t('remove_employee_aria', { name })}
                    title={t('remove_employee_title')}
                  >
                    {actionLoading === `remove-${sre.employee_id}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                )}

                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
