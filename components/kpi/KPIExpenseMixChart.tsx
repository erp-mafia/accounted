'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils'

interface KPIExpenseMixChartProps {
  composition: {
    class4: number
    class5: number
    class6: number
    class7: number
  }
}

const SEGMENT_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-4))',
]

export function KPIExpenseMixChart({ composition }: KPIExpenseMixChartProps) {
  const t = useTranslations('kpi')
  const { class4, class5, class6, class7 } = composition
  const chartData = useMemo(
    () =>
      [
        { name: t('expense_mix_class4'), value: class4 },
        { name: t('expense_mix_class5'), value: class5 },
        { name: t('expense_mix_class6'), value: class6 },
        { name: t('expense_mix_class7'), value: class7 },
      ].filter((s) => s.value > 0),
    [class4, class5, class6, class7, t]
  )

  const total = class4 + class5 + class6 + class7
  const totalCompact =
    new Intl.NumberFormat('sv-SE', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(total) + ' kr'

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('expense_mix_title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
            {t('expense_mix_empty')}
          </div>
        ) : (
          <div className="relative flex flex-col items-center">
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={84}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {chartData.map((_, index) => (
                    <Cell key={index} fill={SEGMENT_COLORS[index % SEGMENT_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => [formatCurrency(Number(value)), '']}
                  contentStyle={{
                    fontSize: '12px',
                    borderRadius: '8px',
                    border: '1px solid hsl(var(--border))',
                    backgroundColor: 'hsl(var(--card))',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute left-0 right-0 top-0 h-[180px] flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('expense_mix_total')}
              </span>
              <span
                className="font-display text-lg tabular-nums"
                title={formatCurrency(total)}
              >
                {totalCompact}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
              {chartData.map((seg, i) => (
                <div key={seg.name} className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-[2px]"
                    style={{ backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}
                  />
                  <span>{seg.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
