'use client'

import { useEffect, useRef, useState } from 'react'
import posthog from 'posthog-js'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { XMarkIcon } from '@/components/icons'
import { DISCORD_INVITE_URL, DiscordLogo } from '@/components/community/discord'
import { isAnalyticsActive } from '@/lib/analytics/client'
import { persistUiState } from '@/lib/ui-state/client'

// The card's height plus its bottom gap (measured 148px with the Swedish copy
// at sidebar width), with room for one more line of body text in English.
// The card sits in the sidebar's flow, so showing it shrinks the menu above by
// this much; it only appears when the menu has at least this much empty space
// below its last item, so it never pushes the menu into a scroll.
const REQUIRED_FREE_PX = 170

type DiscordInviteEvent = 'discord_invite_shown' | 'discord_invite_joined' | 'discord_invite_dismissed'

function track(event: DiscordInviteEvent): void {
  if (!isAnalyticsActive()) return
  try {
    posthog.capture(event)
  } catch {
    // Telemetry must never affect the page.
  }
}

// Empty space between the sidebar menu's last item and its bottom edge. The
// sidebar is display:none under md, so on a phone this measures zero and the
// card stays hidden there.
function freeSpaceBelowMenu(anchor: HTMLElement | null): number {
  const nav = anchor?.closest('aside')?.querySelector('nav')
  const last = nav?.lastElementChild
  if (!nav || !last) return 0
  const paddingBottom = Number.parseFloat(getComputedStyle(nav).paddingBottom) || 0
  return nav.getBoundingClientRect().bottom - paddingBottom - last.getBoundingClientRect().bottom
}

/**
 * One-time, dismissable invite to Accounted's Discord, at the bottom of the
 * sidebar right above the user menu, where the permanent Discord link lives.
 * In the sidebar's flow, so it never covers the page; never modal. Closing it
 * and joining both count as done and persist in ui_state, so it shows once
 * per user. Eligibility (account age, hosted app only, not dismissed) is
 * decided server-side by shouldOfferDiscordInvite in the dashboard layout.
 */
export function DiscordInviteCard() {
  const t = useTranslations('discord_invite')
  const anchorRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  // Shows as soon as the sidebar has laid out: the free-space check needs the
  // menu's real height, so it runs on the first frame after mount.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (freeSpaceBelowMenu(anchorRef.current) < REQUIRED_FREE_PX) return
      setVisible(true)
      track('discord_invite_shown')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const finish = (event: DiscordInviteEvent) => {
    setVisible(false)
    persistUiState({ discord_invite_dismissed_at: new Date().toISOString() })
    track(event)
  }

  return (
    <div ref={anchorRef} className="flex-shrink-0 px-3">
      {visible && (
        <section
          aria-labelledby="discord-invite-title"
          className="relative mb-2 rounded-lg border border-border bg-background p-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-emphasized"
        >
          {/* The close button sits in the corner over the padding, and the
              title keeps clear of it with pr-6, so the title fits one line
              at sidebar width. The Discord mark lives on the join button. */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('close')}
            onClick={() => finish('discord_invite_dismissed')}
            className="absolute right-1 top-1 text-muted-foreground"
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </Button>
          <p id="discord-invite-title" className="pr-6 text-[13px] font-medium text-foreground">
            {t('title')}
          </p>
          <p className="mt-1 text-[12.5px] leading-[18px] text-muted-foreground">{t('body')}</p>
          <Button asChild size="sm" className="mt-3 w-full gap-2">
            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => finish('discord_invite_joined')}
            >
              <DiscordLogo className="h-4 w-4" />
              {t('join')}
            </a>
          </Button>
        </section>
      )}
    </div>
  )
}

export default DiscordInviteCard
