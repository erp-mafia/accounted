'use client'

import { useTranslations } from 'next-intl'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency } from '@/lib/utils'
import type { KPIReport } from '@/types'
import { monthsTableRows } from './months-table'

/**
 * Income, expenses and net result month by month for the selected fiscal
 * year, with the period totals as the last row (#2196). Full width like
 * KPIBreakdown: the bars pane only has room for the net column, and this
 * table is where the two other columns the payload already carries show.
 */
export function KPIMonthsTable({ report }: { report: KPIReport }) {
  const t = useTranslations('kpi')
  if (report.months.length === 0) return null
  const { rows, total } = monthsTableRows(report)
  const numeric = 'whitespace-nowrap text-right tabular-nums'

  return (
    <div>
      <div className="mb-1 flex items-center gap-3 px-1">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
          {t('trend_title')}
        </h2>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, 'w-full')}>{t('months_col_month')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('trend_legend_income')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('trend_legend_expenses')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('trend_legend_net')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.label} className={cn(m.inactive && 'text-muted-foreground/60')}>
                <td className={cn(TD_CLASS, 'whitespace-nowrap')}>{m.label}</td>
                <td className={cn(TD_CLASS, numeric)}>{formatCurrency(m.income)}</td>
                <td className={cn(TD_CLASS, numeric)}>{formatCurrency(m.expenses)}</td>
                <td className={cn(TD_CLASS, numeric, m.net < 0 && !m.inactive && 'text-destructive')}>
                  {formatCurrency(m.net)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td className={cn(TD_CLASS, 'border-b-0 whitespace-nowrap')}>{t('months_total')}</td>
              <td className={cn(TD_CLASS, 'border-b-0', numeric)}>{formatCurrency(total.income)}</td>
              <td className={cn(TD_CLASS, 'border-b-0', numeric)}>{formatCurrency(total.expenses)}</td>
              <td className={cn(TD_CLASS, 'border-b-0', numeric, total.net < 0 && 'text-destructive')}>
                {formatCurrency(total.net)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
