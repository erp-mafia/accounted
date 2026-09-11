'use client'

import { useCallback, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ImportNotices } from '@/components/import/ImportNotices'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isIsoDateShaped } from '@/lib/invariants'
import { EMPLOYEE_FIELD_LABELS } from '@/lib/import/employees/labels'
import type { AnnotatedEmployeeRow, EmployeeImportPayload } from '@/lib/import/employees/types'

let idCounter = 0
const newId = () => `emp_row_${++idCounter}_${Date.now()}`

interface EditableEmployeeRow extends AnnotatedEmployeeRow {
  id: string
}

interface EmployeesEditStepProps {
  rows: AnnotatedEmployeeRow[]
  onExecute: (rows: AnnotatedEmployeeRow[]) => void
  onBack: () => void
  isLoading: boolean
  error: string | null
  /** What the parser noticed about the file (lib/import/notices.ts). */
  notices?: ImportNotice[]
}

// The fields this step lets the user edit inline. Their server-side messages
// are dropped on edit and re-derived here; the execute route is the final gate.
const EDITABLE_FIELDS = ['first_name', 'last_name', 'monthly_salary', 'hourly_rate', 'tax_table_number', 'employment_start'] as const
const EDITABLE_LABELS = EDITABLE_FIELDS.map((f) => EMPLOYEE_FIELD_LABELS[f])

function isEditableMessage(message: string): boolean {
  return EDITABLE_LABELS.some((label) => message.startsWith(label))
}

