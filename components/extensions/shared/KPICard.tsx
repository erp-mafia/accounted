'use client'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface KPICardProps {
  label: string
  value: string | number
  suffix?: string
  trend?: { value: number; label: string }
  className?: string
}

export default function KPICard({ label, value, suffix, trend, className }: KPICardProps) {
  return (
    <Card className={cn('', className)}>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="flex items-baseline gap-1 mt-1">
          <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
          {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
        </div>
        {trend && (
          <p className={cn(
            'text-xs mt-1',
            trend.value > 0 ? 'text-success' : trend.value < 0 ? 'text-destructive' : 'text-muted-foreground'
          )}>
            {trend.value > 0 ? '+' : ''}{trend.value}% {trend.label}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
