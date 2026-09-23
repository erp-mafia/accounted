'use client'

import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils'
import type { TrialBalanceRow } from '@/types'

interface TrialBalanceChartProps {
  rows: TrialBalanceRow[]
}

export function TrialBalanceChart({ rows }: TrialBalanceChartProps) {
  const chartData = useMemo(() => {
    return rows
      .map((row) => ({
        name: `${row.account_number} ${row.account_name}`,
        account: row.account_number,
        net: Math.round((row.closing_debit - row.closing_credit) * 100) / 100,
      }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, 10)
  }, [rows])

  if (chartData.length === 0) return null

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Topp 10 konton (nettosaldo)</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(v) => new Intl.NumberFormat('sv-SE', { notation: 'compact' }).format(v)}
            />
            <YAxis
              type="category"
              dataKey="account"
              width={50}
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              formatter={(value) => [
                formatCurrency(Number(value)),
                'Netto',
              ]}
              labelFormatter={(label) => chartData.find((d) => d.account === String(label))?.name || String(label)}
            />
            <Bar dataKey="net" radius={[0, 4, 4, 0]}>
              {chartData.map((entry) => (
                <Cell
                  key={entry.account}
                  fill={entry.net >= 0 ? 'hsl(var(--chart-1))' : 'hsl(var(--chart-2))'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
