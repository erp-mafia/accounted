'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

/**
 * Underlag as a flow (UI v2 PR 7): Saknas → Inkommet → Tolkat → Matchat →
 * Bokfört, one flat bar with the number of documents at each step. It is
 * the page's only status picker: each cell is one of the workspace's
 * filters (missing / all / todo / linked / booked). Saknas is the step
 * before arrival, a purchase with no document yet. Inkommet and Tolkat
 * happen without the user. Archiving is what booking does (BFL 7 kap.),
 * not a step of its own, so there is no Arkiverat cell.
 */
export const INBOX_PIPE_STAGES = ['missing', 'incoming', 'parsed', 'matched', 'booked'] as const
export type InboxPipeStage = (typeof INBOX_PIPE_STAGES)[number]

const AUTO: ReadonlySet<InboxPipeStage> = new Set(['incoming', 'parsed'])

export function InboxPipeline({
  counts,
  active,
  onSelect,
}: {
  counts: Record<InboxPipeStage, number>
  active: InboxPipeStage | null
  onSelect: (stage: InboxPipeStage) => void
}) {
  const t = useTranslations('inbox_workspace')
  return (
    <div className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-border" role="tablist" aria-label={t('pipe_aria')}>
      {INBOX_PIPE_STAGES.map((s) => {
        const on = active === s
        return (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={on}
            title={t(`pipe_${s}_help`)}
            onClick={() => onSelect(s)}
            className={cn(
              'flex h-10 min-w-0 flex-1 items-center justify-center gap-2 border-r border-border px-2 text-[12.5px] transition-colors duration-150 last:border-r-0',
              on ? 'bg-secondary text-foreground shadow-[inset_0_-2px_0_hsl(var(--foreground))]' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <span className="truncate">{t(`pipe_${s}`)}</span>
            {AUTO.has(s) && <span className="text-[10.5px] text-muted-foreground">{t('pipe_auto')}</span>}
            <span
              className={cn('font-medium tabular-nums', s === 'missing' && counts[s] > 0 ? 'text-warning' : 'text-foreground')}
              data-ph-mask
            >
              {counts[s] || '–'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
