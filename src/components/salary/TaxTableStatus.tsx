'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  SpinnerIcon,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'

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
  // The last check could not be made (a failed answer or no connection): the
  // row says so with the recheck, instead of spinning or vanishing.
  const [failed, setFailed] = useState(false)

  async function check() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (year) params.set('year', String(year))
      const res = await fetch(`/api/salary/tax-tables/status?${params}`)
      if (!res.ok) {
        setFailed(true)
        return
      }
      const { data } = await res.json()
      setStatus(data)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year])

  if (loading && !status) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        <SpinnerIcon className="h-3 w-3 animate-spin" />
        {t('checking')}
      </div>
    )
  }

  if (failed || !status) {
    if (compact) {
      return (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <ExclamationTriangleIcon className="h-3 w-3 text-warning" />
          {t('check_failed')}
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => void check()} disabled={loading}>
            {t('recheck')}
          </button>
        </div>
      )
    }
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="min-w-0 text-xs text-muted-foreground">{t('check_failed')}</span>
        <Button
          type="button"
          variant="outline"
          onClick={() => void check()}
          loading={loading}
          aria-label={t('recheck')}
          className="ml-auto shrink-0"
        >
          {!loading && <ArrowPathIcon className="h-3.5 w-3.5" />}
        </Button>
      </div>
    )
  }

  const Icon = status.source === 'api' ? CheckCircleIcon : ExclamationTriangleIcon
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
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        <GlobeAltIcon className="h-3 w-3" />
        {label}
      </div>
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
        onClick={check}
        loading={loading}
        aria-label={t('recheck')}
        className="ml-auto shrink-0"
      >
        {!loading && <ArrowPathIcon className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}