export default function EmployeesEditStep({
  rows: initialRows,
  onExecute,
  onBack,
  isLoading,
  error,
  notices = [],
}: EmployeesEditStepProps) {
  const t = useTranslations('import_employees')
  const [rows, setRows] = useState<EditableEmployeeRow[]>(() =>
    initialRows.map((r) => ({ ...r, id: newId() })),
  )

  const duplicateCount = useMemo(() => rows.filter((r) => r.duplicate_match !== null).length, [rows])
  const cutoverCount = useMemo(() => rows.filter((r) => r.opening_balances !== null).length, [rows])
  const newCount = rows.length - duplicateCount
  const hasErrors = useMemo(() => rows.some((r) => !r.is_valid), [rows])
  const canContinue = rows.length > 0 && !hasErrors && !isLoading

  const revalidate = useCallback(
    (row: EditableEmployeeRow): EditableEmployeeRow => {
      const kept = row.validation_errors.filter((m) => !isEditableMessage(m))
      const own: string[] = []
      const e = row.employee
      if (!e.first_name.trim()) own.push(t('err_first_name'))
      if (!e.last_name.trim()) own.push(t('err_last_name'))
      if (e.salary_type === 'monthly' && !((e.monthly_salary ?? 0) > 0)) own.push(t('err_monthly_salary'))
      if (e.salary_type === 'hourly' && !((e.hourly_rate ?? 0) > 0)) own.push(t('err_hourly_rate'))
      const table = e.tax_table_number
      if (table === undefined || !Number.isInteger(table) || table < 29 || table > 42) own.push(t('err_tax_table'))
      if (!isIsoDateShaped(e.employment_start)) own.push(t('err_employment_start'))
      const validation_errors = [...kept, ...own]
      return {
        ...row,
        display_name: `${e.first_name} ${e.last_name}`.trim(),
        validation_errors,
        is_valid: validation_errors.length === 0,
      }
    },
    [t],
  )

  const updateEmployee = useCallback(
    (id: string, patch: Partial<EmployeeImportPayload>) => {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? revalidate({ ...r, employee: { ...r.employee, ...patch } }) : r)),
      )
    },
    [revalidate],
  )

  const deleteRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const handleExecute = () => {
    if (!canContinue) return
    onExecute(rows.map(({ id: _id, ...rest }) => rest))
  }

  const numberValue = (value: number | undefined) => (value === undefined ? '' : String(value))
  const parseNumber = (raw: string): number | undefined => {
    const n = parseFloat(raw.replace(/\s/g, '').replace(',', '.'))
    return Number.isFinite(n) ? n : undefined
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('review_title')}</CardTitle>
        <CardDescription>
          {t('review_description', { newCount, duplicateCount, cutoverCount })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 text-left">{t('th_name')}</th>
                <th className="px-3 py-2 text-left w-36">{t('th_personnummer')}</th>
                <th className="px-3 py-2 text-left w-40">{t('th_start')}</th>
                <th className="px-3 py-2 text-right w-36">{t('th_salary')}</th>
                <th className="px-3 py-2 text-right w-24">{t('th_tax_table')}</th>
                <th className="px-3 py-2 text-left w-32">{t('th_status')}</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const e = row.employee
                const isHourly = e.salary_type === 'hourly'
                return (
                  <tr
                    key={row.id}
                    className={cn('border-b last:border-0 align-top', !row.is_valid && 'bg-destructive/5')}
                  >
                    <td className="px-3 py-1.5">
                      <div className="flex gap-2">
                        <Input
                          aria-label={t('th_first_name')}
                          value={e.first_name}
                          onChange={(ev) => updateEmployee(row.id, { first_name: ev.target.value })}
                          className="h-8"
                        />
                        <Input
                          aria-label={t('th_last_name')}
                          value={e.last_name}
                          onChange={(ev) => updateEmployee(row.id, { last_name: ev.target.value })}
                          className="h-8"
                        />
                      </div>
                      {row.validation_errors.length > 0 && (
                        <p className="mt-1 text-xs text-destructive">{row.validation_errors.join('. ')}</p>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground">
                      {row.personnummer_masked || '-'}
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        aria-label={t('th_start')}
                        type="date"
                        value={e.employment_start}
                        onChange={(ev) => updateEmployee(row.id, { employment_start: ev.target.value })}
                        className="h-8 tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center justify-end gap-2">
                        <Input
                          aria-label={isHourly ? t('th_hourly_rate') : t('th_monthly_salary')}
                          inputMode="decimal"
                          value={numberValue(isHourly ? e.hourly_rate : e.monthly_salary)}
                          onChange={(ev) =>
                            updateEmployee(
                              row.id,
                              isHourly
                                ? { hourly_rate: parseNumber(ev.target.value) }
                                : { monthly_salary: parseNumber(ev.target.value) },
                            )
                          }
                          className="h-8 text-right tabular-nums"
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {isHourly ? t('unit_hourly') : t('unit_monthly')}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        aria-label={t('th_tax_table')}
                        inputMode="numeric"
                        value={numberValue(e.tax_table_number)}
                        onChange={(ev) => {
                          const n = parseInt(ev.target.value, 10)
                          updateEmployee(row.id, { tax_table_number: Number.isFinite(n) ? n : undefined })
                        }}
                        className="h-8 text-right tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5 pt-1.5">
                        {!row.is_valid && (
                          <span className="text-destructive shrink-0" title={row.validation_errors.join(', ')}>
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </span>
                        )}
                        {row.duplicate_match ? (
                          <span
                            className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                            title={t('duplicate_title', { name: row.duplicate_match.existing_name })}
                          >
                            {t('status_skipped')}
                          </span>
                        ) : (
                          <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-success">
                            {t('status_new')}
                          </span>
                        )}
                        {row.opening_balances && (
                          <span
                            className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                            title={t('cutover_title', { date: row.opening_balances.cutover_date })}
                          >
                            {t('status_cutover')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t('remove_row')}
                        onClick={() => deleteRow(row.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <ImportNotices
          notices={[
            ...(hasErrors ? [makeNotice('rows_invalid', 'action')] : []),
            ...notices,
          ]}
        />

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack} disabled={isLoading}>
            {t('back')}
          </Button>
          <Button onClick={handleExecute} disabled={!canContinue}>
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('importing')}
              </>
            ) : (
              t('import_button', { count: rows.length })
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
