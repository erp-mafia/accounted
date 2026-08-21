'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertCircle, History } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { formatDateTime } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import {
  BEHANDLINGSHISTORIK_CATEGORIES,
  type BehandlingshistorikCategory,
  type BehandlingshistorikReport,
} from '@/lib/reports/behandlingshistorik-types'

type CategoryFilter = 'all' | BehandlingshistorikCategory

function buildQuery(periodId: string, dateRange: DateRangeValue): string {
  const params = new URLSearchParams({ period_id: periodId })
  if (dateRange.fromDate) params.set('from_date', dateRange.fromDate)
  if (dateRange.toDate) params.set('to_date', dateRange.toDate)
  return params.toString()
}

/**
 * Behandlingshistorik report body (BFL 5 kap. 11 §). Event labels arrive in
 * Swedish from the read model (räkenskapsinformation); the chrome here
 * (headers, filter, counts) is translated.
 */
export function BehandlingshistorikView({
  periodId,
  dateRange,
}: {
  periodId: string
  dateRange: DateRangeValue
}) {
  const t = useTranslations('reports')
  const [data, setData] = useState<BehandlingshistorikReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<CategoryFilter>('all')

  const query = buildQuery(periodId, dateRange)

  useEffect(() => {
    if (!periodId) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/reports/behandlingshistorik?${query}`)
        const result = await res.json()
        if (cancelled) return
        if (!res.ok || result.error) {
          setError(getErrorMessage(result))
        } else {
          setData(result.data)
        }
      } catch {
        if (!cancelled) setError(t('bh_error'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
    // t is stable for the mounted locale; the query string is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, query])

  const visible = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data.events
    return data.events.filter((e) => e.category === filter)
  }, [data, filter])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || data.events.length === 0) {
    return <EmptyState icon={History} title={t('bh_empty_title')} description={t('bh_empty_desc')} />
  }

  const filterOptions = [
    { value: 'all' as CategoryFilter, label: t('bh_filter_all'), count: data.total_events },
    ...BEHANDLINGSHISTORIK_CATEGORIES.filter((c) => data.by_category[c] > 0).map((c) => ({
      value: c as CategoryFilter,
      label: t(`bh_cat_${c}`),
      count: data.by_category[c],
    })),
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="overflow-x-auto">
          <SegmentedControl
            value={filter}
            onChange={setFilter}
            options={filterOptions}
            aria-label={t('bh_filter_aria')}
          />
        </div>
        <ReportExportMenu
          items={[
            { format: 'xlsx', href: `/api/reports/behandlingshistorik?${query}&format=xlsx` },
            { format: 'csv', href: `/api/reports/behandlingshistorik?${query}&format=csv` },
          ]}
        />
      </div>

      <p className="text-sm text-muted-foreground tabular-nums">
        {t('bh_summary', { count: data.total_events })} · {data.range.from} {t('bh_range_to')} {data.range.to}
        {data.app_version ? ` · ${t('bh_version')}: ${data.app_version}` : ''}
      </p>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="px-4 py-2 w-40">{t('bh_col_time')}</th>
                  <th className="px-4 py-2">{t('bh_col_event')}</th>
                  <th className="px-4 py-2 w-56">{t('bh_col_actor')}</th>
                  <th className="px-4 py-2">{t('bh_col_details')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => (
                  <tr key={e.id} className="border-b last:border-0 align-top">
                    <td className="px-4 py-2 tabular-nums whitespace-nowrap text-muted-foreground">
                      {formatDateTime(e.occurred_at)}
                    </td>
                    <td className="px-4 py-2">
                      <div>{e.event}</div>
                      {e.object && (
                        <div className="font-mono text-xs text-muted-foreground">{e.object}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground break-words">{e.actor.label}</td>
                    <td className="px-4 py-2">
                      {e.details.length > 0 && (
                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {e.details.map((d, i) => (
                            <li key={i}>{d}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
