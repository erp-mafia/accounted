'use client'

import { useTranslations } from 'next-intl'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils'

interface KPITopSuppliersChartProps {
  suppliers: { supplier_id: string; supplier_name: string; total: number }[]
}

const BAR_COLOR = 'hsl(var(--chart-1))'

export function KPITopSuppliersChart({ suppliers }: KPITopSuppliersChartProps) {
  const t = useTranslations('kpi')
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('top_suppliers_title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {suppliers.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-center text-sm text-muted-foreground px-4">
            {t('top_suppliers_empty')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(160, suppliers.length * 32)}>
            <BarChart
              data={suppliers}
              layout="vertical"
              margin={{ top: 5, right: 16, left: 0, bottom: 5 }}
            >
              <XAxis
                type="number"
                tickFormatter={(v) =>
                  new Intl.NumberFormat('sv-SE', { notation: 'compact' }).format(v)
                }
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="supplier_name"
                tick={{ fontSize: 11 }}
                width={120}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <Tooltip
                formatter={(value) => [formatCurrency(Number(value)), t('top_suppliers_spend')]}
                contentStyle={{
                  fontSize: '12px',
                  borderRadius: '8px',
                  border: '1px solid hsl(var(--border))',
                  backgroundColor: 'hsl(var(--card))',
                }}
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
              />
              <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                {suppliers.map((s) => (
                  <Cell key={s.supplier_id} fill={BAR_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
