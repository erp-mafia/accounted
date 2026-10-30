'use client'

import { useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import { useReportData } from '@/lib/hooks/use-report-data'
import { cn } from '@/lib/utils'

const NONE = 'none'

/**
 * The budget a report compares with (accounted#134): the year's budgets,
 * mounted by FocusedReport for the resultatrapport and the per-dimension
 * report. Renders nothing for a year without budgets, so a company that
 * never made one sees nothing changed.
 */
export function BudgetPicker({
  periodId,
  value,
  onChange,
}: {
  periodId: string
  value: string | null
  onChange: (budgetId: string | null) => void
}) {
  const t = useTranslations('reports')
  const { data } = useReportData<{ budgets: { budget_id: string; name: string; is_default: boolean }[] }>(
    `/api/budgets?fiscal_period_id=${periodId}`,
    t('budget_picker_failed'),
  )
  const budgets = useMemo(() => data?.budgets ?? [], [data])

  // A budget of another year never rides along to this one.
  useEffect(() => {
    if (value && data && !budgets.some((b) => b.budget_id === value)) onChange(null)
  }, [value, data, budgets, onChange])

  if (budgets.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <Label className="field-label text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('budget_picker_label')}</Label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
        <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-[200px]')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('budget_picker_none')}</SelectItem>
          {budgets.map((b) => (
            <SelectItem key={b.budget_id} value={b.budget_id}>
              <span data-ph-mask="">{b.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
