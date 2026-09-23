import { cn } from '@/lib/utils'

export interface ImportStat {
  /** Stable key; labels can be nodes (e.g. a label with a "?"). */
  key: string
  label: React.ReactNode
  value: React.ReactNode
  /** Quiet line under the value, for the exception only (skipped rows). */
  note?: React.ReactNode
  /** Text values (a date range) read at body size, not as a headline number. */
  plain?: boolean
}

/**
 * Flat stat row for the import wizards' preview steps: label/number pairs on
 * whitespace, no boxes or icons, wrapping on narrow viewports. Same recipe as
 * the salary run's summary row (components/salary/run/RunKpiCards.tsx).
 */
export function ImportStatRow({ stats }: { stats: ImportStat[] }) {
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-4">
      {stats.map((stat) => (
        <div key={stat.key} className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            {stat.label}
          </div>
          <div
            className={cn(
              'mt-1 tabular-nums',
              stat.plain ? 'text-sm font-medium' : 'font-display text-xl leading-none',
            )}
          >
            {stat.value}
          </div>
          {stat.note ? <p className="mt-1 text-xs text-muted-foreground">{stat.note}</p> : null}
        </div>
      ))}
    </div>
  )
}
