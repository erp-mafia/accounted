'use client'

import { useEffect, useState } from 'react'
import { Globe, CheckCircle2, AlertTriangle, RefreshCcw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Source = 'api' | 'fallback' | 'unavailable'

interface Status {
  year: number
  source: Source
  reachable: boolean
  checkedAt: string
}

interface Props {
  year?: number
  compact?: boolean
}

export function TaxTableStatus({ year, compact = false }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)

  async function check() {
    setLoading(true)
    const params = new URLSearchParams()
    if (year) params.set('year', String(year))
    const res = await fetch(`/api/salary/tax-tables/status?${params}`)
    if (res.ok) {
      const { data } = await res.json()
      setStatus(data)
    }
    setLoading(false)
  }

  useEffect(() => {
    check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year])

  if (loading && !status) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Kontrollerar skattetabeller…
      </div>
    )
  }

  if (!status) return null

  const Icon = status.source === 'api' ? CheckCircle2 : AlertTriangle
  const iconColor =
    status.source === 'api' ? 'text-success' :
    status.source === 'fallback' ? 'text-warning' :
    'text-destructive'

  const label =
    status.source === 'api'
      ? `Skattetabeller för ${status.year} hämtas live från Skatteverket`
      : status.source === 'fallback'
        ? `Skatteverkets API är inte nåbart: använder lokal reservdata för ${status.year}`
        : `Skattetabeller för ${status.year} kunde inte hämtas`

  if (compact) {
    return (
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Globe className="h-3 w-3" />
        {label}
      </p>
    )
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <Icon className={`h-4 w-4 ${iconColor}`} />
        <span>{label}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={check} disabled={loading} aria-label="Kontrollera igen">
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}
