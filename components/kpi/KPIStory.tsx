'use client'

import { useTranslations } from 'next-intl'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { cn, formatCurrency } from '@/lib/utils'
import type { KPIReport, KPIPreferences } from '@/types'
import { allLabelsFit, compactKr, BAR_LABEL_FONT_PX } from './month-values'

/**
 * Nyckeltal as the founder-picked "Instrumentbrädan" layout: a grid of
 * bordered instrument panes — monthly result bars first, then one pane per
 * visible KPI from the user's preferences — with the cost story as quiet
 * rows below. Pure presentation: everything derives from the existing
 * KPIReport.
 */

const SAGE = 'hsl(155 25% 40%)'

type TFn = (key: string, values?: Record<string, string | number>) => string

/** Shared pane chrome: hairline border, compact metric padding. */
function Pane({
  title,
  annotation,
  tooltip,
  className,
  children,
}: {
  title: string
  annotation?: React.ReactNode
  tooltip?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const label = (
    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {title}
    </p>
  )
  return (
    <div className={cn('rounded-lg border border-border p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        {tooltip ? (
          <InfoTooltip content={tooltip} side="top" iconClassName="h-3 w-3">
            {label}
          </InfoTooltip>
        ) : (
          label
        )}
        {annotation && (
          <span className="text-[11px] text-muted-foreground">{annotation}</span>
        )}
      </div>
      {children}
    </div>
  )
}

/** Monthly net result as plain SVG bars: muted months, the latest in sage
 *  (terracotta when negative). Every non-zero bar carries a compact value
 *  label when they fit side by side, otherwise only the latest does; the
 *  exact amounts always follow in a two-column list under the axis. */
function ResultBarsPane({ report }: { report: KPIReport }) {
  const t = useTranslations('kpi')
  const months = report.months
  if (months.length === 0) return null

  const lastActive = (() => {
    for (let i = months.length - 1; i >= 0; i--) {
      const m = months[i]
      if (m.income !== 0 || m.expenses !== 0 || m.net !== 0) return i
    }
    return months.length - 1
  })()

  const W = 320
  const H = 120
  const hasNegative = months.some((m) => m.net < 0)
  // Fixed headroom above (and below, when negatives exist) keeps the endpoint
  // label inside the viewBox even when a single month dominates the scale.
  const topPad = 16
  const bottomPad = hasNegative ? 16 : 4
  const maxPos = Math.max(...months.map((m) => Math.max(0, m.net)), 0)
  const maxNeg = Math.max(...months.map((m) => Math.max(0, -m.net)), 0)
  // One px-per-krona scale for both signs, so bar heights stay comparable.
  const pxPerKr = (H - topPad - bottomPad) / Math.max(maxPos + maxNeg, 1)
  // All-zero months keep the baseline at the bottom instead of the top.
  const baseline = maxPos + maxNeg === 0 ? H - bottomPad : topPad + maxPos * pxPerKr
  const slot = W / months.length
  const barW = Math.min(30, slot * 0.62)
  const labels = months.map((m) => (m.net === 0 ? '' : compactKr(m.net)))
  const labelAll = allLabelsFit(labels, slot)
  // Exact amounts as two columns of the year's months, read top to bottom.
  const half = Math.ceil(months.length / 2)
  const columns = [months.slice(0, half), months.slice(half)]

  return (
    <Pane title={t('bars_title')} annotation={t('bars_unit')}>
      <svg
        viewBox={`0 0 ${W} ${H + 8}`}
        className="mt-3 h-auto w-full"
        role="img"
        aria-label={t('bars_aria', {
          month: months[lastActive].label,
          amount: formatCurrency(months[lastActive].net),
        })}
      >
        {months.map((m, i) => {
          const scaled = Math.abs(m.net) * pxPerKr
          const h = m.net === 0 ? 2 : Math.max(3, scaled)
          const x = i * slot + (slot - barW) / 2
          const y = m.net >= 0 ? baseline - h : baseline
          const isLast = i === lastActive
          const fill =
            m.net < 0
              ? isLast
                ? 'hsl(11 45% 52%)'
                : 'hsl(11 45% 52% / 0.35)'
              : isLast
                ? SAGE
                : 'hsl(var(--foreground) / 0.14)'
          return (
            <g key={m.label}>
              <rect x={x} y={y} width={barW} height={h} rx={3} fill={fill}>
                <title>{`${m.label}: ${formatCurrency(m.net)}`}</title>
              </rect>
              {(isLast || (labelAll && labels[i] !== '')) && (
                <text
                  x={x + barW / 2}
                  y={m.net >= 0 ? y - 5 : y + h + 11}
                  textAnchor="middle"
                  style={{
                    font: `${isLast ? 10.5 : BAR_LABEL_FONT_PX}px var(--font-body, ui-sans-serif)`,
                    fill: 'hsl(var(--muted-foreground))',
                  }}
                >
                  {labels[i] || compactKr(m.net)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex justify-between px-1 text-[10.5px] text-muted-foreground">
        {months.map((m) => (
          <span key={m.label}>{m.label}</span>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 border-t border-border pt-3 text-xs">
        {columns.map((column, c) => (
          <dl key={c} className="space-y-1">
            {column.map((m, j) => {
              const upcoming = c * half + j > lastActive
              return (
                <div key={m.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{m.label}</dt>
                  <dd
                    className={cn(
                      'tabular-nums',
                      m.net < 0 && 'text-destructive',
                      upcoming && 'text-muted-foreground/60',
                    )}
                  >
                    {formatCurrency(m.net)}
                  </dd>
                </div>
              )
            })}
          </dl>
        ))}
      </div>
    </Pane>
  )
}

type MetricPane = {
  id: string
  title: string
  value: string
  note?: string
  tooltip?: React.ReactNode
  destructive?: boolean
  warn?: boolean
  aging?: { ok: number; overdue: number }
}

/** Days of expenses the cash covers, from the period's daily burn so far. */
function cashRunwayDays(report: KPIReport): number | null {
  if (report.cashPosition <= 0 || report.totalExpenses <= 0) return null
  const start = new Date(report.period.start).getTime()
  const end = Math.min(Date.now(), new Date(report.period.end).getTime())
  const elapsedDays = Math.max(1, Math.round((end - start) / 86_400_000))
  const dailyBurn = report.totalExpenses / elapsedDays
  if (dailyBurn <= 0) return null
  return Math.round(report.cashPosition / dailyBurn)
}

function metricPane(id: string, report: KPIReport, t: TFn): MetricPane | null {
  const tooltip = (
    <div className="space-y-1 text-xs">
      <p>{t(`def_${id}_description`)}</p>
      <p className="font-mono">{t(`def_${id}_formula`)}</p>
    </div>
  )
  switch (id) {
    case 'cashPosition': {
      const days = cashRunwayDays(report)
      return {
        id,
        title: t('def_cashPosition_label'),
        value: formatCurrency(report.cashPosition),
        note:
          days !== null && days < 1000
            ? t('cash_covers_days', { days })
            : t('sub_likvida_medel'),
        tooltip,
        destructive: report.cashPosition < 0,
      }
    }
    case 'vatLiability':
      return {
        id,
        title: t('def_vatLiability_label'),
        value: formatCurrency(Math.abs(report.vatLiability)),
        note:
          report.vatLiability > 0
            ? t('sub_att_betala')
            : report.vatLiability < 0
              ? t('sub_att_aterfa')
              : t('sub_jamnt'),
        tooltip,
      }
    case 'outstandingReceivables': {
      const overdue = report.overdueReceivables
      const ok = Math.max(0, report.outstandingReceivables - overdue)
      return {
        id,
        title: t('def_outstandingReceivables_label'),
        value: formatCurrency(report.outstandingReceivables),
        note:
          overdue > 0
            ? t('sub_overdue', { amount: formatCurrency(overdue) })
            : t('sub_utestaende'),
        tooltip,
        warn: overdue > 0,
        aging:
          report.outstandingReceivables > 0 ? { ok, overdue } : undefined,
      }
    }
    case 'grossMargin':
      return report.grossMargin === null
        ? null
        : {
            id,
            title: t('def_grossMargin_label'),
            value: `${report.grossMargin}%`,
            note: t('sub_av_intakter'),
            tooltip,
          }
    case 'expenseRatio':
      return report.expenseRatio === null
        ? null
        : {
            id,
            title: t('def_expenseRatio_label'),
            value: `${report.expenseRatio}%`,
            note: t('sub_av_intakter'),
            tooltip,
          }
    case 'avgPaymentDays':
      return report.avgPaymentDays === null
        ? null
        : {
            id,
            title: t('def_avgPaymentDays_label'),
            value: `${report.avgPaymentDays} ${t('value_days_suffix')}`,
            note: t('sub_snitt'),
            tooltip,
          }
    default:
      return null
  }
}

/** The instrument grid: result bars + one pane per visible preference KPI. */
export function KPIPanes({
  report,
  preferences,
}: {
  report: KPIReport
  preferences: KPIPreferences
}) {
  const t = useTranslations('kpi')

  const orderedIds = preferences.kpiOrder.filter(
    (id) => preferences.visibleKpis.includes(id) && id !== 'netResult',
  )
  const panes = orderedIds
    .map((id) => metricPane(id, report, t as TFn))
    .filter(Boolean) as MetricPane[]

  const total = (p: MetricPane) => (p.aging ? p.aging.ok + p.aging.overdue : 0)

  return (
    <div className="grid items-stretch gap-4 sm:grid-cols-2">
      <ResultBarsPane report={report} />
      {panes.map((pane) => (
        <Pane key={pane.id} title={pane.title} tooltip={pane.tooltip}>
          <p
            className={cn(
              'mt-2 font-display text-2xl tabular-nums tracking-tight',
              pane.destructive && 'text-destructive',
            )}
          >
            {pane.value}
          </p>
          {pane.aging && total(pane) > 0 && (
            <div
              className="mt-3 flex h-1.5 gap-[2px] overflow-hidden rounded-full"
              role="img"
              aria-label={t('aging_aria', {
                ok: formatCurrency(pane.aging.ok),
                overdue: formatCurrency(pane.aging.overdue),
              })}
            >
              <span
                className="rounded-full bg-[hsl(155_25%_40%_/_0.45)]"
                style={{ width: `${(pane.aging.ok / total(pane)) * 100}%` }}
              />
              <span
                className="rounded-full bg-[hsl(38_65%_52%_/_0.75)]"
                style={{ width: `${(pane.aging.overdue / total(pane)) * 100}%` }}
              />
            </div>
          )}
          {pane.note && (
            <p className={cn('mt-2 text-xs leading-5 text-muted-foreground', pane.warn && 'text-attn')}>
              {pane.note}
            </p>
          )}
        </Pane>
      ))}
    </div>
  )
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

/** The cost story (concept "Största kostnaderna"): the period's largest
 *  expense accounts as quiet bar rows, full width. */
export function KPIBreakdown({ report }: { report: KPIReport }) {
  const t = useTranslations('kpi')
  const accounts = report.topExpenseAccounts ?? []
  if (accounts.length === 0) return null
  const max = Math.max(...accounts.map((a) => a.total), 0)

  return (
    <div>
      <div className="mb-1 flex items-center gap-3 px-1">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
          {t('costs_title')}
        </h2>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      {accounts.map((a) => (
        <BreakdownRow
          key={a.account_number}
          prefix={a.account_number}
          label={a.account_name}
          amount={a.total}
          max={max}
        />
      ))}
    </div>
  )
}
