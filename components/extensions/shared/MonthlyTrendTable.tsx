'use client'

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

interface MonthlyRow {
  month: string
  value: number
  label?: string
}

interface MonthlyTrendTableProps {
  rows: MonthlyRow[]
  valueLabel?: string
  valueSuffix?: string
  formatValue?: (v: number) => string
  className?: string
}

export default function MonthlyTrendTable({
  rows,
  valueLabel = 'Belopp',
  valueSuffix = 'kr',
  formatValue,
  className,
}: MonthlyTrendTableProps) {
  if (rows.length === 0) {
    return (
      <div className={cn('rounded-lg border p-6 text-center text-sm text-muted-foreground', className)}>
        Ingen data att visa
      </div>
    )
  }

  const maxValue = Math.max(...rows.map(r => Math.abs(r.value)), 1)
  const fmt = formatValue ?? ((v: number) => v.toLocaleString('sv-SE'))

  return (
    <div className={cn('rounded-lg border', className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">{valueLabel}</TableHead>
            <TableHead className="w-[40%]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const barWidth = Math.round((Math.abs(row.value) / maxValue) * 100)
            return (
              <TableRow key={row.month}>
                <TableCell className="font-medium">{row.label ?? row.month}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmt(row.value)} {valueSuffix}
                </TableCell>
                <TableCell>
                  <div className="h-4 w-full rounded-sm bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-sm bg-primary/60 transition-all"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
