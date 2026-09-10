'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { cn } from '@/lib/utils'
import { groupNotices, sortNotices, type ImportNotice } from '@/lib/import/notices'

interface ImportNoticesProps {
  notices: readonly ImportNotice[]
  className?: string
}

/**
 * The one way an import talks about what it noticed (design convention 6:
 * attention is one ochre sentence, max one per page).
 *
 * - The first `action` is the ochre sentence.
 * - Every other action and every `notice` folds behind a muted
 *   "Visa N anmärkningar" toggle.
 * - `info` lives in a tooltip on a small info button: what happened, with
 *   nothing to do about it.
 *
 * Renders nothing when there is nothing to say.
 */
export function ImportNotices({ notices, className }: ImportNoticesProps) {
  const t = useTranslations('import_notices')
  const [open, setOpen] = useState(false)

  const groups = groupNotices(sortNotices(notices))
  const primary = groups.actions[0] ?? null
  const folded = [...groups.actions.slice(1), ...groups.notices]
  const infos = groups.infos

  if (!primary && folded.length === 0 && infos.length === 0) return null

  const render = (n: ImportNotice): string => {
    if (t.has(n.code)) return t(n.code, n.params)
    const text = n.params?.text ?? n.params?.message
    return typeof text === 'string' ? text : n.code
  }

  const infoButton = infos.length > 0 && (
    <InfoTooltip
      side="bottom"
      align="start"
      maxWidth="360px"
      content={
        <ul className="space-y-1">
          {infos.map((n, i) => (
            <li key={i}>{render(n)}</li>
          ))}
        </ul>
      }
    >
      <span className="text-[12.5px] leading-5 text-muted-foreground">{t('info_label')}</span>
    </InfoTooltip>
  )

  return (
    <div className={cn('space-y-1', className)} data-testid="import-notices">
      {primary && <AttnLine>{render(primary)}</AttnLine>}
      {(folded.length > 0 || infos.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {folded.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="text-[12.5px] leading-5 text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
            >
              {open ? t('hide_folded') : t('show_folded', { count: folded.length })}
            </button>
          )}
          {infoButton}
        </div>
      )}
      {open && folded.length > 0 && (
        <ul className="space-y-1 border-l border-border pl-3">
          {folded.map((n, i) => (
            <li
              key={i}
              className={cn(
                'text-[12.5px] leading-5',
                n.severity === 'action' ? 'text-attn' : 'text-muted-foreground'
              )}
            >
              {render(n)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
