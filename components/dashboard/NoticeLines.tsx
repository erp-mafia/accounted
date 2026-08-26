'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { useBranding } from '@/lib/branding/brand-context'
import type { Notice, NoticeCategory } from '@/lib/notices/types'

interface NoticeLinesProps {
  /** Active notices in priority order (lib/notices getCompanyNotices). */
  notices: Notice[]
  /**
   * Per-category client-side action overrides: some notices need a handler
   * rather than a link (other_account_hint signs the user out).
   */
  actionOverrides?: Partial<Record<NoticeCategory, () => void>>
}

/**
 * The Hem notice slot: renders ONLY the single highest-priority active
 * notice as one AttnLine (convention 6), with a quiet "+N till" text link
 * expanding the rest inline when more are active. No boxed card, no overlay.
 *
 * Dismiss is optimistic and per user (POST /api/notices/dismiss): a failed
 * write just lets the notice reappear on the next load, which is the safe
 * direction for a health warning.
 */
export default function NoticeLines({ notices, actionOverrides = {} }: NoticeLinesProps) {
  const t = useTranslations('notices')
  // Brand-aware app name for messages that mention the platform (WL-12);
  // identical to the default on unbranded hosts.
  const { appName } = useBranding()
  const [expanded, setExpanded] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set())

  const active = notices.filter((n) => !hiddenIds.has(n.id))
  if (active.length === 0) return null
  const visible = expanded ? active : [active[0]]
  const moreCount = active.length - 1

  function dismiss(notice: Notice) {
    setHiddenIds((prev) => new Set(prev).add(notice.id))
    // Fire-and-forget on purpose: on failure the notice simply returns on
    // the next load. Never block or error the dashboard over a dismissal.
    void fetch('/api/notices/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notice_id: notice.id }),
    }).catch(() => {})
  }

  return (
    <div className="space-y-1">
      {visible.map((notice, index) => {
        const override = actionOverrides[notice.category]
        return (
          <AttnLine
            key={notice.id}
            action={
              override
                ? { label: t(notice.actionKey), onClick: override }
                : { label: t(notice.actionKey), href: notice.actionHref }
            }
            trailing={
              <>
                {index === 0 && !expanded && moreCount > 0 && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => setExpanded(true)}
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      {t('more_count', { count: moreCount })}
                    </button>
                  </>
                )}{' '}
                <button
                  type="button"
                  onClick={() => dismiss(notice)}
                  className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {t('dismiss')}
                </button>
              </>
            }
          >
            {t(notice.messageKey, { appName, ...notice.messageParams })}
          </AttnLine>
        )
      })}
    </div>
  )
}
