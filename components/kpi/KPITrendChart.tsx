'use client'

import { useTranslations } from 'next-intl'
import {
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Line,
  ComposedChart,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils'

interface KPITrendChartProps {
  months: { label: string; income: number; expenses: number; net: number }[]
}

export function KPITrendChart({ months }: KPITrendChartProps) {
  const t = useTranslations('kpi')
  if (months.length === 0) return null

  const seriesLabel = (key: string) =>
    key === 'income' ? t('trend_legend_income')
      : key === 'expenses' ? t('trend_legend_expenses')
      : t('trend_legend_net')

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('trend_title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart
            data={months}
            margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis
              tickFormatter={(v) =>
                new Intl.NumberFormat('sv-SE', { notation: 'compact' }).format(v)
              }
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              formatter={(value, name) => [
                formatCurrency(Number(value)),
                seriesLabel(String(name)),
              ]}
              contentStyle={{
                fontSize: '12px',
                borderRadius: '8px',
                border: '1px solid hsl(var(--border))',
                backgroundColor: 'hsl(var(--card))',
              }}
            />
            <Legend formatter={(value: string) => seriesLabel(value)} />
            <Area
              type="monotone"
              dataKey="income"
              fill="hsl(var(--chart-1))"
              fillOpacity={0.15}
              stroke="hsl(var(--chart-1))"
              strokeWidth={1.5}
            />
            <Area
              type="monotone"
              dataKey="expenses"
              fill="hsl(var(--chart-2))"
              fillOpacity={0.15}
              stroke="hsl(var(--chart-2))"
              strokeWidth={1.5}
            />
            <Line
              type="monotone"
              dataKey="net"
              stroke="hsl(var(--chart-3))"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
