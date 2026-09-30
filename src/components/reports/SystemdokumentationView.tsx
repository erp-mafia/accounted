'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { cn, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { SystemdokumentationReport } from '@/lib/reports/systemdokumentation-types'

/**
 * Systemdokumentation on screen: what the generated document covers for the
 * chosen räkenskapsår (delsystem in use, verifikationsserier, members, API
 * keys, integrations) with the PDF export. The document itself is the PDF;
 * this view is the summary that tells the reader what they will get.
 */
interface SystemdokumentationViewProps {
  periodId: string
}

export function SystemdokumentationView({ periodId }: SystemdokumentationViewProps) {
  const t = useTranslations('systemdokumentation')
  const [report, setReport] = useState<SystemdokumentationReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Keyed on periodId by the caller: a new period is a fresh mount, so the
  // initial loading state is the reset.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/reports/systemdokumentation?period_id=${encodeURIComponent(periodId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setError(getErrorMessage(json, { statusCode: res.status }))
          return
        }
        setReport(json.data as SystemdokumentationReport)
      })
      .catch(() => {
        if (!cancelled) setError(t('load_failed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [periodId, t])

  if (loading) {
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (error || !report) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          <AlertCircle className="mx-auto mb-2 h-6 w-6" />
          {error ?? t('load_failed')}
        </CardContent>
      </Card>
    )
  }

  const seriesInUse = [...new Set(report.verifikationsserier.per_source_type.map((r) => r.series))].sort()
  const rows: { label: string; value: string }[] = [
    { label: t('row_system'), value: `${report.system.name}, ${t('row_version', { version: report.app_version ?? t('version_unknown') })}` },
    { label: t('row_accounts'), value: t('accounts_count', { count: report.kontoplan.accounts.length, standard: report.kontoplan.standard }) },
    { label: t('row_delsystem'), value: report.delsystem.filter((d) => d.active).map((d) => d.label).join(', ') },
    { label: t('row_series'), value: seriesInUse.map((s) => `${s} ${report.verifikationsserier.per_source_type.find((r) => r.series === s)?.series_label ?? ''}`.trim()).join(', ') },
    { label: t('row_lock'), value: report.rattelse_och_las.lock_date ? formatDate(report.rattelse_och_las.lock_date) : t('no_lock_date') },
    { label: t('row_members'), value: t('members_count', { count: report.behorigheter.members.length }) },
    { label: t('row_api_keys'), value: t('api_keys_count', { count: report.behorigheter.api_keys.length }) },
    { label: t('row_integrations'), value: report.integrationer.filter((i) => i.active).map((i) => i.label).join(', ') },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('summary', { period: report.period.name, generated: formatDate(report.generated_at) })}</p>
        <ReportExportMenu items={[{ format: 'pdf', href: `/api/reports/systemdokumentation?period_id=${encodeURIComponent(periodId)}&format=pdf` }]} />
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-[220px]')}>{t('col_section')}</th>
                <th className={TH_CLASS}>{t('col_content')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-border last:border-b-0 align-top">
                  <td className={cn(TD_CLASS, 'font-medium')}>{row.label}</td>
                  <td className={TD_CLASS} data-ph-mask>
                    {row.value || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{t('supplement_note')}</p>
    </div>
  )
}
