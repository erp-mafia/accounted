'use client'

import { useTranslations } from 'next-intl'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { cn, formatCurrency } from '@/lib/utils'
import { KPI_DEFINITIONS } from '@/lib/reports/kpi-definitions'
import type { KPIReport, KPIPreferences } from '@/types'

/**
 * Nyckeltal as the founder-picked "Berättelsen" layout: the month's result
 * as a serif hero over the trend chart, a hairline metric rail on the right
 * driven by the user's KPI preferences, and the cost story as quiet rows
 * below. Pure presentation: everything derives from the existing KPIReport.
 */

/** Months that actually carry activity; the hero speaks about the last one. */
export function activeMonth(report: KPIReport) {
  const active = report.months.filter(
    (m) => m.income !== 0 || m.expenses !== 0 || m.net !== 0,
  )
  const hero = active[active.length - 1] ?? report.months[report.months.length - 1]
  if (!hero) return null
  const idx = report.months.indexOf(hero)
  const prev = idx > 0 ? report.months[idx - 1] : null
  return { hero, prev }
}

export function KPIStoryHero({ report }: { report: KPIReport }) {
  const t = useTranslations('kpi')
  const months = activeMonth(report)
  if (!months) return null
  const { hero, prev } = months

  let sub: string | null = null
  if (prev && prev.net !== 0) {
    const delta = Math.round(((hero.net - prev.net) / Math.abs(prev.net)) * 100)
    sub = t(delta >= 0 ? 'hero_delta_up' : 'hero_delta_down', {
      delta: Math.abs(delta),
      month: prev.label,
    })
  } else if (prev) {
    sub = t('hero_vs', { month: prev.label, amount: formatCurrency(prev.net) })
  }

  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {t('hero_eyebrow', { month: hero.label })}
      </p>
      <p
        className={cn(
          'mt-1 font-display text-5xl leading-none tracking-tight tabular-nums',
          hero.net < 0 && 'text-destructive',
        )}
      >
        {formatCurrency(hero.net)}
      </p>
      {sub && <p className="mt-3 text-[13px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

/** The right-hand metric rail, ordered and filtered by the user's KPI prefs. */
export function KPIRail({
  report,
  preferences,
}: {
  report: KPIReport
  preferences: KPIPreferences
}) {
  const t = useTranslations('kpi')
  const months = activeMonth(report)

  const orderedIds = preferences.kpiOrder.filter(
    (id) => preferences.visibleKpis.includes(id) && id !== 'netResult',
  )

  const rows = orderedIds
    .map((id) => railRow(id, report, t))
    .filter(Boolean) as RailRow[]

  // The month's income closes the rail: it grounds the hero number.
  if (months) {
    rows.push({
      id: 'income',
      label: t('income_in', { month: months.hero.label }),
      value: formatCurrency(months.hero.income),
      note: t('income_note', { amount: formatCurrency(months.hero.expenses) }),
    })
  }

  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.id}
          className="border-b border-border/60 py-4 last:border-b-0"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {row.tooltip ? (
                <InfoTooltip content={row.tooltip} side="top" iconClassName="h-3 w-3">
                  <span>{row.label}</span>
                </InfoTooltip>
              ) : (
                row.label
              )}
            </span>
          </div>
          <p
            className={cn(
              'mt-2 font-display text-[22px] leading-7 tracking-tight tabular-nums',
              row.destructive && 'text-destructive',
            )}
          >
            {row.value}
          </p>
          {row.note && (
            <p className={cn('mt-1 text-xs text-muted-foreground', row.warn && 'text-attn')}>
              {row.note}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

type RailRow = {
  id: string
  label: string
  value: string
  note?: string
  tooltip?: React.ReactNode
  destructive?: boolean
  warn?: boolean
}

function railRow(
  id: string,
  report: KPIReport,
  t: ReturnType<typeof useTranslations<'kpi'>>,
): RailRow | null {
  const def = KPI_DEFINITIONS.find((d) => d.id === id)
  if (!def) return null
  const tooltip = (
    <div className="space-y-1 text-xs">
      <p>{t(`def_${id}_description`)}</p>
      <p className="font-mono">{t(`def_${id}_formula`)}</p>
    </div>
  )
  switch (id) {
    case 'cashPosition':
      return {
        id,
        label: t('def_cashPosition_label'),
        value: formatCurrency(report.cashPosition),
        note: t('sub_likvida_medel'),
        tooltip,
        destructive: report.cashPosition < 0,
      }
    case 'vatLiability':
      return {
        id,
        label: t('def_vatLiability_label'),
        value: formatCurrency(Math.abs(report.vatLiability)),
        note:
          report.vatLiability > 0
            ? t('sub_att_betala')
            : report.vatLiability < 0
              ? t('sub_att_aterfa')
              : t('sub_jamnt'),
        tooltip,
      }
    case 'outstandingReceivables':
      return {
        id,
        label: t('def_outstandingReceivables_label'),
        value: formatCurrency(report.outstandingReceivables),
        note:
          report.overdueReceivables > 0
            ? t('sub_overdue', { amount: formatCurrency(report.overdueReceivables) })
            : t('sub_utestaende'),
        tooltip,
        warn: report.overdueReceivables > 0,
      }
    case 'grossMargin':
      return report.grossMargin === null
        ? null
        : {
            id,
            label: t('def_grossMargin_label'),
            value: `${report.grossMargin}%`,
            note: t('sub_av_intakter'),
            tooltip,
          }
    case 'expenseRatio':
      return report.expenseRatio === null
        ? null
        : {
            id,
            label: t('def_expenseRatio_label'),
            value: `${report.expenseRatio}%`,
            note: t('sub_av_intakter'),
            tooltip,
          }
    case 'avgPaymentDays':
      return report.avgPaymentDays === null
        ? null
        : {
            id,
            label: t('def_avgPaymentDays_label'),
            value: `${report.avgPaymentDays} ${t('value_days_suffix')}`,
            note: t('sub_snitt'),
            tooltip,
          }
    default:
      return null
  }
}

/** Quiet bar row shared by the two breakdown lists. */
function BreakdownRow({
  label,
  amount,
  max,
  prefix,
}: {
  label: string
  amount: number
  max: number
  prefix?: string
}) {
  const width = max > 0 ? Math.max(3, Math.round((amount / max) * 96)) : 3
  return (
    <div className="flex items-center gap-3 border-b border-border/60 py-3 text-[13px] last:border-b-0">
      {prefix && (
        <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground">{prefix}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className="h-[3px] shrink-0 rounded-full bg-foreground/15"
        style={{ width: `${width}px` }}
        aria-hidden="true"
      />
      <span className="w-28 shrink-0 text-right tabular-nums">{formatCurrency(amount)}</span>
    </div>
  )
}

/** The cost story: expense classes and top suppliers as quiet bar rows. */
export function KPIBreakdown({ report }: { report: KPIReport }) {
  const t = useTranslations('kpi')
  const { class4, class5, class6, class7 } = report.expenseComposition
  const classes = [
    { prefix: '4xxx', label: t('expense_mix_class4'), amount: class4 },
    { prefix: '5xxx', label: t('expense_mix_class5'), amount: class5 },
    { prefix: '6xxx', label: t('expense_mix_class6'), amount: class6 },
    { prefix: '7xxx', label: t('expense_mix_class7'), amount: class7 },
  ].filter((c) => c.amount > 0)
  const classMax = Math.max(...classes.map((c) => c.amount), 0)

  const suppliers = report.topSuppliers.slice(0, 5)
  const supplierMax = Math.max(...suppliers.map((s) => s.total), 0)

  if (classes.length === 0 && suppliers.length === 0) return null

  return (
    <div className="grid items-start gap-x-11 gap-y-8 md:grid-cols-2">
      {classes.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-3 px-1">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('costs_title')}
            </h2>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          {classes.map((c) => (
            <BreakdownRow key={c.prefix} prefix={c.prefix} label={c.label} amount={c.amount} max={classMax} />
          ))}
        </div>
      )}
      {suppliers.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-3 px-1">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('suppliers_title')}
            </h2>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          {suppliers.map((s) => (
            <BreakdownRow key={s.supplier_id} label={s.supplier_name} amount={s.total} max={supplierMax} />
          ))}
        </div>
      )}
    </div>
  )
}
