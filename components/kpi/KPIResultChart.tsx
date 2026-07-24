'use client'

import { useTranslations } from 'next-intl'
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'

interface KPIResultChartProps {
  months: { label: string; income: number; expenses: number; net: number }[]
}

const SAGE = 'hsl(155 25% 40%)'

/**
 * The hero's trend: monthly net result as a single sage area, flat on the
 * panel (concept "Berättelsen"). One visible series, so no legend; income
 * and expenses ride along in the hover tooltip instead of extra lines.
 */
export function KPIResultChart({ months }: KPIResultChartProps) {
  const t = useTranslations('kpi')
  if (months.length === 0) return null

  return (
    <div className="mt-8">
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={months} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            formatter={(value, name) => [
              formatCurrency(Number(value)),
              name === 'net'
                ? t('trend_legend_net')
                : name === 'income'
                  ? t('trend_legend_income')
                  : t('trend_legend_expenses'),
            ]}
            contentStyle={{
              fontSize: '12px',
              borderRadius: '8px',
              border: '1px solid hsl(var(--border))',
              backgroundColor: 'hsl(var(--card))',
            }}
          />
          {/* Invisible series so the tooltip can tell the whole month's story. */}
          <Area dataKey="income" stroke="none" fill="none" activeDot={false} />
          <Area dataKey="expenses" stroke="none" fill="none" activeDot={false} />
          <Area
            type="monotone"
            dataKey="net"
            stroke={SAGE}
            strokeWidth={2}
            fill={SAGE}
            fillOpacity={0.07}
            activeDot={{ r: 3.5, fill: SAGE, stroke: 'none' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
