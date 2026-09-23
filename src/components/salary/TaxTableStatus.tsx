'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('salary_tax_tables')
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
        {t('checking')}
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
      ? t('source_api', { year: status.year })
      : status.source === 'fallback'
        ? t('source_fallback', { year: status.year })
        : t('source_unavailable', { year: status.year })

  if (compact) {
    return (
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Globe className="h-3 w-3" />
        {label}
      </p>
    )
  }

  // Flat row presentation (Fönster settings language): muted status line
  // with a quiet right-aligned recheck, no box.
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} />
      <span className="min-w-0 text-xs text-muted-foreground">{label}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={check}
        disabled={loading}
        aria-label={t('recheck')}
        className="ml-auto shrink-0"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}
