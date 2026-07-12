'use client'

import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { formatCurrency } from '@/lib/utils'
import { KPI_DEFINITIONS, getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { KPIReport, KPIPreferences } from '@/types'

interface KPIHeroCardsProps {
  report: KPIReport
  preferences?: KPIPreferences
}

function getKPISubtitleKey(
  report: KPIReport,
  id: string,
): { key: string; args?: Record<string, string | number> } {
  switch (id) {
    case 'netResult':
      return { key: 'sub_netto' }
    case 'cashPosition':
      return { key: 'sub_likvida_medel' }
    case 'outstandingReceivables':
      if (report.overdueReceivables > 0) {
        return { key: 'sub_overdue', args: { amount: formatCurrency(report.overdueReceivables) } }
      }
      return { key: 'sub_utestaende' }
    case 'vatLiability':
      if (report.vatLiability > 0) return { key: 'sub_att_betala' }
      if (report.vatLiability < 0) return { key: 'sub_att_aterfa' }
      return { key: 'sub_jamnt' }
    case 'grossMargin':
      return { key: 'sub_av_intakter' }
    case 'expenseRatio':
      return { key: 'sub_av_intakter' }
    case 'avgPaymentDays':
      return { key: 'sub_snitt' }
    default:
      return { key: '' }
  }
}

function getKPIValue(report: KPIReport, id: string): number | null {
  switch (id) {
    case 'netResult': return report.netResult
    case 'cashPosition': return report.cashPosition
    case 'outstandingReceivables': return report.outstandingReceivables
    case 'vatLiability': return report.vatLiability
    case 'grossMargin': return report.grossMargin
    case 'expenseRatio': return report.expenseRatio
    case 'avgPaymentDays': return report.avgPaymentDays
    default: return null
  }
}

function formatKPIValue(value: number | null, format: string, id: string, daysSuffix: string): string {
  if (value === null) return '-'
  if (format === 'currency') {
    if (id === 'vatLiability') return formatCurrency(Math.abs(value))
    return formatCurrency(value)
  }
  if (format === 'percentage') return `${value}%`
  if (format === 'days') return `${value} ${daysSuffix}`
  return String(value)
}

function getValueColor(value: number | null, colorLogic: string): string {
  if (value === null) return 'text-muted-foreground'
  if (colorLogic === 'neutral') return ''
  if (colorLogic === 'positive-good') {
    return value >= 0 ? 'text-[hsl(var(--chart-1))]' : 'text-[hsl(var(--chart-2))]'
  }
  if (colorLogic === 'negative-good') {
    return value <= 0 ? 'text-[hsl(var(--chart-1))]' : 'text-[hsl(var(--chart-2))]'
  }
  return ''
}

export function KPIHeroCards({ report, preferences }: KPIHeroCardsProps) {
  const t = useTranslations('kpi')
  const prefs = preferences ?? getDefaultPreferences()

  const visibleDefs = prefs.kpiOrder
    .map((id) => KPI_DEFINITIONS.find((d) => d.id === id))
    .filter((d) => d && prefs.visibleKpis.includes(d.id)) as typeof KPI_DEFINITIONS

  if (visibleDefs.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground text-sm">
          {t('empty_no_kpis_chosen')}
        </CardContent>
      </Card>
    )
  }

  const gridCols =
    visibleDefs.length <= 2
      ? 'grid-cols-2'
      : visibleDefs.length === 3
        ? 'grid-cols-2 md:grid-cols-3'
        : 'grid-cols-2 md:grid-cols-4'

  return (
    <div className={`grid ${gridCols} gap-4`}>
      {visibleDefs.map((def) => {
        const value = getKPIValue(report, def.id)
        const sub = getKPISubtitleKey(report, def.id)
        const formatted = formatKPIValue(value, def.format, def.id, t('value_days_suffix'))
        const color = getValueColor(value, def.colorLogic)
        const hasOverride =
          prefs.accountOverrides[def.id] &&
          prefs.accountOverrides[def.id].length > 0

        const tooltipContent = (
          <div className="space-y-1.5 text-xs">
            <p className="text-foreground/90">{t(`def_${def.id}_description`)}</p>
            <div>
              <span className="font-medium">{t('tooltip_formula')} </span>
              <span className="font-mono">{t(`def_${def.id}_formula`)}</span>
            </div>
            <div>
              <span className="font-medium">{t('tooltip_accounts')} </span>
              {t(`def_${def.id}_accounts`)}
            </div>
            {hasOverride && (
              <div className="text-primary">
                <span className="font-medium">{t('tooltip_overrides')} </span>
                <span className="font-mono">
                  {prefs.accountOverrides[def.id].join(', ')}
                </span>
              </div>
            )}
          </div>
        )

        return (
          <Card key={def.id}>
            <CardContent className="p-4">
              <InfoTooltip
                content={tooltipContent}
                side="top"
                maxWidth="320px"
                iconClassName="h-3 w-3"
              >
                <p className="text-xs text-muted-foreground">{t(`def_${def.id}_label`)}</p>
              </InfoTooltip>
              <p
                className={`font-display text-2xl tabular-nums tracking-tight mt-2 ${color}`}
              >
                {formatted}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {sub.key ? t(sub.key, sub.args) : ''}
              </p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
